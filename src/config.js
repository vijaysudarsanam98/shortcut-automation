// Reads every setting from environment variables (or a local .env file).
// Nothing secret is ever printed.
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && value !== '' && value !== undefined ? n : fallback;
}

export class ConfigError extends Error {}

const env = process.env;

export const config = {
  shortcutToken: (env.SHORTCUT_API_TOKEN || '').trim(),
  // Optional: if several teams run sprints at the same time, pick one by team name.
  iterationTeam: (env.ITERATION_TEAM || '').trim(),

  customer: {
    labels: list(env.CUSTOMER_LABELS),
    priorityValues: list(env.CUSTOMER_PRIORITY_VALUES),
    storyTypes: list(env.CUSTOMER_STORY_TYPES),
    teams: list(env.CUSTOMER_TEAMS),
    states: list(env.CUSTOMER_STATES),
  },

  flags: {
    staleDays: num(env.FLAG_STALE_DAYS, 3),
  },

  // Extra workflow states that count as finished (besides Shortcut's "done" states).
  doneStates: list(env.DONE_STATES),
  // States where a merged PR is normal (e.g. QA), so "merged but not done" isn't flagged.
  mergedOkStates: list(env.MERGED_OK_STATES),

  email: {
    provider: (env.EMAIL_PROVIDER || 'gmail').trim().toLowerCase(),
    host: (env.SMTP_HOST || '').trim(),
    port: num(env.SMTP_PORT, 0),
    imapHost: (env.IMAP_HOST || '').trim(),
    user: (env.EMAIL_USER || '').trim(),
    // Address shown as the sender. Defaults to EMAIL_USER (Brevo needs your verified sender here).
    from: (env.EMAIL_FROM || env.EMAIL_USER || '').trim(),
    password: (env.EMAIL_PASSWORD || '').replace(/\s+/g, ''),
    fromName: (env.EMAIL_FROM_NAME || 'Shortcut Daily Report').trim(),
    recipients: list(env.REPORT_RECIPIENTS),
    subjectPrefix: (env.REPORT_SUBJECT || 'Shortcut Daily Report').trim(),
  },

  chat: {
    // Who may ask the assistant questions. Defaults to the report recipients.
    // Entries can be full addresses or whole domains like "@yourcompany.com".
    allowedSenders: list(env.CHAT_ALLOWED_SENDERS),
    // Address people write to. Defaults to EMAIL_USER with "+shortcut" added (Gmail feature).
    address: (env.CHAT_ADDRESS || '').trim(),
  },
};

if (config.chat.allowedSenders.length === 0) {
  config.chat.allowedSenders = [...config.email.recipients];
}
if (config.email.provider === 'brevo') {
  config.chat.address = ''; // Brevo can only send, so there is no inbox to answer questions from
} else if (!config.chat.address && config.email.user.includes('@')) {
  const [name, domain] = config.email.user.split('@');
  config.chat.address = `${name}+shortcut@${domain}`;
}

export function requireShortcut() {
  if (!config.shortcutToken) {
    throw new ConfigError(
      'SHORTCUT_API_TOKEN is missing. Add it to your .env file (or GitHub secrets). ' +
        'Create one in Shortcut: Settings > Your Account > API Tokens.'
    );
  }
}

export function requireEmail({ needRecipients = true } = {}) {
  const missing = [];
  if (!config.email.user) missing.push('EMAIL_USER');
  if (!config.email.password) missing.push('EMAIL_PASSWORD');
  if (needRecipients && config.email.recipients.length === 0) missing.push('REPORT_RECIPIENTS');
  if (config.email.provider === 'smtp' && !config.email.host) missing.push('SMTP_HOST');
  if (missing.length) {
    throw new ConfigError(`Email settings missing: ${missing.join(', ')}. See .env.example.`);
  }
}

export function customerRuleConfigured() {
  const c = config.customer;
  return c.labels.length + c.priorityValues.length + c.storyTypes.length + c.teams.length + c.states.length > 0;
}
