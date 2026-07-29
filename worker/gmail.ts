/**
 * Gmail API sending from a Cloudflare Worker, via a service account with
 * domain-wide delegation.
 *
 * WHY THIS AND NOT AN SMTP RELAY OR A THIRD-PARTY SENDER. The domain runs on
 * Google Workspace (MX = aspmx.l.google.com), so mail sent this way leaves from
 * the real mailbox and SPF and DKIM already pass. A third-party sender would
 * need its own domain verification and DNS records. Workers also cannot speak
 * SMTP usefully, so the REST API is the practical path regardless.
 *
 * WHY A SERVICE ACCOUNT AND NOT AN OAUTH REFRESH TOKEN. A refresh token issued
 * while the OAuth app sits in Testing status expires after seven days. That
 * fails silently, a week after anyone last looked at it, which is the worst
 * failure shape available. Service account credentials do not expire.
 *
 * WHY SENDER AND RECIPIENT DIFFER. The first working version sent From: info@
 * To: info@. Google accepted and delivered every message, and every one landed
 * in Sent with no Inbox copy, because Gmail deduplicates a self-addressed
 * message. The mail was arriving and invisible, which for a contact form is
 * indistinguishable from being broken.
 *
 * WHAT THE MAILBOX ACTUALLY IS, established by reading a delivered message
 * rather than assumed. The Workspace user's primary address is
 * srj@srjconsultingservices.com and info@ is an ALIAS on it. A From header
 * naming an address that is not a send-as identity is not honoured: Gmail
 * silently substitutes the primary. An earlier attempt set
 * forms@srjconsultingservices.com and mail arrived from srj@ regardless.
 *
 * So SENDER is the primary address, which is what Gmail will use whatever this
 * says. Stating it plainly keeps the code honest about the envelope it produces,
 * and it is still different from To: info@, which is what stops the dedup.
 *
 * If form mail should come from its own address, forms@ has to exist as a
 * send-as identity on this user first. Setting it here without that does
 * nothing.
 *
 * THE TRUST MODEL, stated plainly: domain-wide delegation lets this key act as
 * a user in the domain. It is therefore scoped to exactly one capability,
 * gmail.send, and impersonates exactly one mailbox. It cannot read mail. Grant
 * this service account no other scope.
 *
 * Secrets, set with `wrangler secret put`, never in the repo:
 *   GOOGLE_SA_EMAIL   the service account address, ends @...gserviceaccount.com
 *   GOOGLE_SA_KEY     its PEM private key, "-----BEGIN PRIVATE KEY-----..."
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** The mailbox impersonated, and where form mail is delivered. */
export const MAILBOX = 'info@srjconsultingservices.com';

/**
 * The From address.
 *
 * The Workspace user's primary address. Gmail will use this whatever the header
 * says, because a From naming a non-send-as identity is silently replaced by the
 * primary. Verified against a delivered message.
 */
export const SENDER = 'srj@srjconsultingservices.com';

/** Standard base64 of bytes. */
function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** base64url, for JWT segments and the Gmail `raw` field. */
const b64url = (buf: ArrayBuffer | Uint8Array): string =>
  b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlText = (t: string) => b64url(new TextEncoder().encode(t));

/**
 * Import a PEM PKCS#8 private key for RS256 signing.
 *
 * The PEM arrives as a Worker secret, so its newlines may be real or the
 * literal two characters \n depending on how it was pasted. Both are handled;
 * getting this wrong produces an opaque failure at sign time.
 */
async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * Access tokens last an hour. Cache per isolate so a burst of submissions does
 * not mint one each time. Isolates are short-lived and not shared between
 * accounts, so this holds nothing sensitive for long.
 */
let cached: { token: string; expires: number } | null = null;

async function accessToken(saEmail: string, saKey: string): Promise<string> {
  // Name the actual problem. Without this, a missing secret surfaces as
  // "Cannot read properties of undefined (reading 'replace')" from importKey,
  // which names neither the secret nor the fact that one is missing.
  if (!saEmail || !saKey) {
    const missing = [!saEmail && 'GOOGLE_SA_EMAIL', !saKey && 'GOOGLE_SA_KEY']
      .filter(Boolean).join(' and ');
    throw new Error(`missing Gmail secret: ${missing}`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expires > now + 60) return cached.token;

  const claims = {
    iss: saEmail,
    sub: MAILBOX, // domain-wide delegation: act as this mailbox
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64urlText(JSON.stringify(claims));
  const key = await importKey(saKey);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  const assertion = `${head}.${body}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    // The body carries Google's actual reason. "unauthorized_client" means the
    // scope is not granted in the admin console, which is the usual first-run
    // failure. Surface it to logs, never to the visitor.
    throw new Error(`token exchange ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json: any = await res.json();
  cached = { token: json.access_token, expires: now + (json.expires_in ?? 3600) };
  return cached.token;
}

/** RFC 2047 encoded-word, so non-ASCII subjects survive transport. */
const encodeSubject = (s: string) =>
  /^[\x20-\x7E]*$/.test(s)
    ? s
    : `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`;

/** Fold a base64 body to 76-char lines, as RFC 2045 requires. */
const fold = (s: string) => s.replace(/(.{76})/g, '$1\r\n');

export interface Mail {
  subject: string;
  text: string;
  /** Where a human reply should go. Not the envelope sender. */
  replyTo?: string;
}

/**
 * Send from SENDER to MAILBOX.
 *
 * replyTo carries the visitor's address rather than From, deliberately. Forging
 * From would break DMARC alignment and land the mail in spam. The message comes
 * from the practice's own mailbox; hitting reply reaches the visitor.
 */
export async function sendMail(
  env: { GOOGLE_SA_EMAIL: string; GOOGLE_SA_KEY: string },
  mail: Mail,
): Promise<void> {
  const token = await accessToken(env.GOOGLE_SA_EMAIL, env.GOOGLE_SA_KEY);

  const headers = [
    `From: SRJ Website Forms <${SENDER}>`,
    `To: ${MAILBOX}`,
    mail.replyTo ? `Reply-To: ${mail.replyTo}` : '',
    `Subject: ${encodeSubject(mail.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);

  const raw =
    `${headers.join('\r\n')}\r\n\r\n` +
    fold(b64(new TextEncoder().encode(mail.text)));

  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64urlText(raw) }),
  });
  if (!res.ok) {
    throw new Error(`gmail send ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}
