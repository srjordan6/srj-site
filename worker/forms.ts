/**
 * Form endpoints. Stage 4 of the architecture package: "forms Worker replaces
 * WPForms".
 *
 * WHAT WAS BROKEN. Every form on the migrated site posted to
 * /wp-admin/admin-ajax.php, which does not exist. They rendered, accepted
 * input, and did nothing. The client upload form is the serious one: it is
 * linked from the footer of every page, carries a PHI warning, and a visitor
 * could fill it in believing the files had been sent.
 *
 * DEFENCE IN DEPTH, cheapest check first:
 *   1. honeypot     a field real users never see; bots fill it
 *   2. timing       a submission under 3 seconds after render is not a human
 *   3. Turnstile    Cloudflare's challenge, same as production used
 * All three fail CLOSED but return 200 to the caller. A bot learning which
 * check caught it is a bot that routes around it next time.
 *
 * UPLOADS GO TO A PRIVATE BUCKET. srj-uploads, never srj-assets. Client
 * material must not be one URL guess from public. The mail is a notification;
 * the file is fetched from the bucket, not attached.
 */

import { sendMail, MAILBOX } from './gmail';

export interface FormEnv {
  GOOGLE_SA_EMAIL: string;
  GOOGLE_SA_KEY: string;
  TURNSTILE_SECRET: string;
  UPLOADS: R2Bucket;
  /** Beehiiv API key and publication id, for the worksheet gate and the
      footer newsletter form. Set with wrangler secret put / a plain var. */
  BEEHIIV_API_KEY: string;
  BEEHIIV_PUB_ID: string;
  /** HMAC secret for the worksheet-gate confirmation link. Any long random
      string; rotating it invalidates unclicked links, nothing else. */
  GATE_SECRET: string;
}

/** Uniform reply. Never reveals which check rejected a submission. */
const ok = (msg: string) =>
  new Response(JSON.stringify({ ok: true, message: msg }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const fail = (status: number, msg: string) =>
  new Response(JSON.stringify({ ok: false, message: msg }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** Cap what reaches the mail body, so a paste-bomb cannot make an unreadable message. */
const clip = (v: FormDataEntryValue | null, max = 4000): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

/** Deliberately permissive: rejecting valid addresses is worse than accepting junk. */
const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/**
 * The visitor's name, as the forms actually send it.
 *
 * The contact and upload forms carry first_name + last_name fields (the same
 * split production's WPForms used), but the first version of these handlers
 * read a single `name` field that no form sends. Every real submission came
 * back "Please provide your name and a message" with the name sitting right
 * there in first_name (Stephen, July 30, first live submission after
 * cutover). Reads the split fields first and falls back to `name` so any
 * future single-field form also works.
 */
const fullName = (form: FormData): string => {
  const joined = [clip(form.get('first_name'), 100), clip(form.get('last_name'), 100)]
    .filter(Boolean)
    .join(' ');
  return joined || clip(form.get('name'), 200);
};

/**
 * The forms carry an email_confirm field. When present it must match, or the
 * typo the field exists to catch goes uncaught into the reply-to.
 */
const emailMismatch = (form: FormData, email: string): boolean => {
  const confirm = clip(form.get('email_confirm'), 200).toLowerCase();
  return Boolean(confirm) && confirm !== email.toLowerCase();
};

/**
 * Verify a Turnstile token.
 *
 * The error codes are logged. Cloudflare tells you precisely why a token was
 * rejected and an earlier version threw that away, leaving "Verification
 * failed" as the only signal, which is not enough to act on. The ones that
 * matter here:
 *
 *   invalid-input-secret    TURNSTILE_SECRET is not a secret key. Most likely
 *                           the SITE key was pasted into it: both start 0x4AAA
 *                           and they are easy to confuse.
 *   invalid-input-response  the token is malformed, already used, or expired.
 *                           Tokens are single-use, so a resubmitted form fails
 *                           unless the widget is reset.
 *   timeout-or-duplicate    same token twice.
 *   hostname-mismatch       the page's hostname is not on the widget's allowed
 *                           list. Expect this on srj-site.srjordan.workers.dev
 *                           if only srjconsultingservices.com was added.
 */
async function turnstileOk(secret: string, token: string, ip: string | null): Promise<boolean> {
  if (!secret) {
    console.log('turnstile: TURNSTILE_SECRET not set, skipping (honeypot and timing still apply)');
    return true;
  }
  if (!token) {
    console.log('turnstile: no token in submission (widget did not render, or JS blocked)');
    return false;
  }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip ?? undefined }),
    });
    const j: any = await res.json();
    if (j.success !== true) {
      console.log(
        `turnstile: rejected, codes=${JSON.stringify(j['error-codes'] ?? [])}` +
        ` hostname=${j.hostname ?? '(none)'}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.log('turnstile: siteverify unreachable', err);
    return false; // fail closed
  }
}

/**
 * Shared gate. Returns null when the submission should proceed, or the response
 * to send when it should not.
 *
 * EVERY REJECTION IS LOGGED. The visitor-facing response for a honeypot or
 * timing failure is a normal success message, deliberately, so a bot cannot
 * learn which check caught it. The cost is that a real person who trips a gate
 * sees "thank you" and no mail arrives, and from the outside that is
 * indistinguishable from a broken mail path. It cost an evening of guessing.
 * `wrangler tail` now names the gate.
 */
async function gate(form: FormData, env: FormEnv, request: Request): Promise<Response | null> {
  const where = new URL(request.url).pathname;

  // 1. honeypot
  //
  // The field is named decoy_note rather than anything resembling a real field.
  // An earlier version called it company_website, which is exactly the sort of
  // name a browser or password manager will autofill for a human, silently
  // turning a real enquiry into a discarded one.
  const trap = clip(form.get('decoy_note')) || clip(form.get('company_website'));
  if (trap) {
    console.log(`gate: honeypot filled on ${where}, value=${JSON.stringify(trap.slice(0, 40))}`);
    return ok('Thank you. Your message has been received.');
  }

  // 2. Elapsed time since the form rendered.
  //
  // The form sends ELAPSED MILLISECONDS, not a timestamp. An earlier version
  // sent Date.now() from the browser and compared it against Date.now() on the
  // edge, which is a comparison between two unsynchronised clocks. A visitor
  // whose machine runs a few seconds ahead produces a tiny or negative
  // difference, trips this gate, and is told "Thank you. Your message has been
  // received" while nothing is sent. The visitor cannot tell, and neither could
  // I: it looks exactly like a broken mail path.
  //
  // A delta is measured entirely in the browser, so no clock comparison happens
  // and skew cannot fire it. form_started is still accepted for anything cached
  // mid-deploy, but only when it looks like a plausible elapsed value rather
  // than an epoch timestamp.
  const elapsedRaw = clip(form.get('form_elapsed'));
  let elapsed = Number(elapsedRaw);
  if (!elapsedRaw) {
    const legacy = Number(clip(form.get('form_started')));
    // An epoch timestamp is ~1.7e12. Anything that large is not an elapsed
    // reading, so the old field is only trusted when it clearly is one.
    elapsed = legacy > 0 && legacy < 1e11 ? legacy : NaN;
  }
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 3000) {
    console.log(`gate: too fast on ${where}, ${elapsed}ms after render`);
    return ok('Thank you. Your message has been received.');
  }
  if (!Number.isFinite(elapsed)) {
    console.log(`gate: no usable timing value on ${where}, allowing through`);
  }

  // 3. Turnstile
  const passed = await turnstileOk(
    env.TURNSTILE_SECRET,
    clip(form.get('cf-turnstile-response')),
    request.headers.get('cf-connecting-ip'),
  );
  if (!passed) {
    console.log(`gate: turnstile failed on ${where}`);
    return fail(400, 'Verification failed. Please refresh and try again.');
  }

  console.log(`gate: passed on ${where}`);
  return null;
}

/** POST /api/contact */
export async function handleContact(request: Request, env: FormEnv): Promise<Response> {
  const form = await request.formData();
  const blocked = await gate(form, env, request);
  if (blocked) return blocked;

  const name = fullName(form);
  const email = clip(form.get('email'), 200);
  const company = clip(form.get('company'), 200);
  const phone = clip(form.get('phone'), 60);
  const message = clip(form.get('message'), 8000);

  // Consent answers are recorded, not merely collected. The SMS checkbox exists
  // to satisfy A2P 10DLC for Zoom Phone registration, and a consent nobody can
  // evidence afterwards is not consent. Both land in the notification.
  const emailConsent = clip(form.get('email_consent')) ? 'yes' : 'no';
  const smsConsent = clip(form.get('sms_consent')) ? 'yes' : 'no';

  if (!name || !message) return fail(400, 'Please provide your name and a message.');
  if (!looksLikeEmail(email)) return fail(400, 'Please provide a valid email address.');
  if (emailMismatch(form, email)) return fail(400, 'The email addresses do not match.');

  const body = [
    'New contact form submission',
    '',
    `Name:    ${name}`,
    `Email:   ${email}`,
    company ? `Company: ${company}` : '',
    phone ? `Phone:   ${phone}` : '',
    '',
    `Email consent: ${emailConsent}`,
    `SMS consent:   ${smsConsent}`,
    '',
    'Message:',
    message,
    '',
    '---',
    `Received ${new Date().toISOString()}`,
    `From ${request.headers.get('cf-connecting-ip') ?? 'unknown IP'}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  try {
    await sendMail(env, { subject: `Contact form: ${name}`, text: body, replyTo: email });
    console.log(`contact: sent, from=${email}`);
  } catch (err) {
    // The visitor is not shown the cause. A failed send must be loud in logs,
    // because a silently dropped enquiry is the failure this endpoint exists
    // to end.
    console.error('contact send failed', err);
    return fail(500, 'Something went wrong sending your message. Please email ' + MAILBOX + ' directly.');
  }
  return ok('Thank you. Your message has been received and will be answered within one business day.');
}

/**
 * POST /api/upload
 *
 * Files land in the private srj-uploads bucket under a dated, randomised key.
 * The notification names them; it does not carry them.
 */
export async function handleUpload(request: Request, env: FormEnv): Promise<Response> {
  const form = await request.formData();
  const blocked = await gate(form, env, request);
  if (blocked) return blocked;

  const name = fullName(form);
  const email = clip(form.get('email'), 200);
  const company = clip(form.get('company'), 200);
  const reference = clip(form.get('reference'), 200);
  const note = clip(form.get('note'), 4000);

  // The page carries a PHI notice and the submitter attests the files are
  // clear of it. Record the attestation with the submission; an unrecorded one
  // is worth nothing later.
  const phiAttested = clip(form.get('phi_attested')) ? 'yes' : 'no';

  if (!name || !company) return fail(400, 'Please provide your name and organisation.');
  if (phiAttested !== 'yes') {
    return fail(400, 'Please confirm the files contain no PHI or regulated health information.');
  }
  if (!looksLikeEmail(email)) return fail(400, 'Please provide a valid email address.');
  if (emailMismatch(form, email)) return fail(400, 'The email addresses do not match.');

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return fail(400, 'Please choose at least one file to upload.');

  const MAX = 100 * 1024 * 1024; // per file
  const oversized = files.find((f) => f.size > MAX);
  if (oversized) {
    return fail(400, `"${oversized.name}" is larger than the 100 MB limit for this form.`);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const batch = crypto.randomUUID();
  const stored: string[] = [];

  try {
    for (const file of files) {
      // Key is dated and randomised. The filename is preserved for the
      // recipient but never trusted as a path: slashes would otherwise let a
      // caller choose where in the bucket the object lands.
      const safe = file.name.replace(/[\/\\]/g, '_').slice(0, 180);
      const key = `${stamp}/${batch}/${safe}`;
      await env.UPLOADS.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: {
          submittedBy: email,
          organisation: company,
          reference,
          phiAttested,
          receivedAt: new Date().toISOString(),
        },
      });
      stored.push(`${key}  (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  } catch (err) {
    console.error('upload store failed', err);
    return fail(500, 'Your files could not be stored. Please contact ' + MAILBOX + '.');
  }

  const body = [
    'New client file upload',
    '',
    `Name:         ${name}`,
    `Email:        ${email}`,
    `Organisation: ${company}`,
    reference ? `Reference:    ${reference}` : '',
    `PHI attestation: confirmed (no PHI or regulated health information)`,
    '',
    `Files (${files.length}), in the srj-uploads bucket:`,
    ...stored.map((s) => `  ${s}`),
    '',
    note ? `Note:\n${note}\n` : '',
    '---',
    `Received ${new Date().toISOString()}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  try {
    await sendMail(env, {
      subject: `Client upload: ${company} (${files.length} file${files.length > 1 ? 's' : ''})`,
      text: body,
      replyTo: email,
    });
  } catch (err) {
    // The files are already safe. Report success to the client and shout in the
    // logs: losing the notification is recoverable, telling them the upload
    // failed when it did not is worse, because they will send it again.
    console.error('upload notification failed, files ARE stored', err);
  }

  return ok('Thank you. Your files have been received. We will confirm by email within one business day.');
}


/* ==========================================================================
 * Worksheet download gate + newsletter signup.
 *
 * THE GATE'S CONTRACT, carried over from WordPress exactly:
 *   - The panel copy promises "enter your email once ... unlock across the
 *     site, forever." The cookie is srj_worksheet_access=1, the SAME name
 *     WordPress sets, so every visitor already unlocked on production stays
 *     unlocked after cutover without being asked again.
 *   - No unlock on submit. The cookie is set only by the signed confirmation
 *     link emailed to the subscriber, same as production's
 *     inc/beehiiv-integration.php behaviour.
 *   - Once confirmed, that address is never contacted again from this form.
 *     The only email this path ever sends is the one confirmation the visitor
 *     explicitly requested.
 *
 * Beehiiv's own double opt-in is overridden OFF for the gate subscription so
 * exactly one email goes out: ours, carrying the signed link. The newsletter
 * endpoint does NOT override it: there Beehiiv's confirmation IS the flow, and
 * the /welcome/ page tells the subscriber to whitelist the sender.
 * ========================================================================== */

const COOKIE_NAME = 'srj_worksheet_access';
/** Ten years. "Forever" as far as a cookie can promise it. */
const COOKIE_MAX_AGE = 315360000;
/** Confirmation links stay valid for 30 days; resubmitting mints a new one. */
const LINK_TTL_SECONDS = 30 * 24 * 3600;

const hmacKey = (secret: string) =>
  crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function signGate(secret: string, email: string, exp: number): Promise<string> {
  const key = await hmacKey(secret);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${email}.${exp}`)));
}

/** Constant-time-ish compare; both sides are fixed-length hex of our own making. */
function sigEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const b64uText = (t: string) =>
  btoa(unescape(encodeURIComponent(t))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64uText = (t: string) =>
  decodeURIComponent(escape(atob(t.replace(/-/g, '+').replace(/_/g, '/'))));

/**
 * Subscribe an address to the Beehiiv publication.
 *
 * A failure here is logged and swallowed by the gate path: the visitor asked
 * for the worksheets, and a CRM hiccup is not a reason to refuse them. The
 * newsletter path treats failure as failure, because there the subscription
 * IS the product.
 */
async function beehiivSubscribe(
  env: FormEnv,
  email: string,
  utmSource: string,
  doubleOptOverride: 'on' | 'off' | null,
  suppressWelcome: boolean,
): Promise<boolean> {
  if (!env.BEEHIIV_API_KEY || !env.BEEHIIV_PUB_ID) {
    console.log('beehiiv: BEEHIIV_API_KEY or BEEHIIV_PUB_ID not set, skipping subscribe');
    return false;
  }
  try {
    const body: Record<string, unknown> = {
      email,
      reactivate_existing: true,
      utm_source: utmSource,
      referring_site: 'https://srjconsultingservices.com',
    };
    // The gate's one outbound email is ours, so Beehiiv's welcome is suppressed
    // there. The newsletter path leaves it to the publication's own setting.
    if (suppressWelcome) body.send_welcome_email = false;
    if (doubleOptOverride) body.double_opt_override = doubleOptOverride;
    const res = await fetch(
      `https://api.beehiiv.com/v2/publications/${env.BEEHIIV_PUB_ID}/subscriptions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.BEEHIIV_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      console.log(`beehiiv: subscribe ${res.status} for ${utmSource}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.log('beehiiv: unreachable', err);
    return false;
  }
}

/**
 * POST /api/worksheet-access
 *
 * Fields: first_name (optional), email, decoy_note, form_elapsed,
 * cf-turnstile-response, book (display title for the email), return (path to
 * come back to after confirming).
 */
export async function handleWorksheetAccess(request: Request, env: FormEnv): Promise<Response> {
  const form = await request.formData();
  const blocked = await gate(form, env, request);
  if (blocked) return blocked;

  const email = clip(form.get('email'), 200).toLowerCase();
  const firstName = clip(form.get('first_name'), 100);
  const book = clip(form.get('book'), 200) || 'this book';
  if (!looksLikeEmail(email)) return fail(400, 'Please provide a valid email address.');

  if (!env.GATE_SECRET) {
    console.error('worksheet: GATE_SECRET not set, cannot mint confirmation links');
    return fail(500, 'The download service is temporarily unavailable. Please email ' + MAILBOX + '.');
  }

  // Return path: same-origin paths only. Anything else collapses to /books/.
  let ret = clip(form.get('return'), 300);
  if (!ret.startsWith('/') || ret.startsWith('//') || ret.includes('://')) ret = '/books/';

  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const sig = await signGate(env.GATE_SECRET, email, exp);
  const origin = new URL(request.url).origin;
  const link =
    `${origin}/api/worksheet-confirm?e=${b64uText(email)}&x=${exp}` +
    `&s=${sig}&r=${encodeURIComponent(ret)}`;

  // CRM first, best-effort. Double opt-in overridden off: exactly one email
  // goes to the visitor, and it is ours below.
  await beehiivSubscribe(env, email, 'worksheet-gate', 'off', true);

  const text = [
    firstName ? `${firstName},` : 'Hello,',
    '',
    "One click and every book's worksheets and templates on srjconsultingservices.com unlock for you, permanently.",
    '',
    'Unlock the downloads:',
    link,
    '',
    `You requested this on the ${book} page. If you didn't, ignore this email and nothing happens. You won't hear from this form again.`,
    '',
    'SRJ Consulting & Services LLC',
    'srjconsultingservices.com',
  ].join('\n');

  try {
    await sendMail(env, {
      to: email,
      fromName: 'SRJ Consulting & Services',
      subject: 'Confirm your email to unlock the worksheets',
      text,
    });
    console.log(`worksheet: confirmation sent to ${email} for ${book}`);
  } catch (err) {
    console.error('worksheet confirmation send failed', err);
    return fail(500, 'The confirmation email could not be sent. Please email ' + MAILBOX + '.');
  }

  return ok('Check your inbox: click the confirmation link we just sent and the downloads unlock, permanently.');
}

/**
 * GET /api/worksheet-confirm
 *
 * The signed link from the email. Verifies, sets the ten-year cookie, and
 * returns the visitor to the book page they came from.
 */
export async function handleWorksheetConfirm(request: Request, env: FormEnv): Promise<Response> {
  const url = new URL(request.url);
  const e = url.searchParams.get('e') ?? '';
  const x = Number(url.searchParams.get('x') ?? '');
  const s = url.searchParams.get('s') ?? '';
  let r = url.searchParams.get('r') ?? '/books/';
  if (!r.startsWith('/') || r.startsWith('//') || r.includes('://')) r = '/books/';

  const plain = (msg: string, status: number) =>
    new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  if (!env.GATE_SECRET) return plain('Service unavailable.', 500);
  if (!e || !s || !Number.isFinite(x)) return plain('This link is incomplete. Please use the link from the email.', 400);
  if (x < Math.floor(Date.now() / 1000)) {
    return plain('This link has expired. Submit the form on any book page and a fresh one will be sent.', 400);
  }

  let email = '';
  try { email = unb64uText(e); } catch { return plain('This link is malformed.', 400); }

  const expect = await signGate(env.GATE_SECRET, email, x);
  if (!sigEqual(expect, s)) {
    console.log('worksheet: bad signature on confirm');
    return plain('This link could not be verified. Please use the exact link from the email.', 400);
  }

  console.log(`worksheet: confirmed ${email}`);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${r}${r.includes('?') ? '&' : '?'}unlocked=1`,
      'set-cookie':
        `${COOKIE_NAME}=1; Max-Age=${COOKIE_MAX_AGE}; Path=/; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  });
}

/**
 * POST /api/newsletter
 *
 * The footer signup on every page. Honeypot and timing apply; Turnstile does
 * NOT: putting a widget in the footer of 300 static pages is a page-weight tax
 * on every visitor, and Beehiiv's own double opt-in already means a junk
 * address that never confirms costs nothing. The subscription here is created
 * WITHOUT overriding double opt-in, so Beehiiv sends its confirmation and the
 * client redirects to /welcome/, which tells the subscriber to whitelist the
 * sender. Same flow WordPress ran.
 */
export async function handleNewsletter(request: Request, env: FormEnv): Promise<Response> {
  const form = await request.formData();

  const where = '/api/newsletter';
  const trap = clip(form.get('decoy_note'));
  if (trap) {
    console.log(`gate: honeypot filled on ${where}`);
    return ok('Thank you. Check your inbox to confirm your subscription.');
  }
  const elapsed = Number(clip(form.get('form_elapsed')));
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 2000) {
    console.log(`gate: too fast on ${where}, ${elapsed}ms`);
    return ok('Thank you. Check your inbox to confirm your subscription.');
  }

  const email = clip(form.get('email'), 200).toLowerCase();
  if (!looksLikeEmail(email)) return fail(400, 'Please provide a valid email address.');

  const subscribed = await beehiivSubscribe(env, email, 'website-footer', null, false);
  if (!subscribed) {
    return fail(500, 'The signup service is temporarily unavailable. Please try again shortly.');
  }
  console.log(`newsletter: subscribed ${email}`);
  return ok('Almost there: check your inbox and confirm your subscription.');
}
