// Entry point: build the daily report and email it (or save it with --dry-run).
// Logs show only counts, never ticket details, because GitHub Actions logs can be public.
import { writeFile } from 'node:fs/promises';
import { config, requireShortcut, requireEmail } from './config.js';
import { buildReport } from './report-builder.js';
import { renderHtml, renderText, subjectFor } from './email-template.js';
import { sendMail } from './mailer.js';
import { runMain } from './run.js';

runMain(async () => {
  const dryRun = process.argv.includes('--dry-run');
  requireShortcut();
  if (!dryRun) requireEmail();

  console.log('Fetching data from Shortcut…');
  const report = await buildReport();
  const html = renderHtml(report);
  const fullHtml = renderHtml(report, { full: true });
  const text = renderText(report);
  const subject = subjectFor(report);
  console.log(
    `Sprint has ${report.progress.total} stories; ${report.newCustomer.items.length} new customer-priority ticket(s).`
  );

  if (dryRun) {
    await writeFile('report.html', html);
    await writeFile('report-full.html', fullHtml);
    await writeFile('report.txt', text);
    console.log(
      `Dry run: saved report.html (the email, ${Math.round(Buffer.byteLength(html) / 1024)} KB), ` +
        'report-full.html (the attachment) and report.txt. Nothing was emailed.'
    );
    return;
  }

  await sendMail({
    to: config.email.recipients,
    subject,
    html,
    text,
    replyTo: config.email.provider === 'brevo' ? undefined : config.chat.address || undefined,
    attachments: [{ filename: `${report.progress.name} - full sprint report.html`, content: fullHtml, contentType: 'text/html' }],
  });
  console.log(`Report emailed to ${config.email.recipients.length} recipient(s).`);
});
