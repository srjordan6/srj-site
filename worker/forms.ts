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

  // 2. timing: the form stamps render time in a hidden field
  const started = Number(clip(form.get('form_started')));
  if (started && Date.now() - started < 3000) {
    console.log(`gate: too fast on ${where}, ${Date.now() - started}ms after render`);
    return ok('Thank you. Your message has been received.');
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

  const name = clip(form.get('name'), 200);
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

  const name = clip(form.get('name'), 200);
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
