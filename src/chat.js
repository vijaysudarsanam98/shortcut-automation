// Email assistant: checks the mailbox for questions and replies with answers.
//   npm run chat         -> check once (used by GitHub Actions every 15 minutes)
//   npm run chat:watch   -> keep running and check every minute (for an always-on computer)
//
// Which emails are answered:
//   - sent to the assistant address (EMAIL_USER with "+shortcut", e.g. you+shortcut@gmail.com), or
//   - replies to the daily report (subject contains REPORT_SUBJECT)
//   - and only from allowed senders (CHAT_ALLOWED_SENDERS, default: the report recipients).
// Gmail: answered emails get the label "shortcut-bot-answered" (read/unread is left alone).
// Other providers: answered emails are marked as read.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config, requireShortcut, requireEmail } from './config.js';
import { answerQuestion, resetCache } from './assistant.js';
import { sendMail, imapHost } from './mailer.js';
import { runMain } from './run.js';

const LABEL = 'shortcut-bot-answered';
const MAX_PER_RUN = 20;

function isGmail() {
  return config.email.provider === 'gmail' || /gmail\.com$/i.test(imapHost());
}

export function isAllowed(address) {
  const a = (address || '').toLowerCase();
  if (!a) return false;
  return config.chat.allowedSenders.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('@') ? a.endsWith(e) : a === e;
  });
}

// Keep only the new text of a reply: drop quoted history and signatures.
export function extractQuestion(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^On\b.*wrote:$/i.test(t) || (/^On\b/.test(t) && /wrote:$/i.test((lines[i + 1] || '').trim()))) break;
    if (/^-{2,}\s*Original Message/i.test(t) || /^_{5,}$/.test(t) || /^From:\s/i.test(t)) break;
    if (t === '--' || t === '-- ' || /^Sent from my /i.test(t)) break;
    if (t.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim().slice(0, 1000);
}

function isAutomated(parsed) {
  const h = parsed.headers;
  const auto = String(h.get('auto-submitted') || 'no').toLowerCase();
  const prec = String(h.get('precedence') || '').toLowerCase();
  const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  return (
    auto !== 'no' ||
    ['bulk', 'junk', 'list', 'auto_reply'].includes(prec) ||
    h.has('x-autoreply') ||
    h.has('x-autorespond') ||
    /mailer-daemon|no-?reply|postmaster/.test(from)
  );
}

function searchQuery() {
  const addr = config.chat.address;
  const subj = config.email.subjectPrefix.replace(/"/g, '');
  if (isGmail()) {
    return { gmraw: `newer_than:3d -label:${LABEL} -from:me {deliveredto:${addr} to:${addr} subject:"${subj}"}` };
  }
  return { seen: false, or: [{ to: addr }, { subject: subj }] };
}

async function markHandled(client, uid) {
  if (isGmail()) await client.messageFlagsAdd(String(uid), [LABEL], { uid: true, useLabels: true });
  else await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
}

export async function checkInbox() {
  const client = new ImapFlow({
    host: imapHost(),
    port: 993,
    secure: true,
    auth: { user: config.email.user, pass: config.email.password },
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      'Could not log in to the mailbox to read questions. ' +
        (isGmail()
          ? 'Check EMAIL_USER and the App Password, and that IMAP is on (Gmail > Settings > Forwarding and POP/IMAP).'
          : 'Check EMAIL_USER, EMAIL_PASSWORD and IMAP_HOST.') +
        ` (${err.responseText || err.message})`
    );
  }

  let answered = 0;
  let skipped = 0;
  try {
    if (isGmail()) await client.mailboxCreate(LABEL).catch(() => {}); // label may already exist
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = ((await client.search(searchQuery(), { uid: true })) || []).slice(0, MAX_PER_RUN);
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg) continue;
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0]?.address || '';
        const self = from.toLowerCase() === config.email.user.toLowerCase();

        if (self || isAutomated(parsed) || !isAllowed(from)) {
          skipped++;
          await markHandled(client, uid);
          continue;
        }

        const question = extractQuestion(parsed.text || '');
        let answer;
        try {
          answer = await answerQuestion(question);
        } catch (err) {
          answer = {
            html: `<p>Sorry, I couldn't answer that just now: ${String(err.message).replace(/</g, '&lt;')}</p>`,
            text: `Sorry, I couldn't answer that just now: ${err.message}`,
          };
        }

        const subject = parsed.subject || 'Shortcut question';
        const refs = [].concat(parsed.references || [], parsed.messageId || []);
        await sendMail({
          to: from,
          subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
          html: answer.html,
          text: answer.text,
          inReplyTo: parsed.messageId,
          references: refs,
          replyTo: config.chat.address,
        });
        await markHandled(client, uid);
        answered++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { answered, skipped };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMain(async () => {
    requireShortcut();
    requireEmail({ needRecipients: false });
    const watch = process.argv.includes('--watch');
    if (!watch) {
      const { answered, skipped } = await checkInbox();
      console.log(`Answered ${answered} question(s), skipped ${skipped}.`);
      return;
    }
    console.log('Watching the mailbox. Press Ctrl+C to stop.');
    for (;;) {
      try {
        resetCache();
        const { answered, skipped } = await checkInbox();
        if (answered || skipped) console.log(`${new Date().toLocaleTimeString()} answered ${answered}, skipped ${skipped}.`);
      } catch (err) {
        console.error(`${new Date().toLocaleTimeString()} ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 60_000));
    }
  });
}
