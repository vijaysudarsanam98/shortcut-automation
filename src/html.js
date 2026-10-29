// Small HTML building blocks with inline CSS (email clients ignore <style> tags).
// Shared by the daily report and the chat assistant's replies.

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const C = {
  text: '#1f2933',
  muted: '#616e7c',
  border: '#e4e7eb',
  bg: '#f5f7fa',
  card: '#ffffff',
  link: '#3355dd',
  green: '#1b7f4b',
  greenBg: '#e3f7ec',
  blue: '#1f5fbf',
  blueBg: '#e6effc',
  amber: '#8a5a00',
  amberBg: '#fff4d6',
  red: '#b42318',
  redBg: '#fdecea',
  grey: '#52606d',
  greyBg: '#eef1f4',
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function pill(text, tone = 'grey') {
  const map = {
    green: [C.green, C.greenBg],
    blue: [C.blue, C.blueBg],
    amber: [C.amber, C.amberBg],
    red: [C.red, C.redBg],
    grey: [C.grey, C.greyBg],
  };
  const [fg, bg] = map[tone] || map.grey;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;line-height:18px;white-space:nowrap;color:${fg};background:${bg};">${esc(text)}</span>`;
}

export function link(url, text) {
  return `<a href="${esc(url)}">${esc(text)}</a>`;
}

export function stateTone(type) {
  return type === 'done' ? 'green' : type === 'started' ? 'blue' : 'grey';
}

export function prTone(key) {
  return { merged: 'green', open: 'blue', draft: 'amber', closed: 'red', none: 'grey' }[key] || 'grey';
}

const TONE_FG = { green: C.green, blue: C.blue, amber: C.amber, red: C.red, grey: C.grey };

// Coloured text: a lighter alternative to pill() for big tables (keeps emails small).
export function tag(text, tone = 'grey') {
  return `<span style="color:${TONE_FG[tone] || C.grey}">${esc(text)}</span>`;
}

export function prCell(pr, { compact = false } = {}) {
  const links = pr.prs.map((p) => link(p.url, `#${p.number ?? ''}`)).join(' ');
  if (compact) return tag(pr.label, prTone(pr.key)) + (links ? ' ' + links : '');
  return pill(pr.label, prTone(pr.key)) + (links ? `<div style="margin-top:3px;font-size:12px;">${links}</div>` : '');
}

export function truncate(s, n = 90) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export function section(title, body, note = '') {
  return `
<tr><td style="padding:20px 20px 4px 20px;">
  <h2 style="margin:0 0 4px 0;font-size:17px;line-height:24px;color:${C.text};">${esc(title)}</h2>
  ${note ? `<div style="font-size:13px;color:${C.muted};margin-bottom:6px;">${note}</div>` : ''}
  ${body}
</td></tr>`;
}

export function emptyNote(text) {
  return `<div style="font-size:14px;color:${C.muted};padding:6px 0;">${esc(text)}</div>`;
}

// columns: [{ title, width? }], rows: array of arrays of HTML strings
export function table(columns, rows) {
  const th = columns
    .map(
      (c) =>
        `<th align="left" style="font-size:12px;color:${C.muted};border-bottom:1px solid ${C.border};white-space:nowrap">${esc(c.title)}</th>`
    )
    .join('');
  // Cell styling is kept short on purpose: Gmail cuts off emails over ~100 KB.
  const tr = rows.map((r, i) => `<tr valign="top"${i % 2 ? '' : ` bgcolor="${C.bg}"`}><td>${r.join('</td><td>')}</td></tr>`).join('\n');
  return `<table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;line-height:18px">
<thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

// Non-breaking hyphen keeps "sc-123" on one line on phones.
export function storyIdCell(row) {
  return `<a href="${esc(row.url)}">sc&#8209;${row.id}</a>`;
}

export function page({ title, preheader = '', bodyRows, footer = '' }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};color:${C.text};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};">
<tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:${C.card};border:1px solid ${C.border};border-radius:10px;font-family:${FONT};">
${bodyRows}
<tr><td style="padding:16px 20px 20px 20px;font-size:12px;line-height:18px;color:${C.muted};border-top:1px solid ${C.border};">${footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
