import nodemailer from 'nodemailer';

const BRAND = {
  primary: '#284780',
  primaryDark: '#1A2F52',
  blue: '#3D6CAD',
  teal: '#0E8A7E',
  ink: '#1B2E4A',
  muted: '#5A6578',
  border: '#E1E6ED',
  canvas: '#EEF2F8',
  white: '#FFFFFF',
  codeBg: '#F4F6FA',
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wrapper: table layout + preheader for inbox preview (hidden in body).
 */
function emailShell({ preheader, innerHtml }) {
  const pre = escapeHtml(preheader || '').slice(0, 120);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="x-ua-compatible" content="ie=edge">
  <title>ByDefolt</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.canvas};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${pre}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${BRAND.canvas};">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
          <tr>
            <td style="background-color:${BRAND.white};border-radius:18px;overflow:hidden;border:1px solid ${BRAND.border};box-shadow:0 8px 32px rgba(27,46,74,0.07);">
              ${innerHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 8px 8px;text-align:center;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${BRAND.muted};">
              <p style="margin:0 0 6px;">This email was sent by <strong style="color:${BRAND.primary};">ByDefolt</strong>.</p>
              <p style="margin:0;">If you did not request this, you can safely ignore it.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function brandHeader({ eyebrow, title }) {
  const e = escapeHtml(eyebrow);
  const t = escapeHtml(title);
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:linear-gradient(135deg, ${BRAND.primaryDark} 0%, ${BRAND.primary} 45%, ${BRAND.blue} 100%);">
    <tr>
      <td style="padding:28px 28px 24px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.75);">${e}</p>
        <p style="margin:0;font-size:22px;font-weight:800;line-height:1.25;color:${BRAND.white};letter-spacing:-0.02em;">${t}</p>
        <p style="margin:12px 0 0;font-size:15px;font-weight:600;color:rgba(255,255,255,0.9);">ByDefolt</p>
      </td>
    </tr>
  </table>`;
}

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number.parseInt(process.env.SMTP_PORT, 10) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    return null;
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

/** Default From header for all Nodemailer sends. */
export function getDefaultMailFrom() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@bydefolt.com';
}

/**
 * Single entry point: **all** outbound email in this app should go through Nodemailer here.
 * If `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` are missing, logs a preview and returns `{ skipped: true }` (no throw).
 *
 * @param {object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.text]
 * @param {string} [opts.html]
 * @param {string} [opts.replyTo]
 * @param {string|string[]} [opts.cc]
 * @param {string|string[]} [opts.bcc]
 * @returns {Promise<{ skipped: boolean }>}
 */
export async function sendTransactionalEmail({ to, subject, text = '', html, replyTo, cc, bcc }) {
  const from = getDefaultMailFrom();
  const transport = createTransport();
  if (!transport) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mail] SMTP not configured — skipped: "${subject}" → ${Array.isArray(to) ? to.join(', ') : to}`
    );
    if (text) {
      // eslint-disable-next-line no-console
      console.warn(`[mail] text preview: ${text.slice(0, 500)}${text.length > 500 ? '…' : ''}`);
    }
    return { skipped: true };
  }

  const payload = {
    from,
    to,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
  };
  if (!payload.text && !payload.html) {
    payload.text = '(no body)';
  }
  if (replyTo) payload.replyTo = replyTo;
  if (cc) payload.cc = cc;
  if (bcc) payload.bcc = bcc;

  await transport.sendMail(payload);
  return { skipped: false };
}

/**
 * Sends a 4-digit OTP email. If SMTP is not configured, logs the code (development fallback).
 */
export async function sendOtpEmail(to, code, purpose) {
  const isSignup = purpose === 'signup';
  const subject = isSignup ? 'Verify your email — ByDefolt' : 'Your sign-in code — ByDefolt';

  const text = isSignup
    ? `ByDefolt — verify your account\n\nYour code is: ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.\n\nIf you did not create an account, ignore this email.\n`
    : `ByDefolt — sign-in code\n\nYour code is: ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.\n\nIf you did not try to sign in, ignore this email.\n`;

  const inner = `
  ${brandHeader({
    eyebrow: isSignup ? 'Account verification' : 'Sign-in security',
    title: isSignup ? 'Confirm your email address' : 'Your one-time code',
  })}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td style="padding:28px 28px 8px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:${BRAND.ink};">
        <p style="margin:0 0 16px;">Use this <strong>4-digit code</strong> in the app to continue. For your security, the code expires in <strong>10 minutes</strong>.</p>
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:8px 28px 24px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="background-color:${BRAND.codeBg};border-radius:14px;border:1px solid ${BRAND.border};">
          <tr>
            <td style="padding:20px 36px;font-family:ui-monospace,Consolas,monospace;font-size:32px;font-weight:800;letter-spacing:10px;color:${BRAND.primary};text-align:center;">
              ${escapeHtml(code)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 28px 28px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:${BRAND.muted};">
        <p style="margin:0;padding:14px 16px;background-color:${BRAND.codeBg};border-radius:12px;border-left:4px solid ${BRAND.teal};">
          <strong style="color:${BRAND.ink};">Tip:</strong> ByDefolt will never ask for this code by phone or WhatsApp. Never share it with anyone.
        </p>
      </td>
    </tr>
  </table>`;

  const html = emailShell({
    preheader: `${isSignup ? 'Verify' : 'Sign in'} with code ${code} — expires in 10 minutes.`,
    innerHtml: inner,
  });

  const result = await sendTransactionalEmail({ to, subject, text, html });
  if (result.skipped) {
    // eslint-disable-next-line no-console
    console.warn(`[mail] OTP for ${to} (${purpose}): ${code}`);
  }
  return result;
}

/**
 * Sent after successful signup OTP verification.
 * @param {string} to
 * @param {string} name
 * @param {boolean} companyPendingReview - true if company account still awaits admin approval
 */
export async function sendWelcomeAfterSignupEmail(to, name, companyPendingReview) {
  const firstRaw = String(name || '')
    .trim()
    .split(/\s+/)[0];
  const first = firstRaw ? escapeHtml(firstRaw) : '';
  const greetingHtml = first ? `Hi ${first},` : 'Hi there,';
  const greetingText = firstRaw ? `Hi ${firstRaw},` : 'Hi there,';

  const subject = companyPendingReview
    ? 'Welcome to ByDefolt — your application is under review'
    : 'Welcome to ByDefolt — you are all set';

  const text = companyPendingReview
    ? `${greetingText}

Thank you for choosing ByDefolt. Your email is verified.

Our team is reviewing your company profile and verification documents. We will email you when your workspace is approved.

— The ByDefolt team
`
    : `${greetingText}

Thank you for choosing ByDefolt. Your email is verified and your account is ready.

We are glad to have you with us.

— The ByDefolt team
`;

  const bodyParagraphs = companyPendingReview
    ? `
        <p style="margin:0 0 14px;">Thank you for choosing <strong style="color:${BRAND.primary};">ByDefolt</strong>. Your email is now verified.</p>
        <p style="margin:0 0 14px;">Our team is reviewing your <strong>company profile</strong> and verification documents. You will receive another email at this address when your workspace is <strong>approved</strong> and you can sign in as usual.</p>
        <p style="margin:0;">Typical review time is <strong>1–2 business days</strong>. If you have questions, reply to this email or contact support.</p>`
    : `
        <p style="margin:0 0 14px;">Thank you for choosing <strong style="color:${BRAND.primary};">ByDefolt</strong>. Your email is verified and your account is <strong>ready to use</strong>.</p>
        <p style="margin:0;">We are glad to have you with us — explore roles, build your profile, and make the most of the platform.</p>`;

  const inner = `
  ${brandHeader({
    eyebrow: 'Welcome aboard',
    title: companyPendingReview ? 'Thank you for choosing ByDefolt' : 'You are in — welcome',
  })}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td style="padding:28px 28px 8px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:${BRAND.ink};">
        <p style="margin:0 0 18px;font-size:17px;font-weight:700;color:${BRAND.ink};">${greetingHtml}</p>
        ${bodyParagraphs}
      </td>
    </tr>
    <tr>
      <td style="padding:8px 28px 28px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:linear-gradient(90deg, rgba(14,138,126,0.12) 0%, rgba(40,71,128,0.08) 100%);border-radius:14px;border:1px solid ${BRAND.border};">
          <tr>
            <td style="padding:18px 20px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:${BRAND.ink};">
              <p style="margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.teal};">What is next</p>
              <p style="margin:0;color:${BRAND.muted};">
                ${
                  companyPendingReview
                    ? 'Wait for approval → then sign in with your email and password.'
                    : 'Open the app → sign in and complete your profile for the best experience.'
                }
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 28px 28px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:${BRAND.muted};border-top:1px solid ${BRAND.border};">
        <p style="margin:20px 0 0;">With appreciation,<br><strong style="color:${BRAND.primary};">The ByDefolt team</strong></p>
      </td>
    </tr>
  </table>`;

  const html = emailShell({
    preheader: companyPendingReview
      ? 'Your company application is under review — we will email you when approved.'
      : 'Your ByDefolt account is ready. Thank you for joining us.',
    innerHtml: inner,
  });

  return sendTransactionalEmail({ to, subject, text, html });
}

/** Owner approved the company — notify the company contact (Nodemailer). */
export async function sendCompanyApprovedEmail(to, name) {
  const firstRaw = String(name || '')
    .trim()
    .split(/\s+/)[0];
  const first = firstRaw ? escapeHtml(firstRaw) : '';
  const greetingHtml = first ? `Hi ${first},` : 'Hi there,';
  const greetingText = firstRaw ? `Hi ${firstRaw},` : 'Hi there,';

  const subject = 'Your ByDefolt company workspace is approved';
  const text = `${greetingText}

Great news — your company account on ByDefolt has been approved.

You can now open the app and sign in with your email and password to manage your workspace.

— The ByDefolt team
`;

  const inner = `
  ${brandHeader({ eyebrow: 'Approved', title: 'Your workspace is ready' })}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td style="padding:28px 28px 28px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:${BRAND.ink};">
        <p style="margin:0 0 16px;font-size:17px;font-weight:700;color:${BRAND.ink};">${greetingHtml}</p>
        <p style="margin:0 0 14px;">Your <strong style="color:${BRAND.primary};">company account</strong> on ByDefolt has been <strong>approved</strong>.</p>
        <p style="margin:0 0 20px;color:${BRAND.muted};">Sign in with your email and password in the app to post jobs, manage your profile, and use your workspace.</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:rgba(14,138,126,0.1);border-radius:12px;border:1px solid ${BRAND.border};">
          <tr>
            <td style="padding:16px 18px;font-size:14px;color:${BRAND.ink};">
              <strong>Next step:</strong> Open ByDefolt → Login → use your registered email.
            </td>
          </tr>
        </table>
        <p style="margin:22px 0 0;font-size:14px;color:${BRAND.muted};">Welcome aboard,<br><strong style="color:${BRAND.primary};">The ByDefolt team</strong></p>
      </td>
    </tr>
  </table>`;

  const html = emailShell({
    preheader: 'Your company has been approved on ByDefolt. You can sign in now.',
    innerHtml: inner,
  });

  return sendTransactionalEmail({ to, subject, text, html });
}

/** Owner rejected the company — notify the company contact (Nodemailer). */
export async function sendCompanyRejectedEmail(to, name, reason) {
  const firstRaw = String(name || '')
    .trim()
    .split(/\s+/)[0];
  const first = firstRaw ? escapeHtml(firstRaw) : '';
  const greetingHtml = first ? `Hi ${first},` : 'Hi there,';
  const greetingText = firstRaw ? `Hi ${firstRaw},` : 'Hi there,';
  const reasonRaw = String(reason || '').trim().slice(0, 300);
  const reasonHtml = reasonRaw ? escapeHtml(reasonRaw) : '';

  const subject = 'Update on your ByDefolt company application';
  const text = `${greetingText}

We reviewed your company application on ByDefolt. Unfortunately, we are not able to approve it at this time.${reasonRaw ? ` Reason: ${reasonRaw}` : ''}

If you believe this is a mistake, please contact support.

— The ByDefolt team
`;

  const reasonBlock = reasonHtml
    ? `<p style="margin:0 0 14px;padding:14px 16px;background-color:${BRAND.codeBg};border-radius:12px;border-left:4px solid #C17D2A;font-size:14px;color:${BRAND.ink};"><strong>Message:</strong> ${reasonHtml}</p>`
    : '';

  const inner = `
  ${brandHeader({ eyebrow: 'Application update', title: 'We could not approve this request' })}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td style="padding:28px 28px 28px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:${BRAND.ink};">
        <p style="margin:0 0 16px;font-size:17px;font-weight:700;color:${BRAND.ink};">${greetingHtml}</p>
        <p style="margin:0 0 14px;">We reviewed your <strong>company application</strong> on ByDefolt. We are <strong>not able to approve</strong> it at this time.</p>
        ${reasonBlock}
        <p style="margin:0;color:${BRAND.muted};font-size:14px;">If you have questions or think this was an error, please contact support.</p>
        <p style="margin:22px 0 0;font-size:14px;color:${BRAND.muted};">Regards,<br><strong style="color:${BRAND.primary};">The ByDefolt team</strong></p>
      </td>
    </tr>
  </table>`;

  const html = emailShell({
    preheader: 'An update on your ByDefolt company application.',
    innerHtml: inner,
  });

  return sendTransactionalEmail({ to, subject, text, html });
}
