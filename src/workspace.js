// Loads workspace lookups (people, workflow states, labels, fields, teams)
// and provides helpers shared by the report and the chat assistant.
import * as sc from './shortcut.js';
import { config } from './config.js';

const DAY = 24 * 60 * 60 * 1000;

export async function loadWorkspace() {
  const [members, workflows, labels, customFields, groups] = await Promise.all([
    sc.getMembers(),
    sc.getWorkflows(),
    sc.getLabels(),
    sc.getCustomFields(),
    sc.getGroups(),
  ]);

  const people = new Map();
  for (const m of members) {
    people.set(m.id, {
      name: m.profile?.name || m.profile?.mention_name || 'Unknown',
      mention: m.profile?.mention_name || '',
      email: m.profile?.email_address || '',
      inactive: Boolean(m.profile?.deactivated || m.disabled),
    });
  }

  // Keep each workflow's own column order so reports list states the way the board shows them.
  const states = new Map();
  let order = 0;
  for (const wf of workflows) {
    const sorted = [...(wf.states || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const s of sorted) {
      states.set(s.id, { name: s.name.trim(), type: s.type, workflow: wf.name, order: order++ });
    }
  }

  const fieldValues = new Map(); // value_id -> { field, value }
  for (const f of customFields) {
    for (const v of f.values || []) fieldValues.set(v.id, { field: f.name, canonical: f.canonical_name, value: v.value });
  }

  const teams = new Map(groups.map((g) => [g.id, g]));

  return { people, states, labels, customFields, fieldValues, teams };
}

export function personName(ws, id) {
  if (!id) return '';
  return ws.people.get(id)?.name || 'Unknown';
}

export function ownerNames(ws, story) {
  const ids = story.owner_ids || [];
  return ids.map((id) => personName(ws, id)).join(', ');
}

export function stateOf(ws, story) {
  return ws.states.get(story.workflow_state_id) || { name: 'Unknown', type: 'unknown' };
}

function inList(name, list) {
  const n = String(name || '').trim().toLowerCase();
  return list.some((x) => x.toLowerCase() === n);
}

export function isDone(ws, story) {
  const state = stateOf(ws, story);
  return state.type === 'done' || story.completed === true || inList(state.name, config.doneStates);
}

export function mergedIsExpected(ws, story) {
  return inList(stateOf(ws, story).name, config.mergedOkStates);
}

// All not-done, not-archived stories in the workspace (cached for one run).
let openCache;
export function searchOpenStories() {
  openCache ||= fetchOpenStories();
  return openCache;
}
async function fetchOpenStories() {
  const [a, b] = await Promise.all([
    sc.searchStories('is:started !is:archived'),
    sc.searchStories('is:unstarted !is:archived'),
  ]);
  const m = new Map();
  [...a, ...b].forEach((s) => m.set(s.id, s));
  return [...m.values()];
}

// Short story link (drops the long title slug Shortcut adds to the URL).
export function storyLink(story) {
  const url = story.app_url || `https://app.shortcut.com/story/${story.id}`;
  return url.replace(/(\/story\/\d+).*$/, '$1');
}

// ---- Pull requests ----

// Collect PRs from the story and its branches, without duplicates.
export function pullRequestsOf(story) {
  const seen = new Map();
  const add = (pr) => {
    if (!pr) return;
    const key = pr.url || `id:${pr.id}`;
    if (!seen.has(key)) seen.set(key, pr);
  };
  (story.pull_requests || []).forEach(add);
  for (const b of story.branches || []) (b.pull_requests || []).forEach(add);
  return [...seen.values()];
}

export function prState(pr) {
  if (pr.merged) return 'merged';
  if (pr.closed) return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

const PR_LABEL = {
  none: 'No PR',
  open: 'PR open',
  draft: 'PR draft',
  merged: 'PR merged',
  closed: 'PR closed (not merged)',
};

// One overall status per story. Open work wins over finished work.
export function prSummary(story) {
  const prs = pullRequestsOf(story);
  const statesSeen = new Set(prs.map(prState));
  let key = 'none';
  for (const k of ['open', 'draft', 'merged', 'closed']) {
    if (statesSeen.has(k)) {
      key = k;
      break;
    }
  }
  return { key, label: PR_LABEL[key], prs };
}

export function prLabel(pr) {
  return PR_LABEL[prState(pr)];
}

// ---- Customer priority ----

function lc(s) {
  return String(s || '').trim().toLowerCase();
}

export function isCustomerPriority(ws, story) {
  const c = config.customer;

  if (c.labels.length) {
    const wanted = new Set(c.labels.map(lc));
    const names = (story.labels || []).map((l) => lc(l.name));
    if (!names.length && story.label_ids) {
      const byId = new Map(ws.labels.map((l) => [l.id, l.name]));
      story.label_ids.forEach((id) => names.push(lc(byId.get(id))));
    }
    if (names.some((n) => wanted.has(n))) return true;
  }

  if (c.priorityValues.length) {
    const wanted = new Set(c.priorityValues.map(lc));
    for (const cf of story.custom_fields || []) {
      const info = ws.fieldValues.get(cf.value_id);
      const isPriority = info && (info.canonical === 'priority' || lc(info.field) === 'priority');
      if (isPriority && wanted.has(lc(cf.value || info.value))) return true;
    }
  }

  if (c.storyTypes.length && c.storyTypes.map(lc).includes(lc(story.story_type))) return true;

  if (c.states.length && c.states.map(lc).includes(lc(stateOf(ws, story).name))) return true;

  if (c.teams.length && story.group_id) {
    const team = ws.teams.get(story.group_id);
    const wanted = c.teams.map(lc);
    if (team && (wanted.includes(lc(team.name)) || wanted.includes(lc(team.mention_name)))) return true;
  }

  return false;
}

// ---- Time helpers ----

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  return Math.floor((now - new Date(iso).getTime()) / DAY);
}

export function isBlocked(ws, story) {
  if (story.blocked) return true;
  if (/block/i.test(stateOf(ws, story).name)) return true;
  return (story.labels || []).some((l) => /^blocked?$/i.test(l.name || ''));
}
