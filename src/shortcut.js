// Small Shortcut REST API v3 client: auth, rate limiting, retries, pagination.
import { config, requireShortcut } from './config.js';

const BASE = 'https://api.app.shortcut.com';
const API = `${BASE}/api/v3`;

// Shortcut allows about 200 requests/minute. Space requests ~320ms apart to stay under it.
const MIN_GAP_MS = 320;
const MAX_RETRIES = 5;

export class ShortcutError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let nextSlot = 0;
async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function friendlyError(status, path) {
  if (status === 401 || status === 403) {
    return (
      'Shortcut rejected the API token (HTTP ' + status + '). ' +
      'Check SHORTCUT_API_TOKEN: copy it again from Shortcut > Settings > Your Account > API Tokens, ' +
      'with no extra spaces or quotes.'
    );
  }
  if (status === 404) return `Shortcut could not find ${path} (HTTP 404).`;
  return `Shortcut API request to ${path} failed (HTTP ${status}).`;
}

export async function request(pathOrUrl) {
  requireShortcut();
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : pathOrUrl.startsWith('/api/')
      ? BASE + pathOrUrl
      : API + pathOrUrl;
  const shortPath = url.replace(BASE, '').split('?')[0];

  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          'Shortcut-Token': config.shortcutToken,
        },
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        throw new ShortcutError(`Could not reach Shortcut (${err.message}). Check your internet connection.`);
      }
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }
    throw new ShortcutError(friendlyError(res.status, shortPath), res.status);
  }
}

function backoff(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

// Runs fn over items with at most `limit` running at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- Endpoints ----

export const getIterations = () => request('/iterations');
export const getIterationStories = (id) => request(`/iterations/${id}/stories?includes_description=false`);
export const getStory = (id) => request(`/stories/${id}`);
export const getMembers = () => request('/members');
export const getWorkflows = () => request('/workflows');
export const getLabels = () => request('/labels?slim=true');
export const getCustomFields = () => request('/custom-fields');
export const getGroups = () => request('/groups');
export const getEpics = () => request('/epics');

// Story search with pagination. Shortcut caps search results at 1000.
export async function searchStories(query, { max = 1000 } = {}) {
  const params = new URLSearchParams({ query, detail: 'slim', page_size: '25' });
  let next = `/search/stories?${params}`;
  const out = [];
  while (next && out.length < max) {
    const page = await request(next);
    out.push(...(page.data || []));
    next = page.next || null;
  }
  return out.slice(0, max);
}

// Fetch full story details (with PRs) for many stories, a few at a time.
export function getStoriesFull(ids) {
  return mapLimit(ids, 4, (id) => getStory(id));
}
