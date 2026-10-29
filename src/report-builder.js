// Gathers all data for the daily report. No formatting here — see email-template.js.
import * as sc from './shortcut.js';
import { config, customerRuleConfigured } from './config.js';
import {
  loadWorkspace,
  ownerNames,
  personName,
  stateOf,
  isDone,
  storyLink,
  prSummary,
  pullRequestsOf,
  prState,
  isCustomerPriority,
  daysSince,
  isBlocked,
  mergedIsExpected,
  searchOpenStories,
} from './workspace.js';
import { todayIST, daysBetween, ymdUTC } from './time.js';

export class NoIterationError extends Error {}

export async function findCurrentIteration(ws, now = new Date()) {
  const today = todayIST(now);
  let iterations = (await sc.getIterations()).filter(
    (it) => it.status === 'started' && it.start_date <= today && today <= it.end_date
  );

  if (config.iterationTeam && iterations.length) {
    const want = config.iterationTeam.toLowerCase();
    const teamIds = [...ws.teams.values()]
      .filter((g) => g.name.toLowerCase() === want || (g.mention_name || '').toLowerCase() === want)
      .map((g) => g.id);
    iterations = iterations.filter((it) => (it.group_ids || []).some((id) => teamIds.includes(id)));
  }

  if (!iterations.length) {
    throw new NoIterationError(
      `No current sprint found: no iteration has status "started" with dates covering today (${today}, IST).` +
        (config.iterationTeam ? ` (Filtered to team "${config.iterationTeam}".)` : '') +
        ' Check in Shortcut that the current iteration is started and its dates are correct.'
    );
  }

  // If several teams have sprints running, use the one that started most recently.
  iterations.sort((a, b) => b.start_date.localeCompare(a.start_date));
  return { iteration: iterations[0], others: iterations.slice(1) };
}

export function storyRow(ws, story) {
  const state = stateOf(ws, story);
  const pr = prSummary(story);
  return {
    id: story.id,
    url: storyLink(story),
    title: story.name,
    owner: ownerNames(ws, story),
    ownerIds: story.owner_ids || [],
    state: state.name,
    stateOrder: state.order ?? 999,
    stateType: isDone(ws, story) ? 'done' : state.type === 'started' ? 'started' : 'unstarted',
    estimate: story.estimate ?? null,
    pr,
    blocked: isBlocked(ws, story),
    createdAt: story.created_at,
    startedAt: story.started_at,
  };
}

// Stories grouped by person (a story with two owners appears under both).
// Every active member is included; people with no tickets are returned separately in `idle`.
export function workByPerson(ws, rows) {
  const groups = new Map();
  const add = (key, name, row) => {
    if (!groups.has(key)) groups.set(key, { name, rows: [] });
    groups.get(key).rows.push(row);
  };
  for (const r of rows) {
    if (!r.ownerIds.length) add('_none', 'No owner', r);
    else r.ownerIds.forEach((id) => add(id, personName(ws, id), r));
  }
  const people = [...groups.entries()]
    .sort(([ka, a], [kb, b]) => (ka === '_none') - (kb === '_none') || a.name.localeCompare(b.name))
    .map(([, g]) => {
      const rows = [...g.rows].sort((a, b) => a.stateOrder - b.stateOrder || a.id - b.id);
      return { name: g.name, rows, byState: countByState(rows) };
    });
  const idle = [...ws.people.entries()]
    .filter(([id, p]) => !p.inactive && !groups.has(id))
    .map(([, p]) => p.name)
    .sort((a, b) => a.localeCompare(b));
  return { people, idle };
}

// Every open customer-priority ticket in the workspace (not only this sprint).
export async function openCustomerTickets(ws) {
  if (!customerRuleConfigured()) return [];
  const matches = (await searchOpenStories()).filter((s) => isCustomerPriority(ws, s));
  const full = matches.length <= 60 ? await sc.getStoriesFull(matches.map((s) => s.id)) : matches;
  return full
    .map((s) => ({ ...storyRow(ws, s), requester: personName(ws, s.requested_by_id) }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// [{ name, type, count }] in the order the states appear on the Shortcut board.
export function countByState(rows) {
  const m = new Map();
  for (const r of rows) {
    const cur = m.get(r.state) || { name: r.state, type: r.stateType, order: r.stateOrder, count: 0 };
    cur.count++;
    cur.order = Math.min(cur.order, r.stateOrder);
    m.set(r.state, cur);
  }
  return [...m.values()].sort((a, b) => a.order - b.order);
}

export function sprintProgress(ws, iteration, stories, now = new Date()) {
  const today = todayIST(now);
  const counts = { done: 0, started: 0, unstarted: 0 };
  let pointsTotal = 0;
  let pointsDone = 0;
  let anyEstimate = false;
  for (const s of stories) {
    const type = isDone(ws, s) ? 'done' : stateOf(ws, s).type === 'started' ? 'started' : 'unstarted';
    counts[type]++;
    if (typeof s.estimate === 'number') {
      anyEstimate = true;
      pointsTotal += s.estimate;
      if (type === 'done') pointsDone += s.estimate;
    }
  }
  const total = stories.length;
  return {
    name: iteration.name,
    url: iteration.app_url,
    startDate: iteration.start_date,
    endDate: iteration.end_date,
    daysLeft: Math.max(0, daysBetween(today, iteration.end_date)),
    total,
    ...counts,
    pctCount: total ? Math.round((counts.done / total) * 100) : 0,
    points: anyEstimate
      ? { done: pointsDone, total: pointsTotal, pct: pointsTotal ? Math.round((pointsDone / pointsTotal) * 100) : 0 }
      : null,
  };
}

export function buildFlags(ws, stories, now = Date.now()) {
  const stale = config.flags.staleDays;
  const flags = {
    staleNoPr: [],
    mergedNotDone: [],
    oldOpenPrs: [],
    blocked: [],
    noOwner: [],
    noEstimate: [],
  };

  for (const s of stories) {
    const done = isDone(ws, s);
    const state = stateOf(ws, s);
    const row = storyRow(ws, s);
    const prs = pullRequestsOf(s);

    if (!done && state.type === 'started' && prs.length === 0) {
      const days = daysSince(s.started_at || s.moved_at, now);
      if (days !== null && days >= stale) flags.staleNoPr.push({ ...row, days });
    }

    if (!done && !mergedIsExpected(ws, s) && prs.some((p) => prState(p) === 'merged')) flags.mergedNotDone.push(row);

    for (const pr of prs) {
      const st = prState(pr);
      if (st === 'open' || st === 'draft') {
        const days = daysSince(pr.created_at, now);
        if (days !== null && days >= stale) flags.oldOpenPrs.push({ ...row, pr, days });
      }
    }

    if (!done && row.blocked) flags.blocked.push(row);
    if (!done && !(s.owner_ids || []).length) flags.noOwner.push(row);
    if (!done && (s.estimate === null || s.estimate === undefined)) flags.noEstimate.push(row);
  }
  return flags;
}

// Customer-priority tickets created in the last 24 hours (anywhere in the workspace).
export async function newCustomerTickets(ws, now = new Date()) {
  if (!customerRuleConfigured()) return { configured: false, items: [] };
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  // Search a slightly wider date window, then filter to the exact 24 hours.
  const from = ymdUTC(new Date(since - 24 * 60 * 60 * 1000));
  const to = ymdUTC(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const found = await sc.searchStories(`created:${from}..${to}`);
  const items = found
    .filter((s) => new Date(s.created_at).getTime() >= since)
    .filter((s) => isCustomerPriority(ws, s))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((s) => ({
      ...storyRow(ws, s),
      requester: personName(ws, s.requested_by_id),
      createdAt: s.created_at,
    }));
  return { configured: true, items };
}

export async function buildReport(now = new Date()) {
  const ws = await loadWorkspace();
  const { iteration, others } = await findCurrentIteration(ws, now);
  const slim = (await sc.getIterationStories(iteration.id)).filter((s) => !s.archived);
  const full = await sc.getStoriesFull(slim.map((s) => s.id));

  const rows = full
    .map((s) => storyRow(ws, s))
    .sort((a, b) => a.stateOrder - b.stateOrder || a.id - b.id);

  // Everyone's open work anywhere in Shortcut, not only this sprint.
  const sprintIds = new Set(full.map((s) => s.id));
  const outside = (await searchOpenStories()).filter((s) => !sprintIds.has(s.id));
  // Full details (for PR status) only for in-progress tickets; not-started ones are shown as links.
  const startedIds = outside.filter((s) => stateOf(ws, s).type === 'started').map((s) => s.id);
  const startedFull = new Map((await sc.getStoriesFull(startedIds)).map((s) => [s.id, s]));
  const outsideRows = outside.map((s) => ({ ...storyRow(ws, startedFull.get(s.id) || s), outsideSprint: true }));

  const newCustomer = await newCustomerTickets(ws, now);
  const newIds = new Set(newCustomer.items.map((r) => r.id));

  return {
    generatedAt: now.toISOString(),
    progress: { ...sprintProgress(ws, iteration, full, now), byState: countByState(rows) },
    otherIterations: others.map((i) => i.name),
    stories: rows,
    byPerson: workByPerson(ws, rows.concat(outsideRows)),
    newCustomer,
    openCustomer: (await openCustomerTickets(ws)).map((r) => ({ ...r, isNew: newIds.has(r.id) })),
    flags: buildFlags(ws, full, now.getTime()),
    staleDays: config.flags.staleDays,
  };
}
