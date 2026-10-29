// The email assistant's "brain": reads a question and builds an answer from Shortcut.
// Rule-based (no AI service): it recognises ticket IDs, people's names and keywords,
// and falls back to a keyword search across the whole workspace.
import * as sc from './shortcut.js';
import { config, customerRuleConfigured } from './config.js';
import {
  loadWorkspace,
  ownerNames,
  personName,
  stateOf,
  storyLink,
  prSummary,
  prLabel,
  prState,
  isCustomerPriority,
  isBlocked,
} from './workspace.js';
import { storyRow, findCurrentIteration, sprintProgress, buildFlags } from './report-builder.js';
import { formatIST, formatDay } from './time.js';
import { esc, C, pill, link, stateTone, prCell, prTone, section, emptyNote, table, storyIdCell, page } from './html.js';

const MAX_LIST = 40; // stories listed in one answer
const MAX_PR_LOOKUPS = 30; // full-story fetches (for PR status) per answer

let wsPromise;
let openPromise;
let iterationNames;

// Forget cached Shortcut data (used between checks in watch mode).
export function resetCache() {
  wsPromise = openPromise = iterationNames = vocabPromise = undefined;
}

function workspace() {
  wsPromise ||= loadWorkspace();
  return wsPromise;
}

// All not-done stories in the workspace (Shortcut search returns up to 1000 per query).
function openStories() {
  openPromise ||= Promise.all([
    sc.searchStories('is:started !is:archived'),
    sc.searchStories('is:unstarted !is:archived'),
  ]).then(([a, b]) => dedupe([...a, ...b]));
  return openPromise;
}

function dedupe(stories) {
  const m = new Map();
  stories.forEach((s) => m.set(s.id, s));
  return [...m.values()];
}

// ---------- Question understanding ----------

const STOP = new Set(
  `a an the is are was were be been am i me my we our you your he she they them it its this that these those of to in on at for from by with about
  what whats what's which who whom whose when where why how can could would should will shall do does did done any all some please pls thanks thank
  status update tell show give list get find check info details detail know any anything there here and or not no yes hi hello hey team story stories
  ticket tickets sc issue issues task tasks currently current now today latest`.split(/\s+/)
);

export function extractStoryIds(text, wordCount) {
  const ids = new Set();
  const re = /(?<![\w])(?:sc-?|#|story\s*#?|ticket\s*#?|card\s*#?)\s?(\d{1,7})\b/gi;
  let m;
  while ((m = re.exec(text))) ids.add(Number(m[1]));
  // Short messages like "status of 12345" — accept bare 3–7 digit numbers too.
  if (!ids.size && wordCount <= 8) {
    for (const n of text.match(/\b\d{3,7}\b/g) || []) ids.add(Number(n));
  }
  return [...ids].slice(0, 5);
}

function findPeople(ws, lower) {
  const words = new Set(lower.match(/[a-z][a-z.'-]+/g) || []);
  const hits = [];
  for (const [id, p] of ws.people) {
    if (p.inactive) continue;
    const full = p.name.toLowerCase();
    const first = full.split(/\s+/)[0];
    const mention = p.mention.toLowerCase();
    if (
      (full.includes(' ') && lower.includes(full)) ||
      (mention && (words.has(mention) || lower.includes('@' + mention))) ||
      (first.length >= 3 && !STOP.has(first) && words.has(first))
    ) {
      hits.push({ id, ...p });
    }
  }
  return hits;
}

function has(lower, re) {
  return re.test(lower);
}

// ---------- Answer builders ----------

async function withPrs(stories) {
  if (stories.length > MAX_PR_LOOKUPS) return { stories, prsKnown: false };
  const full = await sc.getStoriesFull(stories.map((s) => s.id));
  return { stories: full, prsKnown: true };
}

function sortByState(ws, list) {
  const order = { started: 0, unstarted: 1, done: 2 };
  return [...list].sort(
    (a, b) =>
      (order[stateOf(ws, a).type] ?? 3) - (order[stateOf(ws, b).type] ?? 3) ||
      (b.updated_at || '').localeCompare(a.updated_at || '')
  );
}

async function storyListAnswer(ws, title, list, { note = '', showOwner = true } = {}) {
  const total = list.length;
  const shown = sortByState(ws, list).slice(0, MAX_LIST);
  const { stories, prsKnown } = await withPrs(shown);
  const rows = stories.map((s) => storyRow(ws, s));
  const more = total > shown.length ? ` Showing ${shown.length} of ${total}.` : '';

  const cols = [{ title: 'Story' }, { title: 'Title' }];
  if (showOwner) cols.push({ title: 'Owner' });
  cols.push({ title: 'State' });
  if (prsKnown) cols.push({ title: 'PR' });

  const htmlBody = rows.length
    ? table(
        cols,
        rows.map((r) => {
          const cells = [storyIdCell(r), esc(r.title) + (r.blocked ? ' ' + pill('Blocked', 'red') : '')];
          if (showOwner) cells.push(esc(r.owner || '—'));
          cells.push(pill(r.state, stateTone(r.stateType)));
          if (prsKnown) cells.push(prCell(r.pr));
          return cells;
        })
      )
    : emptyNote('Nothing found.');

  const textLines = rows.map(
    (r) =>
      `- sc-${r.id} ${r.title} | ${showOwner ? (r.owner || 'no owner') + ' | ' : ''}${r.state}${prsKnown ? ' | ' + r.pr.label : ''}\n  ${r.url}`
  );
  return {
    title,
    html: section(`${title} (${total})`, htmlBody, esc(note) + more),
    text: `${title.toUpperCase()} (${total})${note ? '\n' + note : ''}${more}\n${textLines.join('\n') || 'Nothing found.'}`,
  };
}

async function iterationName(id) {
  if (!id) return '';
  iterationNames ||= sc.getIterations().then((list) => new Map(list.map((i) => [i.id, i.name])));
  return (await iterationNames).get(id) || '';
}

async function storyDetail(ws, id) {
  let s;
  try {
    s = await sc.getStory(id);
  } catch (err) {
    if (err.status === 404) {
      return { title: `sc-${id}`, html: section(`sc-${id}`, emptyNote(`Story sc-${id} was not found.`)), text: `sc-${id}: not found.` };
    }
    throw err;
  }
  const state = stateOf(ws, s);
  const pr = prSummary(s);
  const team = s.group_id ? ws.teams.get(s.group_id)?.name : '';
  const iter = await iterationName(s.iteration_id);
  const labels = (s.labels || []).map((l) => l.name).join(', ');
  const customer = isCustomerPriority(ws, s);
  const priority = (s.custom_fields || [])
    .map((cf) => ws.fieldValues.get(cf.value_id))
    .filter(Boolean)
    .map((v) => `${v.field}: ${v.value}`)
    .join(', ');
  const desc = (s.description || '').replace(/\s+/g, ' ').trim();
  const comments = (s.comments || [])
    .filter((c) => !c.deleted && c.text)
    .slice(-3)
    .map((c) => ({ who: personName(ws, c.author_id), when: formatIST(c.created_at), text: c.text.replace(/\s+/g, ' ').slice(0, 300) }));

  const facts = [
    ['State', pill(state.name, stateTone(state.type)) + (isBlocked(ws, s) ? ' ' + pill('Blocked', 'red') : '')],
    ['Owner', esc(ownerNames(ws, s) || 'No owner')],
    ['Raised by', esc(personName(ws, s.requested_by_id) || '—')],
    ['Type', esc(s.story_type || '')],
    ['Estimate', esc(s.estimate ?? 'Not estimated')],
    ['Sprint', esc(iter || 'Not in a sprint')],
    ['Team', esc(team || '—')],
    ['Labels', esc(labels || '—')],
    ['Fields', esc(priority || '—')],
    ['Customer priority', customer ? pill('Yes', 'amber') : 'No'],
    ['Created', esc(formatIST(s.created_at))],
    ['Last updated', esc(formatIST(s.updated_at))],
  ];
  if (s.started_at) facts.push(['Started', esc(formatIST(s.started_at))]);
  if (s.completed_at) facts.push(['Completed', esc(formatIST(s.completed_at))]);

  const factRows = facts
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 10px 4px 0;font-size:13px;color:${C.muted};white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:4px 0;font-size:13px;">${v}</td></tr>`
    )
    .join('');

  const prHtml = pr.prs.length
    ? `<ul style="margin:4px 0 0 0;padding-left:18px;">${pr.prs
        .map(
          (p) =>
            `<li style="font-size:13px;margin-bottom:3px;">${link(p.url, `PR #${p.number ?? ''} ${p.title || ''}`)} ${pill(prLabel(p), prTone(prState(p)))} <span style="color:${C.muted};">opened ${esc(formatIST(p.created_at))}</span></li>`
        )
        .join('')}</ul>`
    : emptyNote('No PR linked.');

  const commentHtml = comments.length
    ? comments
        .map(
          (c) =>
            `<div style="font-size:13px;margin:6px 0;padding:6px 10px;background:${C.bg};border-radius:6px;"><b>${esc(c.who)}</b> <span style="color:${C.muted};">${esc(c.when)}</span><br>${esc(c.text)}</div>`
        )
        .join('')
    : '';

  const html = section(
    `sc-${s.id}: ${s.name}`,
    `<div style="margin-bottom:8px;">${link(storyLink(s), 'Open in Shortcut')}</div>
<table role="presentation" cellpadding="0" cellspacing="0">${factRows}</table>
<div style="font-size:14px;font-weight:600;margin:12px 0 0 0;">Pull requests</div>${prHtml}
${desc ? `<div style="font-size:14px;font-weight:600;margin:12px 0 4px 0;">Description</div><div style="font-size:13px;color:${C.text};">${esc(desc.slice(0, 500))}${desc.length > 500 ? '…' : ''}</div>` : ''}
${commentHtml ? `<div style="font-size:14px;font-weight:600;margin:12px 0 0 0;">Latest comments</div>${commentHtml}` : ''}`
  );

  const text = [
    `sc-${s.id}: ${s.name}`,
    storyLink(s),
    `State: ${state.name}${isBlocked(ws, s) ? ' (BLOCKED)' : ''}`,
    `Owner: ${ownerNames(ws, s) || 'No owner'}`,
    `Raised by: ${personName(ws, s.requested_by_id) || '—'}`,
    `Sprint: ${iter || 'Not in a sprint'}`,
    `Estimate: ${s.estimate ?? 'Not estimated'}`,
    `Customer priority: ${customer ? 'Yes' : 'No'}`,
    `Created: ${formatIST(s.created_at)} · Updated: ${formatIST(s.updated_at)}`,
    'PRs: ' + (pr.prs.length ? pr.prs.map((p) => `${prLabel(p)} ${p.url}`).join(' ; ') : 'No PR'),
    ...(comments.length ? ['Latest comments:', ...comments.map((c) => `  ${c.who} (${c.when}): ${c.text}`)] : []),
  ].join('\n');

  return { title: `sc-${s.id}`, html, text };
}

async function sprintAnswer(ws) {
  const { iteration } = await findCurrentIteration(ws);
  const slim = (await sc.getIterationStories(iteration.id)).filter((s) => !s.archived);
  const p = sprintProgress(ws, iteration, slim);
  const pts = p.points ? ` · ${p.points.pct}% by points (${p.points.done}/${p.points.total})` : '';
  const line = `${p.name}: ${formatDay(p.startDate)} – ${formatDay(p.endDate)}, ${p.daysLeft} days left. Done ${p.done}, in progress ${p.started}, not started ${p.unstarted} of ${p.total} — ${p.pctCount}% complete${pts}.`;
  return {
    title: 'Sprint progress',
    html: section('Sprint progress', `<div style="font-size:14px;">${link(p.url, p.name)}</div><div style="font-size:14px;margin-top:4px;">${esc(line.slice(p.name.length + 2))}</div>`),
    text: line,
  };
}

async function flagsAnswer(ws) {
  const { iteration } = await findCurrentIteration(ws);
  const slim = (await sc.getIterationStories(iteration.id)).filter((s) => !s.archived);
  const full = await sc.getStoriesFull(slim.map((s) => s.id));
  const f = buildFlags(ws, full);
  const d = config.flags.staleDays;
  const groups = [
    [`In progress ${d}+ days with no PR`, f.staleNoPr],
    ['PR merged but story not Done', f.mergedNotDone],
    [`PRs open ${d}+ days`, f.oldOpenPrs],
    ['Blocked', f.blocked],
    ['No owner', f.noOwner],
    ['No estimate', f.noEstimate],
  ];
  const html = groups
    .map(([t, items]) =>
      section(
        `${t} (${items.length})`,
        items.length
          ? `<ul style="margin:0;padding-left:18px;">${items.map((r) => `<li style="font-size:13px;margin-bottom:3px;">${storyIdCell(r)} ${esc(r.title)} <span style="color:${C.muted};">· ${esc(r.owner || 'no owner')} · ${esc(r.state)}</span></li>`).join('')}</ul>`
          : emptyNote('None.')
      )
    )
    .join('');
  const text = groups
    .map(([t, items]) => `${t}: ${items.length}\n` + items.map((r) => `  - sc-${r.id} ${r.title} (${r.owner || 'no owner'}, ${r.state})`).join('\n'))
    .join('\n');
  return { title: `Needs attention in ${iteration.name}`, html, text };
}

async function newTicketsAnswer(ws) {
  const now = Date.now();
  const since = now - 24 * 3600 * 1000;
  const from = new Date(since - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const to = new Date(now + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const found = (await sc.searchStories(`created:${from}..${to}`)).filter((s) => new Date(s.created_at).getTime() >= since);
  const note = customerRuleConfigured() ? `${found.filter((s) => isCustomerPriority(ws, s)).length} of these are customer priority.` : '';
  return storyListAnswer(ws, 'Tickets created in the last 24 hours', found, { note });
}

async function searchAnswer(ws, question) {
  const words = (question.toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) || []).filter((w) => !STOP.has(w) && w.length > 1);
  if (!words.length) return null;
  const query = words.slice(0, 6).join(' ');
  let results;
  try {
    results = await sc.searchStories(`${query} !is:archived`, { max: 25 });
  } catch (err) {
    if (err.status === 400) results = [];
    else throw err;
  }
  return storyListAnswer(ws, `Search results for “${query}”`, results.slice(0, 15), {
    note: results.length >= 25 ? 'Many matches — add more words to narrow it down.' : '',
  });
}

export function helpAnswer() {
  const examples = [
    ['sc-1234  (or "status of 1234")', 'Full details of a ticket: state, owner, PRs, latest comments'],
    ['what is Priya working on', "A person's open tickets"],
    ['in progress', 'Everything currently in development, across all teams'],
    ['Ready in QA', 'Tickets in any workflow state, by its name'],
    ['backend bugs', 'Any label + story type'],
    ['Engineering team blocked', 'Any team, combined with blocked / in progress / done'],
    ['Severity 1 tickets  ·  Highest priority', 'Any Priority, Severity or other field value'],
    ['bugs in this sprint  ·  Squid Game done', 'Any sprint by name, or "this sprint"'],
    ['customer priority', 'Open customer-priority tickets'],
    ['sprint status', 'Current sprint progress'],
    ['needs attention', 'Flags for the current sprint (stale, no PR, no owner…)'],
    ['new tickets', 'Tickets created in the last 24 hours'],
    ['login timeout', 'Anything else is a keyword search across all tickets'],
  ];
  const html = section(
    'What you can ask',
    table(
      [{ title: 'Write' }, { title: 'You get' }],
      examples.map(([q, a]) => [`<b>${esc(q)}</b>`, esc(a)])
    ),
    'Mix and match freely, e.g. “Priya backend bugs in Ready in QA”. Labels, states, teams, sprints, epics and field values are read live from Shortcut, so new ones work automatically.'
  );
  const text = 'WHAT YOU CAN ASK\n' + examples.map(([q, a]) => `- ${q}: ${a}`).join('\n');
  return { title: 'Help', html, text };
}

// ---------- Workspace vocabulary (learned live, nothing hard-coded) ----------

// Words that are handled as intents rather than as names.
const INTENT_WORDS = new Set(['started', 'done', 'completed', 'unstarted', 'to-do', 'todo', 'blocked', 'build']);
const KIND_ORDER = ['state', 'label', 'team', 'iteration', 'epic', 'type', 'field'];

let vocabPromise;
function vocabulary(ws) {
  vocabPromise ||= (async () => {
    const [iters, epics] = await Promise.all([sc.getIterations(), sc.getEpics().catch(() => [])]);
    const terms = [];
    const add = (kind, name, extra = {}) => {
      const phrase = String(name || '').trim().toLowerCase();
      if (phrase.length < 3 || !/[a-z]/.test(phrase) || STOP.has(phrase) || INTENT_WORDS.has(phrase)) return;
      terms.push({ kind, name: String(name).trim(), phrase, ...extra });
    };
    new Set([...ws.states.values()].map((s) => s.name.trim())).forEach((n) => add('state', n));
    ws.labels.filter((l) => !l.archived).forEach((l) => add('label', l.name));
    for (const g of ws.teams.values()) if (!g.archived) add('team', g.name);
    iters.forEach((i) => add('iteration', i.name));
    epics.filter((e) => !e.archived && e.name && e.name.length >= 5).forEach((e) => add('epic', e.name));
    for (const t of ['bug', 'feature', 'chore']) {
      add('type', t);
      add('type', t + 's', { value: t });
    }
    for (const f of ws.customFields) {
      if (f.enabled === false) continue;
      for (const v of f.values || []) add('field', v.value, { field: f.name, valueId: v.id });
    }
    return terms;
  })();
  return vocabPromise;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Find workspace names mentioned in the question. Longer names win over shorter ones inside them.
function findTerms(vocab, lower, people) {
  const personWords = new Set(
    people.flatMap((p) => [p.name.toLowerCase(), p.name.toLowerCase().split(/\s+/)[0], p.mention.toLowerCase()])
  );
  const hits = [];
  for (const t of vocab) {
    if (personWords.has(t.phrase)) continue;
    const re = new RegExp(`(?<![a-z0-9])${escapeRe(t.phrase)}(?![a-z0-9])`, 'g');
    let m;
    while ((m = re.exec(lower))) hits.push({ ...t, start: m.index, end: m.index + t.phrase.length });
  }
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const taken = [];
  for (const h of hits) {
    if (taken.some((t) => h.start < t.end && t.start < h.end)) continue;
    taken.push(h);
  }
  return taken;
}

function q(value) {
  return `"${String(value).replace(/"/g, '')}"`;
}

// Words that only shape the question, not what to search for.
const FILLER = new Set(
  `label labels tagged tag state states stage column team teams sprint sprints iteration epic epics type types field fields
  priority severity open opened pending assigned owned owner owners working work doing progress dev development wip ongoing
  done completed finished closed shipped all everything items cards ones count many much number how has have having marked under
  customer customers blocked blocking blocker stuck`.split(/\s+/)
);

async function filteredAnswer(ws, ctx) {
  const { lower, terms, people, wantsCustomer, wantsBlocked, wantsProgress, wantsDone, wantsAll } = ctx;
  const ops = [];
  const desc = [];
  const fieldFilters = new Map(); // field -> Set(valueId)
  let hasState = false;

  for (const t of terms) {
    if (t.kind === 'state') {
      ops.push(`state:${q(t.name)}`);
      hasState = true;
    } else if (t.kind === 'label') ops.push(`label:${q(t.name)}`);
    else if (t.kind === 'team') ops.push(`team:${q(t.name)}`);
    else if (t.kind === 'iteration') ops.push(`iteration:${q(t.name)}`);
    else if (t.kind === 'epic') ops.push(`epic:${q(t.name)}`);
    else if (t.kind === 'type') ops.push(`type:${t.value || t.phrase}`);
    else if (t.kind === 'field') {
      if (!fieldFilters.has(t.field)) fieldFilters.set(t.field, new Set());
      fieldFilters.get(t.field).add(t.valueId);
    }
    desc.push(
      t.kind === 'field'
        ? `${t.field}: ${t.name}`
        : t.kind === 'type'
          ? `${t.value || t.phrase}s`
          : `${t.kind === 'iteration' ? 'sprint' : t.kind} “${t.name}”`
    );
  }

  if (/\b(this|current) (sprint|iteration)\b/.test(lower) && !terms.some((t) => t.kind === 'iteration')) {
    try {
      const { iteration } = await findCurrentIteration(ws);
      ops.push(`iteration:${q(iteration.name)}`);
      desc.push(`sprint “${iteration.name}”`);
    } catch {
      /* no current sprint: ignore */
    }
  }
  if (wantsBlocked) {
    ops.push('is:blocked');
    desc.push('blocked');
  }
  if (wantsProgress && !hasState) {
    ops.push('is:started');
    desc.push('in progress');
  }
  if (wantsDone && !hasState) {
    ops.push('is:done');
    desc.push('done');
  }

  const positive = ops.length > 0;
  if (!hasState && !wantsDone && !wantsAll) ops.push('!is:done');
  ops.push('!is:archived');

  // Optional extra keywords, e.g. "backend login errors" -> label backend + "login errors".
  const used = new Set(terms.flatMap((t) => t.phrase.split(/\s+/)));
  people.forEach((p) => p.name.toLowerCase().split(/\s+/).concat(p.mention.toLowerCase()).forEach((w) => used.add(w)));
  const extra = (lower.match(/[a-z][a-z0-9'_-]*/g) || []).filter(
    (w) => w.length > 2 && !STOP.has(w) && !FILLER.has(w) && !used.has(w) && !used.has(w.replace(/s$/, ''))
  );

  const owners = people.length ? people.slice(0, 3) : [null];
  const parts = [];
  for (const person of owners) {
    const ownerOp = person?.mention ? [`owner:${person.mention}`] : [];
    let list;
    if (!positive && !person) {
      list = wantsAll || wantsDone ? await sc.searchStories('!is:archived', { max: 300 }) : await openStories();
    } else {
      const base = [...ownerOp, ...ops];
      list = extra.length ? await sc.searchStories([...extra.slice(0, 4), ...base].join(' '), { max: 300 }).catch(() => []) : [];
      if (!list.length) list = await sc.searchStories(base.join(' '), { max: 300 });
      else desc.push(`matching “${extra.slice(0, 4).join(' ')}”`);
    }
    for (const ids of fieldFilters.values()) list = list.filter((s) => (s.custom_fields || []).some((cf) => ids.has(cf.value_id)));
    if (wantsCustomer) {
      if (customerRuleConfigured()) list = list.filter((s) => isCustomerPriority(ws, s));
      if (!desc.includes('customer priority')) desc.push('customer priority');
    }
    const status = wantsDone || hasState || wantsAll || wantsProgress || wantsBlocked ? '' : 'Open';
    const label = desc.length ? desc.join(' · ') : 'tickets';
    const title = person ? `${person.name}: ${status ? status.toLowerCase() + ' ' : ''}${label}` : `${status ? status + ' ' : ''}${label}`;
    parts.push(
      await storyListAnswer(ws, title.charAt(0).toUpperCase() + title.slice(1), list, {
        showOwner: !person,
        note: list.length >= 300 ? 'Over 300 matches — add more detail to narrow it down.' : '',
      })
    );
  }
  return parts;
}

// ---------- Main entry ----------

export async function answerQuestion(rawQuestion) {
  const question = String(rawQuestion || '').trim().slice(0, 1000);
  const lower = question.toLowerCase();
  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  if (!question || /^(help|hi|hello|hey|\?|commands|menu)\W*$/.test(lower)) return finish(question, [helpAnswer()]);

  const ws = await workspace();
  const parts = [];

  const ids = extractStoryIds(question, wordCount);
  if (ids.length) {
    for (const id of ids) parts.push(await storyDetail(ws, id));
    return finish(question, parts);
  }

  const people = findPeople(ws, lower);
  const wantsCustomer = has(lower, /\bcustomer/) && customerRuleConfigured();
  let terms = findTerms(await vocabulary(ws), lower, people);
  // "customer priority" uses the configured customer rule rather than a single state/label.
  if (wantsCustomer) terms = terms.filter((t) => !t.phrase.includes('customer'));

  const ctx = {
    lower,
    terms,
    people,
    wantsCustomer,
    wantsBlocked: has(lower, /\bblock(ed|ing|er)?\b/),
    wantsProgress: has(lower, /\b(in[ -]?progress|in[ -]?dev(elopment)?|wip|working|ongoing|started|doing)\b/),
    wantsDone: has(lower, /\b(done|completed|finished|closed|shipped)\b/),
    wantsAll: has(lower, /\b(all|every|everything)\b/),
  };
  const anyFilter = terms.length || people.length || wantsCustomer || ctx.wantsBlocked || ctx.wantsProgress || ctx.wantsDone;

  const wantsFlags = has(lower, /\b(attention|flags?|risks?|stale|overdue|no pr)\b/);
  const wantsSprint = has(lower, /\b(sprint|iteration)\b/) && has(lower, /\b(progress|status|how|summary|update)\b/);
  const wantsNew = has(lower, /\b(new|raised|created|last 24|yesterday)\b/);

  if (wantsFlags && !terms.length && !people.length) parts.push(await flagsAnswer(ws));
  else if (wantsSprint && !terms.length && !people.length) parts.push(await sprintAnswer(ws));
  else if (wantsNew && !terms.length && !people.length) parts.push(await newTicketsAnswer(ws));
  else if (anyFilter) parts.push(...(await filteredAnswer(ws, ctx)));
  else if (/^\s*(sprint|iteration|current sprint)\W*$/.test(lower)) parts.push(await sprintAnswer(ws));
  else {
    const found = await searchAnswer(ws, question);
    parts.push(found || helpAnswer());
  }
  return finish(question, parts);
}

function finish(question, parts) {
  const title = parts.map((p) => p.title).join(' · ');
  const intro = question
    ? `<tr><td style="padding:18px 20px 0 20px;font-size:13px;color:${C.muted};">You asked: <i>${esc(question.slice(0, 300))}</i></td></tr>`
    : '';
  const html = page({
    title,
    bodyRows: intro + parts.map((p) => p.html).join(''),
    footer: 'Reply to ask another question. Send “help” to see examples. Answers come straight from Shortcut; times are IST.',
  });
  const text = parts.map((p) => p.text).join('\n\n') + '\n\nReply to ask another question. Send "help" for examples.';
  return { title, html, text };
}
