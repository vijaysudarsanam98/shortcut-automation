// Turns report data into an HTML email and a plain-text version.
// Status names are shown exactly as they appear on the Shortcut board.
import { config } from './config.js';
import { formatIST, formatDay, formatLongToday } from './time.js';
import {
  esc,
  C,
  pill,
  link,
  stateTone,
  prCell,
  section,
  emptyNote,
  table,
  storyIdCell,
  page,
  tag,
  truncate,
} from './html.js';

const FLAG_LIMIT = 10;

function daysText(p) {
  return p.daysLeft === 0 ? 'ends today' : `${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left`;
}

function stateSummary(byState) {
  return byState.map((s) => `${s.name} ${s.count}`).join(' · ');
}

// ---------- Sections ----------

function sprintHtml(p, otherIterations) {
  const max = Math.max(1, ...p.byState.map((s) => s.count));
  const barColor = { done: C.green, started: C.blue, unstarted: '#9aa5b1' };
  const rows = p.byState
    .map(
      (s) => `<tr>
<td style="font-size:13px;padding:3px 8px 3px 0">${tag(s.name, stateTone(s.type))}</td>
<td style="font-size:13px;padding:3px 8px;text-align:right;font-weight:600">${s.count}</td>
<td width="40%" style="padding:3px 0"><div style="background:${barColor[s.type] || C.grey};height:8px;border-radius:4px;width:${Math.max(2, Math.round((s.count / max) * 100))}%"></div></td>
</tr>`
    )
    .join('');
  const pts = p.points ? ` · by points ${p.points.pct}% (${p.points.done}/${p.points.total})` : '';
  const others = otherIterations.length
    ? `<div style="font-size:12px;color:${C.muted};margin-top:6px">Also running: ${esc(otherIterations.join(', '))}.</div>`
    : '';
  return `
<div style="font-size:15px">${link(p.url, p.name)}</div>
<div style="font-size:13px;color:${C.muted};margin-bottom:10px">${formatDay(p.startDate)} – ${formatDay(p.endDate)} · <b style="color:${C.text}">${daysText(p)}</b> · ${p.total} stories</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
<div style="font-size:13px;color:${C.muted};margin-top:8px">Completed: <b style="color:${C.text}">${p.done} of ${p.total} (${p.pctCount}%)</b>${pts}</div>${others}`;
}

function customerHtml(nc, open) {
  if (!nc.configured) {
    return emptyNote('Customer priority is not set up yet (see CUSTOMER_* settings in README).');
  }
  const newPart = nc.items.length
    ? table(
        [{ title: 'Story' }, { title: 'Title' }, { title: 'Raised by' }, { title: 'Owner' }, { title: 'Status' }, { title: 'Created' }],
        nc.items.map((r) => [
          storyIdCell(r),
          esc(truncate(r.title)),
          esc(r.requester || '—'),
          esc(r.owner || '—'),
          tag(r.state, stateTone(r.stateType)),
          `<span style="white-space:nowrap">${esc(formatIST(r.createdAt))}</span>`,
        ])
      )
    : emptyNote('None in the last 24 hours.');
  const openPart = open.length
    ? table(
        [{ title: 'Story' }, { title: 'Title' }, { title: 'Owner' }, { title: 'Status' }, { title: 'PR' }],
        open.map((r) => [
          storyIdCell(r) + (r.isNew ? ' ' + pill('New', 'amber') : ''),
          esc(truncate(r.title)) + (r.blocked ? ' ' + tag('Blocked', 'red') : ''),
          esc(r.owner || '—'),
          tag(r.state, stateTone(r.stateType)),
          prCell(r.pr, { compact: true }),
        ])
      )
    : emptyNote('No open customer-priority tickets.');
  const sub = (t) => `<div style="font-size:14px;font-weight:600;margin:10px 0 4px 0">${t}</div>`;
  return sub(`New in the last 24 hours (${nc.items.length})`) + newPart + sub(`All open customer-priority tickets (${open.length})`) + openPart;
}

function flagList(title, items, render) {
  const count = items.length;
  const head = `<div style="font-size:14px;font-weight:600;margin:12px 0 4px 0">${esc(title)} ${pill(String(count), count ? 'amber' : 'green')}</div>`;
  if (!count) return head;
  const lis = items.slice(0, FLAG_LIMIT).map((it) => `<li>${render(it)}</li>`).join('\n');
  const more = count > FLAG_LIMIT ? `<li style="color:${C.muted}">+ ${count - FLAG_LIMIT} more (see work status below)</li>` : '';
  return head + `<ul style="margin:0;padding-left:18px;font-size:13px;line-height:20px">${lis}${more}</ul>`;
}

function flagsHtml(f, staleDays, anyEstimates) {
  const base = (r) =>
    `${storyIdCell(r)} ${esc(truncate(r.title, 80))} <span style="color:${C.muted}">· ${esc(r.owner || 'no owner')} · ${esc(r.state)}</span>`;
  return [
    flagList(`In progress ${staleDays}+ days with no PR`, f.staleNoPr, (r) => `${base(r)} <b>(${r.days} days)</b>`),
    flagList('PR merged but story not in a Done state', f.mergedNotDone, base),
    flagList(`PRs open ${staleDays}+ days`, f.oldOpenPrs, (r) => `${link(r.pr.url, `PR #${r.pr.number ?? ''}`)} · ${base(r)} <b>(${r.days} days)</b>`),
    flagList('Blocked', f.blocked, base),
    flagList('No owner', f.noOwner, base),
    anyEstimates
      ? flagList('No estimate', f.noEstimate, base)
      : `<div style="font-size:13px;color:${C.muted};margin-top:12px">No estimate: skipped, because no story in this sprint is estimated.</div>`,
  ].join('');
}

// full=true: every story as a table row (attachment / preview).
// full=false: active stories in full, not-started ones as compact links (keeps the email under Gmail's ~100 KB limit).
function peopleHtml({ people, idle }, full) {
  const idleHtml = idle.length
    ? `<div style="font-size:13px;margin-top:16px"><b>No open tickets (${idle.length}):</b> <span style="color:${C.muted}">${esc(idle.join(', '))}</span></div>`
    : '';
  if (!people.length) return emptyNote('No open tickets.') + idleHtml;
  const rowsTable = (rows) =>
    table(
      [{ title: 'Story' }, { title: 'Title' }, { title: 'Status' }, { title: 'PR' }],
      rows.map((r) => [
        storyIdCell(r),
        esc(truncate(r.title, 80)) + (r.blocked ? ' ' + tag('Blocked', 'red') : ''),
        tag(r.state, stateTone(r.stateType)),
        prCell(r.pr, { compact: true }),
      ])
    );
  return people
    .map((g) => {
      const active = full ? g.rows : g.rows.filter((r) => r.stateType !== 'unstarted');
      const waiting = full ? [] : g.rows.filter((r) => r.stateType === 'unstarted');
      const waitingHtml = waiting.length
        ? `<div style="font-size:12px;line-height:20px;margin-top:4px"><span style="color:${C.muted}">Not started (${waiting.length}):</span> ${waiting.map(storyIdCell).join(', ')}</div>`
        : '';
      return `
<div style="margin:16px 0 4px 0;font-size:15px;font-weight:600">${esc(g.name)} <span style="font-weight:400;color:${C.muted};font-size:13px">· ${g.rows.length} ticket${g.rows.length === 1 ? '' : 's'}</span></div>
<div style="font-size:12px;color:${C.muted};margin-bottom:4px">${esc(stateSummary(g.byState))}</div>
${active.length ? rowsTable(active) : ''}${waitingHtml}`;
    })
    .join('');
}

// ---------- Email ----------

export function subjectFor(report) {
  const p = report.progress;
  return `${config.email.subjectPrefix} · ${p.name} · ${formatLongToday(new Date(report.generatedAt))}`;
}

export function renderHtml(report, { full = false } = {}) {
  const p = report.progress;
  const chatHelp = config.chat.address
    ? `Questions about any ticket? Reply to this email or write to ${link(`mailto:${config.chat.address}`, config.chat.address)}, for example “sc-1234”, “what is Priya working on”, “Ready in QA”, or “help”.<br>`
    : '';
  const bodyRows = `
<tr><td style="padding:20px 20px 0 20px">
  <div style="font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em">Daily team report</div>
  <h1 style="margin:2px 0 0 0;font-size:21px;line-height:28px">${esc(formatLongToday(new Date(report.generatedAt)))}</h1>
</td></tr>
${section('Sprint status', sprintHtml(p, report.otherIterations))}
${section('Customer-priority tickets', customerHtml(report.newCustomer, report.openCustomer))}
${section('Needs attention', flagsHtml(report.flags, report.staleDays, Boolean(p.points)))}
${section(
  'Work status by person',
  peopleHtml(report.byPerson, full),
  full
    ? `Every story in ${esc(p.name)}, grouped by owner.`
    : `Every story in ${esc(p.name)}, grouped by owner. Not-started tickets are listed as links; the attached file has full details for every story.`
)}`;
  return page({
    title: subjectFor(report),
    preheader: `${p.name}: ${stateSummary(p.byState)}`,
    bodyRows,
    footer: `${chatHelp}Generated ${esc(formatIST(report.generatedAt))} from Shortcut. Times are India Standard Time.`,
  });
}

// ---------- Plain text ----------

export function renderText(report) {
  const p = report.progress;
  const f = report.flags;
  const out = [];
  const line = (r, withOwner = true) =>
    `sc-${r.id} ${truncate(r.title)} | ${withOwner ? (r.owner || 'no owner') + ' | ' : ''}${r.state} | ${r.pr.label}${
      r.pr.prs.length ? ' ' + r.pr.prs.map((x) => x.url).join(' ') : ''
    }`;

  out.push(`DAILY TEAM REPORT: ${formatLongToday(new Date(report.generatedAt))}`, '');
  out.push(`SPRINT: ${p.name} (${formatDay(p.startDate)} – ${formatDay(p.endDate)}, ${daysText(p)}, ${p.total} stories)`);
  p.byState.forEach((s) => out.push(`  ${s.name}: ${s.count}`));
  out.push(`Completed: ${p.done} of ${p.total} (${p.pctCount}%)` + (p.points ? ` · by points ${p.points.pct}%` : ''), p.url, '');

  const nc = report.newCustomer;
  out.push('CUSTOMER-PRIORITY TICKETS');
  if (!nc.configured) out.push('  Not set up yet.');
  else {
    out.push(`  New in the last 24 hours (${nc.items.length}):`);
    nc.items.forEach((r) => out.push(`    sc-${r.id} ${r.title} | raised by ${r.requester || '—'} | ${r.owner || 'no owner'} | ${r.state} | ${formatIST(r.createdAt)}`));
    out.push(`  All open (${report.openCustomer.length}):`);
    report.openCustomer.forEach((r) => out.push(`    ${r.isNew ? '[NEW] ' : ''}${line(r)}`));
  }
  out.push('');

  out.push('NEEDS ATTENTION');
  const flagTxt = (title, items, extra = () => '') => {
    out.push(`  ${title}: ${items.length}`);
    items.slice(0, FLAG_LIMIT).forEach((r) => out.push(`    - sc-${r.id} ${truncate(r.title, 80)} (${r.owner || 'no owner'}, ${r.state})${extra(r)}`));
    if (items.length > FLAG_LIMIT) out.push(`    + ${items.length - FLAG_LIMIT} more`);
  };
  flagTxt(`In progress ${report.staleDays}+ days, no PR`, f.staleNoPr, (r) => ` ${r.days} days`);
  flagTxt('PR merged, story not in a Done state', f.mergedNotDone);
  flagTxt(`PRs open ${report.staleDays}+ days`, f.oldOpenPrs, (r) => ` ${r.days} days ${r.pr.url}`);
  flagTxt('Blocked', f.blocked);
  flagTxt('No owner', f.noOwner);
  if (p.points) flagTxt('No estimate', f.noEstimate);
  out.push('');

  out.push('WORK STATUS BY PERSON');
  for (const g of report.byPerson) {
    out.push(`  ${g.name} (${g.rows.length}): ${stateSummary(g.byState)}`);
    g.rows.forEach((r) => out.push(`    ${line(r, false)}`));
  }
  out.push('');
  if (config.chat.address) out.push(`Questions? Reply to this email or write to ${config.chat.address}. Send "help" for examples.`);
  out.push(`Generated ${formatIST(report.generatedAt)}.`);
  return out.join('\n');
}
