// Sends email through Gmail, Outlook/Microsoft 365, or any SMTP server.
import nodemailer from 'nodemailer';
import { config, requireEmail } from './config.js';

const PRESETS = {
  gmail: { smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, imap: 'imap.gmail.com' },
  outlook: { smtp: { host: 'smtp.office365.com', port: 587, secure: false }, imap: 'outlook.office365.com' },
  // Brevo (free, send-only): EMAIL_USER = SMTP login, EMAIL_PASSWORD = SMTP key, EMAIL_FROM = verified sender
  brevo: { smtp: { host: 'smtp-relay.brevo.com', port: 587, secure: false } },
};

export function smtpSettings() {
  const e = config.email;
  const preset = PRESETS[e.provider];
  if (preset && !e.host) return preset.smtp;
  const port = e.port || 587;
  return { host: e.host, port, secure: port === 465 };
}

export function imapHost() {
  return config.email.imapHost || PRESETS[config.email.provider]?.imap || config.email.host;
}

let transporter;
function getTransport() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      ...smtpSettings(),
      auth: { user: config.email.user, pass: config.email.password },
    });
  }
  return transporter;
}

function explain(err) {
  if (err.code === 'EAUTH' || err.responseCode === 535) {
    const hint =
      config.email.provider === 'gmail'
        ? 'For Gmail, EMAIL_PASSWORD must be a 16-character App Password (not your normal password). See README > "Gmail app password".'
        : 'Check EMAIL_USER and EMAIL_PASSWORD. Your IT team may need to enable SMTP for this mailbox.';
    return new Error(`The email server rejected the login. ${hint}`);
  }
  return err;
}

export async function sendMail({ to, subject, html, text, inReplyTo, references, replyTo, attachments }) {
  requireEmail({ needRecipients: false });
  try {
    return await getTransport().sendMail({
      from: { name: config.email.fromName, address: config.email.from },
      to,
      subject,
      html,
      text,
      replyTo,
      inReplyTo,
      references,
      attachments,
    });
  } catch (err) {
    throw explain(err);
  }
}
