#!/usr/bin/env python3
"""SRJ intel sync: keeps the AI Lawsuit Database and AI intel feeds current.

Runs daily on Render cron. Four jobs, each independent, all failures logged:
  1. refresh   - poll CourtListener for every tracked case, update timelines and
                 latest developments when the docket has moved
  2. resolve   - fill in docket numbers still marked pending verification
  3. discover  - search CourtListener for newly filed AI lawsuits, queue as candidates
  4. ai_watch  - watch Hugging Face and vendor news feeds for new models, tools,
                 terminology; queue as candidates

Environment:
  DATABASE_URL          required, SRJ Postgres connection string
  COURTLISTENER_TOKEN   optional, raises rate limits when present
Review queues: ai_lawsuit_candidates, ai_intel_candidates (status new/promoted/ignored).
Run log: srj_intel_log.
"""
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

import psycopg
import requests

CL_API = "https://www.courtlistener.com/api/rest/v4"
UA = {"User-Agent": "SRJ-Consulting-intel-sync/1.0 (srjconsultingservices.com)"}
if os.environ.get("COURTLISTENER_TOKEN"):
    UA["Authorization"] = "Token " + os.environ["COURTLISTENER_TOKEN"]

VENDOR_FEEDS = [
    ("OpenAI", "https://openai.com/news/rss.xml"),
    ("Google DeepMind", "https://deepmind.google/blog/rss.xml"),
    ("Hugging Face", "https://huggingface.co/blog/feed.xml"),
]

AI_TERMS = re.compile(
    r"artificial intelligence|generative ai|\bai\b|llm|large language model|"
    r"machine learning|neural|diffusion|training data|chatbot|copilot",
    re.I,
)


def cl_get(path, params=None, tries=3):
    for attempt in range(tries):
        r = requests.get(CL_API + path, params=params, headers=UA, timeout=30)
        if r.status_code == 429:
            time.sleep(15 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"CourtListener rate limited: {path}")


def docket_id_from_url(url):
    m = re.search(r"/docket/(\d+)/", url or "")
    return m.group(1) if m else None


def job_refresh(cur):
    """Update timeline + latest development for tracked cases whose docket moved."""
    checked = updated = 0
    cur.execute(
        "SELECT id, slug, courtlistener_url, latest_development_date, timeline "
        "FROM ai_lawsuits WHERE is_active AND courtlistener_url IS NOT NULL"
    )
    for row_id, slug, cl_url, latest_date, timeline in cur.fetchall():
        did = docket_id_from_url(cl_url)
        if not did:
            continue
        checked += 1
        try:
            docket = cl_get(f"/dockets/{did}/")
        except Exception as e:
            print(f"refresh {slug}: docket fetch failed: {e}", file=sys.stderr)
            continue
        last_filing = docket.get("date_last_filing")
        if not last_filing or (latest_date and last_filing <= str(latest_date)):
            time.sleep(2)
            continue
        try:
            entries = cl_get(
                "/docket-entries/",
                {"docket": did, "order_by": "-date_filed", "page_size": 5},
            ).get("results", [])
        except Exception as e:
            print(f"refresh {slug}: entries fetch failed: {e}", file=sys.stderr)
            continue
        existing = timeline or []
        seen = {(e.get("date"), e.get("doc_no")) for e in existing}
        fresh = []
        for en in entries:
            d = en.get("date_filed")
            doc_no = str(en.get("entry_number") or "")
            desc = (en.get("description") or "").strip()
            if not d or (d, doc_no) in seen or not desc:
                continue
            fresh.append(
                {
                    "date": d,
                    "title": desc[:300],
                    "doc_no": doc_no,
                    "url": f"https://www.courtlistener.com/docket/{did}/?page=1",
                }
            )
        if fresh:
            merged = sorted(fresh + existing, key=lambda e: e["date"], reverse=True)
            newest = fresh[0]
            cur.execute(
                "UPDATE ai_lawsuits SET timeline=%s, latest_development=%s, "
                "latest_development_date=%s, updated_at=now() WHERE id=%s",
                (json.dumps(merged), newest["title"], newest["date"], row_id),
            )
            updated += 1
            print(f"refresh {slug}: {len(fresh)} new docket entries through {newest['date']}")
        time.sleep(2)
    return checked, updated


def job_resolve(cur):
    """Fill docket numbers still marked pending, straight from CourtListener search."""
    resolved = 0
    cur.execute(
        "SELECT id, slug, case_name, defendants FROM ai_lawsuits "
        "WHERE docket ILIKE '%pending%' AND is_active"
    )
    for row_id, slug, case_name, defendants in cur.fetchall():
        q = re.sub(r"\(.*?\)", "", case_name).strip()
        try:
            hits = cl_get(
                "/search/", {"type": "r", "q": f'"{q}"', "order_by": "score desc"}
            ).get("results", [])
        except Exception as e:
            print(f"resolve {slug}: search failed: {e}", file=sys.stderr)
            continue
        surname = (defendants or "").split(";")[0].split(",")[0].strip().lower()
        for h in hits[:5]:
            name = (h.get("caseName") or "").lower()
            docket_no = h.get("docketNumber")
            d_id = h.get("docket_id")
            if docket_no and d_id and surname and surname.split()[0] in name:
                cur.execute(
                    "UPDATE ai_lawsuits SET docket=%s, courtlistener_url=%s, "
                    "updated_at=now() WHERE id=%s",
                    (
                        docket_no,
                        f"https://www.courtlistener.com/docket/{d_id}/",
                        row_id,
                    ),
                )
                resolved += 1
                print(f"resolve {slug}: docket {docket_no} via docket {d_id}")
                break
        time.sleep(2)
    return resolved


def job_discover(cur):
    """Queue newly filed AI lawsuits as candidates for review."""
    added = 0
    since = (date.today() - timedelta(days=45)).isoformat()
    query = (
        '("artificial intelligence" OR "generative AI" OR "large language model") '
        'AND (copyright OR "training data" OR infringement)'
    )
    try:
        hits = cl_get(
            "/search/",
            {"type": "r", "q": query, "filed_after": since, "order_by": "dateFiled desc"},
        ).get("results", [])
    except Exception as e:
        print(f"discover: search failed: {e}", file=sys.stderr)
        return 0
    for h in hits[:25]:
        d_id = h.get("docket_id")
        if not d_id:
            continue
        sid = f"cl-docket-{d_id}"
        cur.execute(
            "SELECT 1 FROM ai_lawsuits WHERE courtlistener_url LIKE %s",
            (f"%/docket/{d_id}/%",),
        )
        if cur.fetchone():
            continue
        cur.execute(
            "INSERT INTO ai_lawsuit_candidates "
            "(source, source_id, case_name, court, docket, filed_date, url, snippet) "
            "VALUES ('courtlistener', %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (source_id) DO NOTHING",
            (
                sid,
                h.get("caseName"),
                h.get("court"),
                h.get("docketNumber"),
                h.get("dateFiled"),
                f"https://www.courtlistener.com/docket/{d_id}/",
                (h.get("snippet") or "")[:500],
            ),
        )
        added += cur.rowcount
    return added


def job_ai_watch(cur):
    """Queue new models (Hugging Face) and AI vendor news as intel candidates."""
    added = 0
    try:
        models = requests.get(
            "https://huggingface.co/api/models",
            params={"sort": "createdAt", "direction": -1, "limit": 25},
            headers=UA,
            timeout=30,
        ).json()
        for m in models:
            mid = m.get("modelId") or m.get("id")
            if not mid or (m.get("downloads") or 0) < 50:
                continue
            cur.execute(
                "INSERT INTO ai_intel_candidates (kind, name, vendor, url, summary, source, source_id) "
                "VALUES ('model', %s, %s, %s, %s, 'huggingface', %s) "
                "ON CONFLICT (source_id) DO NOTHING",
                (
                    mid.split("/")[-1],
                    mid.split("/")[0] if "/" in mid else None,
                    f"https://huggingface.co/{mid}",
                    f"pipeline: {m.get('pipeline_tag') or 'unknown'}, downloads: {m.get('downloads', 0)}",
                    f"hf-{mid}",
                ),
            )
            added += cur.rowcount
    except Exception as e:
        print(f"ai_watch huggingface failed: {e}", file=sys.stderr)
    for vendor, feed in VENDOR_FEEDS:
        try:
            r = requests.get(feed, headers=UA, timeout=30)
            r.raise_for_status()
            root = ET.fromstring(r.content)
            for item in root.iter("item"):
                title = (item.findtext("title") or "").strip()
                link = (item.findtext("link") or "").strip()
                if not title or not link or not AI_TERMS.search(title):
                    continue
                cur.execute(
                    "INSERT INTO ai_intel_candidates (kind, name, vendor, url, source, source_id) "
                    "VALUES ('vendor-news', %s, %s, %s, 'rss', %s) "
                    "ON CONFLICT (source_id) DO NOTHING",
                    (title[:300], vendor, link, f"rss-{link}"),
                )
                added += cur.rowcount
        except Exception as e:
            print(f"ai_watch feed {vendor} failed: {e}", file=sys.stderr)
    return added


def main():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)
    checked = updated = resolved = law_added = intel_added = 0
    ok = True
    detail = []
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            for name, fn in (
                ("refresh", lambda c: job_refresh(c)),
                ("resolve", lambda c: job_resolve(c)),
                ("discover", lambda c: job_discover(c)),
                ("ai_watch", lambda c: job_ai_watch(c)),
            ):
                try:
                    result = fn(cur)
                    if name == "refresh":
                        checked, updated = result
                    elif name == "resolve":
                        resolved = result
                    elif name == "discover":
                        law_added = result
                    else:
                        intel_added = result
                    conn.commit()
                except Exception as e:
                    ok = False
                    detail.append(f"{name}: {e}")
                    conn.rollback()
                    print(f"job {name} failed: {e}", file=sys.stderr)
            cur.execute(
                "INSERT INTO srj_intel_log (job, ok, dockets_checked, dockets_updated, "
                "lawsuit_candidates_added, intel_candidates_added, detail) "
                "VALUES ('daily-sync', %s, %s, %s, %s, %s, %s)",
                (ok, checked, updated, law_added, intel_added, "; ".join(detail) or None),
            )
            conn.commit()
    print(
        f"done: checked={checked} updated={updated} resolved={resolved} "
        f"lawsuit_candidates={law_added} intel_candidates={intel_added} ok={ok}"
    )
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
