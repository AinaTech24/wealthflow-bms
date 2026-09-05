import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

/**
 * Send an email. Non-blocking — caller should NOT await.
 * Silently no-ops if SMTP_HOST is not configured.
 */
export async function sendEmail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) return;

  const from = process.env.EMAIL_FROM || 'noreply@nflx.in';
  try {
    await t.sendMail({ from, to, subject, html });
    console.log(`📧 [Email] Sent "${subject}" to ${Array.isArray(to) ? to.join(', ') : to}`);
  } catch (err) {
    console.error(`📧 [Email] Failed to send "${subject}":`, err.message);
  }
}
