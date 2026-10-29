/**
 * Shortcut daily team report + email assistant (Google Apps Script version)
 * --------------------------------------------------------------------------
 * Paste this whole file into script.google.com (see apps-script/SETUP.md).
 * No passwords: it sends and reads email through the Google account that owns the script.
 *
 * Functions you can run from the toolbar:
 *   setup            – checks the token, schedules everything, emails you a preview
 *   previewReport    – emails the report to YOU only
 *   testQuestion     – answers SETTINGS.TEST_QUESTION and emails the answer to you
 *   sendDailyReport  – sends the real report to the recipients now
 *   checkQuestions   – answers emailed questions now (also runs automatically)
 *   removeTriggers   – stops all automatic runs
 */

// ===================== SETTINGS: edit these =====================
const SETTINGS = {
  // Who gets the daily report (comma-separated)
  REPORT_RECIPIENTS: 'shreedevi@adhish.in, vijaysudarsanam78@gmail.com',
  // Time to send, India time (24-hour clock). Google may run it up to 15 min early or late.
  SEND_HOUR_IST: 10,
  SEND_MINUTE: 30,
  REPORT_SUBJECT: 'Shortcut Daily Report',
  FROM_NAME: 'Shortcut Daily Report',

  // Customer priority: a ticket counts if it matches ANY of these (comma-separated names)
  CUSTOMER_LABELS: 'CustomerIssue',
  CUSTOMER_STATES: 'Customer Priority',
  CUSTOMER_PRIORITY_VALUES: '', // e.g. 'Highest,High'
  CUSTOMER_STORY_TYPES: '', // e.g. 'bug'
  CUSTOMER_TEAMS: '', // e.g. 'Customer Success'

  // If several teams run sprints at once, the team whose sprint to report on
  ITERATION_TEAM: '',
  // Days before "in progress with no PR" and "PR open" are flagged
  FLAG_STALE_DAYS: 3,
  // Extra statuses that count as finished (default: only Shortcut "done" statuses like Completed)
  DONE_STATES: '',
  // Statuses where a merged PR is normal, so it isn't flagged (e.g. 'Ready in QA,Completed in QA')
  MERGED_OK_STATES: '',

  // Email assistant (reply-to-ask). Needs full Gmail permission, which some Google accounts block.
  // Keep false unless your account allows it; then also add the Gmail scope in appsscript.json.
  CHAT_ENABLED: false,
  // Who may ask questions (addresses or '@adhish.in'). Empty = the report recipients.
  CHAT_ALLOWED_SENDERS: '',
  // How often to check for questions: 1, 5, 10, 15 or 30 minutes
  CHAT_CHECK_MINUTES: 5,

  // Used by testQuestion
  TEST_QUESTION: 'what is vijay working on',
};
// ================================================================

// ---- Functions you can run (shown in the toolbar dropdown) ----

function setup() {
  App.checkToken();
  removeTriggers();
  ScriptApp.newTrigger('sendDailyReport')
    .timeBased()
    .atHour(Number(SETTINGS.SEND_HOUR_IST))
    .nearMinute(Number(SETTINGS.SEND_MINUTE) || 0)
    .everyDays(1)
    .inTimezone(App.TZ)
    .create();
  if (SETTINGS.CHAT_ENABLED) {
    ScriptApp.newTrigger('checkQuestions').timeBased().everyMinutes(Number(SETTINGS.CHAT_CHECK_MINUTES)).create();
    App.startChat();
  }
  Logger.log('Scheduled: report on weekdays around %s:%s IST%s.', SETTINGS.SEND_HOUR_IST, ('0' + (SETTINGS.SEND_MINUTE || 0)).slice(-2),
    SETTINGS.CHAT_ENABLED ? ', questions checked every ' + SETTINGS.CHAT_CHECK_MINUTES + ' min' : '');
  previewReport();
}

function previewReport() {
  const me = Session.getEffectiveUser().getEmail();
  App.sendReport([me], '[PREVIEW] ');
  Logger.log('Preview emailed to %s. Check your inbox.', me);
}

function sendDailyReport() {
  // Weekdays only (India time). 1 = Monday ... 7 = Sunday.
  const day = Number(Utilities.formatDate(new Date(), App.TZ, 'u'));
  if (day > 5) return Logger.log('Weekend: no report.');
  App.sendReport(App.list(SETTINGS.REPORT_RECIPIENTS), '');
}

function testQuestion() {
  const answer = App.answerQuestion(SETTINGS.TEST_QUESTION);
  Logger.log(answer.text);
  const me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: me, subject: '[TEST] ' + SETTINGS.TEST_QUESTION, body: answer.text, htmlBody: answer.html, name: SETTINGS.FROM_NAME });
}

function checkQuestions() {
  App.checkQuestions();
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
}

// =================================================================
// Everything below is the engine. You shouldn't need to change it.
// =================================================================
const App = (function () {
  const TZ = 'Asia/Kolkata';
  const BASE = 'https://api.app.shortcut.com';
  const API = BASE + '/api/v3';
  const DAY = 24 * 60 * 60 * 1000;

  function list(v) {
    return String(v || '')
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }
  function lc(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  const CFG = {
    customer: {
      labels: list(SETTINGS.CUSTOMER_LABELS),
      states: list(SETTINGS.CUSTOMER_STATES),
      priorityValues: list(SETTINGS.CUSTOMER_PRIORITY_VALUES),
      storyTypes: list(SETTINGS.CUSTOMER_STORY_TYPES),
      teams: list(SETTINGS.CUSTOMER_TEAMS),
    },
    staleDays: Number(SETTINGS.FLAG_STALE_DAYS) || 3,
    doneStates: list(SETTINGS.DONE_STATES),
    mergedOkStates: list(SETTINGS.MERGED_OK_STATES),
  };
  function customerRuleConfigured() {
    const c = CFG.customer;
    return c.labels.length + c.states.length + c.priorityValues.length + c.storyTypes.length + c.teams.length > 0;
  }

  // ---------------- Shortcut API ----------------

  function token() {
    const t = (PropertiesService.getScriptProperties().getProperty('SHORTCUT_API_TOKEN') || '').trim();
    if (!t) {
      throw new Error('SHORTCUT_API_TOKEN is missing. Add it in Project Settings (gear icon) > Script Properties.');
    }
    return t;
  }

  function friendly(code, path) {
    if (code === 401 || code === 403) {
      return 'Shortcut rejected the API token (HTTP ' + code + '). Copy it again from Shortcut > Settings > Your Account > API Tokens into Script Properties, with no spaces or quotes.';
    }
    if (code === 404) return 'Shortcut could not find ' + path + ' (HTTP 404).';
    return 'Shortcut request to ' + path + ' failed (HTTP ' + code + ').';
  }

  function fullUrl(path) {
    if (path.indexOf('http') === 0) return path;
    if (path.indexOf('/api/') === 0) return BASE + path;
    return API + path;
  }

  // Shortcut allows ~200 requests/minute; keep requests ~320 ms apart.
  let lastCall = 0;
  function throttle(n) {
    const wait = lastCall + 320 * (n || 1) - Date.now();
    if (wait > 0) Utilities.sleep(wait);
    lastCall = Date.now();
  }
  function backoff(attempt) {
    return Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 500);
  }
  function options() {
    return { headers: { 'Shortcut-Token': token() }, muteHttpExceptions: true };
  }

  function request(path) {
    const url = fullUrl(path);
    for (let attempt = 0; ; attempt++) {
      throttle(1);
      let res;
      try {
        res = UrlFetchApp.fetch(url, options());
      } catch (e) {
        if (attempt >= 4) throw new Error('Could not reach Shortcut: ' + e.message);
        Utilities.sleep(backoff(attempt));
        continue;
      }
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) return JSON.parse(res.getContentText());
      if ((code === 429 || code >= 500) && attempt < 5) {
        const ra = Number(res.getHeaders()['Retry-After']);
        Utilities.sleep(ra > 0 ? ra * 1000 : backoff(attempt));
        continue;
      }
      const err = new Error(friendly(code, url.replace(BASE, '').split('?')[0]));
      err.status = code;
      throw err;
    }
  }

  // Fetch many paths a few at a time; anything that fails is retried one by one.
  function requestMany(paths) {
    const out = new Array(paths.length);
    const BATCH = 6;
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH);
      throttle(chunk.length);
      const opts = options();
      const responses = UrlFetchApp.fetchAll(chunk.map(function (p) {
        return { url: fullUrl(p), headers: opts.headers, muteHttpExceptions: true };
      }));
      responses.forEach(function (res, j) {
        const code = res.getResponseCode();
        out[i + j] = code >= 200 && code < 300 ? JSON.parse(res.getContentText()) : request(chunk[j]);
      });
    }
    return out;
  }

  const sc = {
    iterations: function () { return request('/iterations'); },
    iterationStories: function (id) { return request('/iterations/' + id + '/stories?includes_description=false'); },
    story: function (id) { return request('/stories/' + id); },
    storiesFull: function (ids) { return requestMany(ids.map(function (id) { return '/stories/' + id; })); },
    members: function () { return request('/members'); },
    workflows: function () { return request('/workflows'); },
    labels: function () { return request('/labels?slim=true'); },
    customFields: function () { return request('/custom-fields'); },
    groups: function () { return request('/groups'); },
    epics: function () { return request('/epics'); },
    search: function (query, max) {
      max = max || 1000;
      let next = '/search/stories?query=' + encodeURIComponent(query) + '&detail=slim&page_size=25';
      const out = [];
      while (next && out.length < max) {
        const page = request(next);
        Array.prototype.push.apply(out, page.data || []);
        next = page.next || null;
      }
      return out.slice(0, max);
    },
  };

  function checkToken() {
    sc.members();
    Logger.log('Shortcut token works.');
  }

  // ---------------- Time (India) ----------------

  function todayIST(now) {
    return Utilities.formatDate(now || new Date(), TZ, 'yyyy-MM-dd');
  }
  function formatIST(iso) {
    if (!iso) return '';
    return Utilities.formatDate(new Date(iso), TZ, 'd MMM, h:mm a') + ' IST';
  }
  function formatDay(ymd) {
    if (!ymd) return '';
    const p = ymd.split('-').map(Number);
    return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2], 6)), 'UTC', 'EEE, d MMM');
  }
  function formatLongToday(d) {
    return Utilities.formatDate(d || new Date(), TZ, 'EEEE, d MMMM yyyy');
  }
  function daysBetween(a, b) {
    const t = function (s) { const p = s.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
    return Math.round((t(b) - t(a)) / DAY);
  }
  function daysSince(iso, now) {
    if (!iso) return null;
    return Math.floor(((now || Date.now()) - new Date(iso).getTime()) / DAY);
  }

  // ---------------- Workspace lookups ----------------

  let wsCache = null;
  function workspace() {
    if (wsCache) return wsCache;
    const members = sc.members();
    const workflows = sc.workflows();
    const labels = sc.labels();
    const customFields = sc.customFields();
    const groups = sc.groups();

    const people = new Map();
    members.forEach(function (m) {
      const p = m.profile || {};
      people.set(m.id, {
        name: p.name || p.mention_name || 'Unknown',
        mention: p.mention_name || '',
        inactive: Boolean(p.deactivated || m.disabled),
      });
    });

    // Keep each workflow's own column order so lists follow the board.
    const states = new Map();
    let order = 0;
    workflows.forEach(function (wf) {
      (wf.states || [])
        .slice()
        .sort(function (a, b) { return (a.position || 0) - (b.position || 0); })
        .forEach(function (s) {
          states.set(s.id, { name: s.name.trim(), type: s.type, workflow: wf.name, order: order++ });
        });
    });

    const fieldValues = new Map();
    customFields.forEach(function (f) {
      (f.values || []).forEach(function (v) {
        fieldValues.set(v.id, { field: f.name, canonical: f.canonical_name, value: v.value });
      });
    });

    const teams = new Map(groups.map(function (g) { return [g.id, g]; }));
    wsCache = { people: people, states: states, labels: labels, customFields: customFields, fieldValues: fieldValues, teams: teams };
    return wsCache;
  }

  function personName(ws, id) {
    if (!id) return '';
    const p = ws.people.get(id);
    return p ? p.name : 'Unknown';
  }
  function ownerNames(ws, s) {
    return (s.owner_ids || []).map(function (id) { return personName(ws, id); }).join(', ');
  }
  function stateOf(ws, s) {
    return ws.states.get(s.workflow_state_id) || { name: 'Unknown', type: 'unknown', order: 999 };
  }
  function inList(name, arr) {
    const n = lc(name);
    return arr.some(function (x) { return lc(x) === n; });
  }
  function isDone(ws, s) {
    const st = stateOf(ws, s);
    return st.type === 'done' || s.completed === true || inList(st.name, CFG.doneStates);
  }
  function storyLink(s) {
    const url = s.app_url || 'https://app.shortcut.com/story/' + s.id;
    return url.replace(/(\/story\/\d+).*$/, '$1');
  }
  function isBlocked(ws, s) {
    if (s.blocked) return true;
    if (/block/i.test(stateOf(ws, s).name)) return true;
    return (s.labels || []).some(function (l) { return /^blocked?$/i.test(l.name || ''); });
  }

  // Pull requests from the story and its branches, without duplicates.
  function pullRequestsOf(s) {
    const seen = new Map();
    const add = function (pr) {
      if (!pr) return;
      const key = pr.url || 'id:' + pr.id;
      if (!seen.has(key)) seen.set(key, pr);
    };
    (s.pull_requests || []).forEach(add);
    (s.branches || []).forEach(function (b) { (b.pull_requests || []).forEach(add); });
    return Array.from(seen.values());
  }
  function prState(pr) {
    if (pr.merged) return 'merged';
    if (pr.closed) return 'closed';
    if (pr.draft) return 'draft';
    return 'open';
  }
  const PR_LABEL = { none: 'No PR', open: 'PR open', draft: 'PR draft', merged: 'PR merged', closed: 'PR closed (not merged)' };
  function prSummary(s) {
    const prs = pullRequestsOf(s);
    const seen = new Set(prs.map(prState));
    let key = 'none';
    ['open', 'draft', 'merged', 'closed'].some(function (k) {
      if (seen.has(k)) { key = k; return true; }
      return false;
    });
    return { key: key, label: PR_LABEL[key], prs: prs };
  }

  function isCustomerPriority(ws, s) {
    const c = CFG.customer;
    if (c.labels.length) {
      const wanted = c.labels.map(lc);
      if ((s.labels || []).some(function (l) { return wanted.indexOf(lc(l.name)) >= 0; })) return true;
    }
    if (c.states.length && inList(stateOf(ws, s).name, c.states)) return true;
    if (c.priorityValues.length) {
      const wanted = c.priorityValues.map(lc);
      const hit = (s.custom_fields || []).some(function (cf) {
        const info = ws.fieldValues.get(cf.value_id);
        const isPriority = info && (info.canonical === 'priority' || lc(info.field) === 'priority');
        return isPriority && wanted.indexOf(lc(cf.value || info.value)) >= 0;
      });
      if (hit) return true;
    }
    if (c.storyTypes.length && inList(s.story_type, c.storyTypes)) return true;
    if (c.teams.length && s.group_id) {
      const team = ws.teams.get(s.group_id);
      if (team && (inList(team.name, c.teams) || inList(team.mention_name, c.teams))) return true;
    }
    return false;
  }

  function openStories() {
    const m = new Map();
    sc.search('is:started !is:archived').concat(sc.search('is:unstarted !is:archived')).forEach(function (s) { m.set(s.id, s); });
    return Array.from(m.values());
  }

  // ---------------- Report data ----------------

  function findCurrentIteration(ws, now) {
    const today = todayIST(now);
    let its = sc.iterations().filter(function (it) {
      return it.status === 'started' && it.start_date <= today && today <= it.end_date;
    });
    if (SETTINGS.ITERATION_TEAM && its.length) {
      const want = lc(SETTINGS.ITERATION_TEAM);
      const ids = Array.from(ws.teams.values())
        .filter(function (g) { return lc(g.name) === want || lc(g.mention_name) === want; })
        .map(function (g) { return g.id; });
      its = its.filter(function (it) { return (it.group_ids || []).some(function (id) { return ids.indexOf(id) >= 0; }); });
    }
    if (!its.length) {
      throw new Error('No current sprint found: no iteration is "started" with dates covering today (' + today + ', IST). Check the current iteration in Shortcut.');
    }
    its.sort(function (a, b) { return b.start_date.localeCompare(a.start_date); });
    return { iteration: its[0], others: its.slice(1) };
  }

  function storyRow(ws, s) {
    const st = stateOf(ws, s);
    return {
      id: s.id,
      url: storyLink(s),
      title: s.name,
      owner: ownerNames(ws, s),
      ownerIds: s.owner_ids || [],
      state: st.name,
      stateOrder: st.order == null ? 999 : st.order,
      stateType: isDone(ws, s) ? 'done' : st.type === 'started' ? 'started' : 'unstarted',
      estimate: s.estimate == null ? null : s.estimate,
      pr: prSummary(s),
      blocked: isBlocked(ws, s),
      createdAt: s.created_at,
      requester: personName(ws, s.requested_by_id),
    };
  }

  function countByState(rows) {
    const m = new Map();
    rows.forEach(function (r) {
      const cur = m.get(r.state) || { name: r.state, type: r.stateType, order: r.stateOrder, count: 0 };
      cur.count++;
      cur.order = Math.min(cur.order, r.stateOrder);
      m.set(r.state, cur);
    });
    return Array.from(m.values()).sort(function (a, b) { return a.order - b.order; });
  }

  function sprintProgress(ws, it, stories, now) {
    const today = todayIST(now);
    const counts = { done: 0, started: 0, unstarted: 0 };
    let ptsTotal = 0, ptsDone = 0, anyEst = false;
    stories.forEach(function (s) {
      const type = isDone(ws, s) ? 'done' : stateOf(ws, s).type === 'started' ? 'started' : 'unstarted';
      counts[type]++;
      if (typeof s.estimate === 'number') {
        anyEst = true;
        ptsTotal += s.estimate;
        if (type === 'done') ptsDone += s.estimate;
      }
    });
    const total = stories.length;
    return {
      name: it.name, url: it.app_url, startDate: it.start_date, endDate: it.end_date,
      daysLeft: Math.max(0, daysBetween(today, it.end_date)),
      total: total, done: counts.done, started: counts.started, unstarted: counts.unstarted,
      pctCount: total ? Math.round((counts.done / total) * 100) : 0,
      points: anyEst ? { done: ptsDone, total: ptsTotal, pct: ptsTotal ? Math.round((ptsDone / ptsTotal) * 100) : 0 } : null,
    };
  }

  function buildFlags(ws, stories, now) {
    now = now || Date.now();
    const f = { staleNoPr: [], mergedNotDone: [], oldOpenPrs: [], blocked: [], noOwner: [], noEstimate: [] };
    stories.forEach(function (s) {
      const done = isDone(ws, s);
      const st = stateOf(ws, s);
      const row = storyRow(ws, s);
      const prs = pullRequestsOf(s);
      if (!done && st.type === 'started' && !prs.length) {
        const d = daysSince(s.started_at || s.moved_at, now);
        if (d !== null && d >= CFG.staleDays) f.staleNoPr.push(Object.assign({}, row, { days: d }));
      }
      if (!done && !inList(st.name, CFG.mergedOkStates) && prs.some(function (p) { return prState(p) === 'merged'; })) f.mergedNotDone.push(row);
      prs.forEach(function (pr) {
        const ps = prState(pr);
        if (ps === 'open' || ps === 'draft') {
          const d = daysSince(pr.created_at, now);
          if (d !== null && d >= CFG.staleDays) f.oldOpenPrs.push(Object.assign({}, row, { pr: pr, days: d }));
        }
      });
      if (!done && row.blocked) f.blocked.push(row);
      if (!done && !(s.owner_ids || []).length) f.noOwner.push(row);
      if (!done && s.estimate == null) f.noEstimate.push(row);
    });
    return f;
  }

  function newCustomerTickets(ws, now) {
    if (!customerRuleConfigured()) return { configured: false, items: [] };
    const since = now.getTime() - DAY;
    const from = new Date(since - DAY).toISOString().slice(0, 10);
    const to = new Date(now.getTime() + DAY).toISOString().slice(0, 10);
    const items = sc.search('created:' + from + '..' + to)
      .filter(function (s) { return new Date(s.created_at).getTime() >= since && isCustomerPriority(ws, s); })
      .sort(function (a, b) { return b.created_at.localeCompare(a.created_at); })
      .map(function (s) { return storyRow(ws, s); });
    return { configured: true, items: items };
  }

  function openCustomerTickets(ws) {
    if (!customerRuleConfigured()) return [];
    const matches = openStories().filter(function (s) { return isCustomerPriority(ws, s); });
    const full = matches.length <= 60 ? sc.storiesFull(matches.map(function (s) { return s.id; })) : matches;
    return full.map(function (s) { return storyRow(ws, s); })
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  }

  function workByPerson(ws, rows) {
    const groups = new Map();
    const add = function (key, name, r) {
      if (!groups.has(key)) groups.set(key, { name: name, rows: [] });
      groups.get(key).rows.push(r);
    };
    rows.forEach(function (r) {
      if (!r.ownerIds.length) add('_none', 'No owner', r);
      else r.ownerIds.forEach(function (id) { add(id, personName(ws, id), r); });
    });
    return Array.from(groups.entries())
      .sort(function (a, b) { return (a[0] === '_none') - (b[0] === '_none') || a[1].name.localeCompare(b[1].name); })
      .map(function (e) {
        const rs = e[1].rows.slice().sort(function (a, b) { return a.stateOrder - b.stateOrder || a.id - b.id; });
        return { name: e[1].name, rows: rs, byState: countByState(rs) };
      });
  }

  function buildReport(now) {
    now = now || new Date();
    const ws = workspace();
    const cur = findCurrentIteration(ws, now);
    const slim = sc.iterationStories(cur.iteration.id).filter(function (s) { return !s.archived; });
    const full = sc.storiesFull(slim.map(function (s) { return s.id; }));
    const rows = full.map(function (s) { return storyRow(ws, s); })
      .sort(function (a, b) { return a.stateOrder - b.stateOrder || a.id - b.id; });
    const nc = newCustomerTickets(ws, now);
    const newIds = new Set(nc.items.map(function (r) { return r.id; }));
    const progress = sprintProgress(ws, cur.iteration, full, now);
    progress.byState = countByState(rows);
    return {
      generatedAt: now.toISOString(),
      progress: progress,
      otherIterations: cur.others.map(function (i) { return i.name; }),
      byPerson: workByPerson(ws, rows),
      newCustomer: nc,
      openCustomer: openCustomerTickets(ws).map(function (r) { return Object.assign({}, r, { isNew: newIds.has(r.id) }); }),
      flags: buildFlags(ws, full, now.getTime()),
      staleDays: CFG.staleDays,
    };
  }

  // ---------------- HTML building blocks ----------------

  const C = {
    text: '#1f2933', muted: '#616e7c', border: '#e4e7eb', bg: '#f5f7fa', card: '#ffffff',
    green: '#1b7f4b', greenBg: '#e3f7ec', blue: '#1f5fbf', blueBg: '#e6effc',
    amber: '#8a5a00', amberBg: '#fff4d6', red: '#b42318', redBg: '#fdecea', grey: '#52606d', greyBg: '#eef1f4',
  };
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function truncate(s, n) {
    n = n || 90;
    const str = String(s == null ? '' : s);
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }
  function pill(text, tone) {
    const map = { green: [C.green, C.greenBg], blue: [C.blue, C.blueBg], amber: [C.amber, C.amberBg], red: [C.red, C.redBg], grey: [C.grey, C.greyBg] };
    const t = map[tone] || map.grey;
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;line-height:18px;white-space:nowrap;color:' + t[0] + ';background:' + t[1] + '">' + esc(text) + '</span>';
  }
  const TONE_FG = { green: C.green, blue: C.blue, amber: C.amber, red: C.red, grey: C.grey };
  function tag(text, tone) {
    return '<span style="color:' + (TONE_FG[tone] || C.grey) + '">' + esc(text) + '</span>';
  }
  function link(url, text) {
    return '<a href="' + esc(url) + '">' + esc(text) + '</a>';
  }
  function stateTone(type) {
    return type === 'done' ? 'green' : type === 'started' ? 'blue' : 'grey';
  }
  function prTone(key) {
    return { merged: 'green', open: 'blue', draft: 'amber', closed: 'red', none: 'grey' }[key] || 'grey';
  }
  function prCell(pr) {
    const links = pr.prs.map(function (p) { return link(p.url, '#' + (p.number == null ? '' : p.number)); }).join(' ');
    return tag(pr.label, prTone(pr.key)) + (links ? ' ' + links : '');
  }
  function storyIdCell(r) {
    return '<a href="' + esc(r.url) + '">sc&#8209;' + r.id + '</a>';
  }
  function section(title, body, note) {
    return '<tr><td style="padding:20px 20px 4px 20px">' +
      '<h2 style="margin:0 0 4px 0;font-size:17px;line-height:24px;color:' + C.text + '">' + esc(title) + '</h2>' +
      (note ? '<div style="font-size:13px;color:' + C.muted + ';margin-bottom:6px">' + note + '</div>' : '') +
      body + '</td></tr>';
  }
  function emptyNote(t) {
    return '<div style="font-size:14px;color:' + C.muted + ';padding:6px 0">' + esc(t) + '</div>';
  }
  function table(cols, rows) {
    const th = cols.map(function (c) {
      return '<th align="left" style="font-size:12px;color:' + C.muted + ';border-bottom:1px solid ' + C.border + ';white-space:nowrap">' + esc(c) + '</th>';
    }).join('');
    const tr = rows.map(function (r, i) {
      return '<tr valign="top"' + (i % 2 ? '' : ' bgcolor="' + C.bg + '"') + '><td>' + r.join('</td><td>') + '</td></tr>';
    }).join('\n');
    return '<table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;line-height:18px"><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>';
  }
  function page(title, preheader, bodyRows, footer) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title></head>' +
      '<body style="margin:0;padding:0;background:' + C.bg + ';font-family:' + FONT + ';color:' + C.text + '">' +
      '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(preheader) + '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.bg + '"><tr><td align="center" style="padding:16px 8px">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:' + C.card + ';border:1px solid ' + C.border + ';border-radius:10px;font-family:' + FONT + '">' +
      bodyRows +
      '<tr><td style="padding:16px 20px 20px 20px;font-size:12px;line-height:18px;color:' + C.muted + ';border-top:1px solid ' + C.border + '">' + footer + '</td></tr>' +
      '</table></td></tr></table></body></html>';
  }

  // ---------------- Report email ----------------

  const FLAG_LIMIT = 10;
  function daysText(p) {
    return p.daysLeft === 0 ? 'ends today' : p.daysLeft + ' day' + (p.daysLeft === 1 ? '' : 's') + ' left';
  }
  function stateSummary(byState) {
    return byState.map(function (s) { return s.name + ' ' + s.count; }).join(' · ');
  }

  function sprintHtml(p, others) {
    const max = Math.max.apply(null, [1].concat(p.byState.map(function (s) { return s.count; })));
    const bar = { done: C.green, started: C.blue, unstarted: '#9aa5b1' };
    const rows = p.byState.map(function (s) {
      return '<tr><td style="font-size:13px;padding:3px 8px 3px 0">' + tag(s.name, stateTone(s.type)) + '</td>' +
        '<td style="font-size:13px;padding:3px 8px;text-align:right;font-weight:600">' + s.count + '</td>' +
        '<td width="40%" style="padding:3px 0"><div style="background:' + (bar[s.type] || C.grey) + ';height:8px;border-radius:4px;width:' + Math.max(2, Math.round((s.count / max) * 100)) + '%"></div></td></tr>';
    }).join('');
    const pts = p.points ? ' · by points ' + p.points.pct + '% (' + p.points.done + '/' + p.points.total + ')' : '';
    return '<div style="font-size:15px">' + link(p.url, p.name) + '</div>' +
      '<div style="font-size:13px;color:' + C.muted + ';margin-bottom:10px">' + formatDay(p.startDate) + ' – ' + formatDay(p.endDate) + ' · <b style="color:' + C.text + '">' + daysText(p) + '</b> · ' + p.total + ' stories</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rows + '</table>' +
      '<div style="font-size:13px;color:' + C.muted + ';margin-top:8px">Completed: <b style="color:' + C.text + '">' + p.done + ' of ' + p.total + ' (' + p.pctCount + '%)</b>' + pts + '</div>' +
      (others.length ? '<div style="font-size:12px;color:' + C.muted + ';margin-top:6px">Also running: ' + esc(others.join(', ')) + '.</div>' : '');
  }

  function customerHtml(nc, open) {
    if (!nc.configured) return emptyNote('Customer priority is not set up yet (see CUSTOMER_* in SETTINGS).');
    const sub = function (t) { return '<div style="font-size:14px;font-weight:600;margin:10px 0 4px 0">' + t + '</div>'; };
    const newPart = nc.items.length
      ? table(['Story', 'Title', 'Raised by', 'Owner', 'Status', 'Created'], nc.items.map(function (r) {
          return [storyIdCell(r), esc(truncate(r.title)), esc(r.requester || '—'), esc(r.owner || '—'), tag(r.state, stateTone(r.stateType)),
            '<span style="white-space:nowrap">' + esc(formatIST(r.createdAt)) + '</span>'];
        }))
      : emptyNote('None in the last 24 hours.');
    const openPart = open.length
      ? table(['Story', 'Title', 'Owner', 'Status', 'PR'], open.map(function (r) {
          return [storyIdCell(r) + (r.isNew ? ' ' + pill('New', 'amber') : ''), esc(truncate(r.title)) + (r.blocked ? ' ' + tag('Blocked', 'red') : ''),
            esc(r.owner || '—'), tag(r.state, stateTone(r.stateType)), prCell(r.pr)];
        }))
      : emptyNote('No open customer-priority tickets.');
    return sub('New in the last 24 hours (' + nc.items.length + ')') + newPart + sub('All open customer-priority tickets (' + open.length + ')') + openPart;
  }

  function flagList(title, items, render) {
    const n = items.length;
    const head = '<div style="font-size:14px;font-weight:600;margin:12px 0 4px 0">' + esc(title) + ' ' + pill(String(n), n ? 'amber' : 'green') + '</div>';
    if (!n) return head;
    const lis = items.slice(0, FLAG_LIMIT).map(function (it) { return '<li>' + render(it) + '</li>'; }).join('\n');
    const more = n > FLAG_LIMIT ? '<li style="color:' + C.muted + '">+ ' + (n - FLAG_LIMIT) + ' more (see work status below)</li>' : '';
    return head + '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:20px">' + lis + more + '</ul>';
  }

  function flagsHtml(f, staleDays, anyEst) {
    const base = function (r) {
      return storyIdCell(r) + ' ' + esc(truncate(r.title, 80)) + ' <span style="color:' + C.muted + '">· ' + esc(r.owner || 'no owner') + ' · ' + esc(r.state) + '</span>';
    };
    return [
      flagList('In progress ' + staleDays + '+ days with no PR', f.staleNoPr, function (r) { return base(r) + ' <b>(' + r.days + ' days)</b>'; }),
      flagList('PR merged but story not in a Done state', f.mergedNotDone, base),
      flagList('PRs open ' + staleDays + '+ days', f.oldOpenPrs, function (r) {
        return link(r.pr.url, 'PR #' + (r.pr.number == null ? '' : r.pr.number)) + ' · ' + base(r) + ' <b>(' + r.days + ' days)</b>';
      }),
      flagList('Blocked', f.blocked, base),
      flagList('No owner', f.noOwner, base),
      anyEst ? flagList('No estimate', f.noEstimate, base)
        : '<div style="font-size:13px;color:' + C.muted + ';margin-top:12px">No estimate: skipped, because no story in this sprint is estimated.</div>',
    ].join('');
  }

  // full=true: every story as a row (attachment). full=false: not-started stories as compact links (keeps email under Gmail's ~100 KB limit).
  function peopleHtml(byPerson, full) {
    if (!byPerson.length) return emptyNote('No stories in this sprint.');
    const rowsTable = function (rows) {
      return table(['Story', 'Title', 'Status', 'PR'], rows.map(function (r) {
        return [storyIdCell(r), esc(truncate(r.title, 80)) + (r.blocked ? ' ' + tag('Blocked', 'red') : ''), tag(r.state, stateTone(r.stateType)), prCell(r.pr)];
      }));
    };
    return byPerson.map(function (g) {
      const active = full ? g.rows : g.rows.filter(function (r) { return r.stateType !== 'unstarted'; });
      const waiting = full ? [] : g.rows.filter(function (r) { return r.stateType === 'unstarted'; });
      return '<div style="margin:16px 0 4px 0;font-size:15px;font-weight:600">' + esc(g.name) +
        ' <span style="font-weight:400;color:' + C.muted + ';font-size:13px">· ' + g.rows.length + ' ticket' + (g.rows.length === 1 ? '' : 's') + '</span></div>' +
        '<div style="font-size:12px;color:' + C.muted + ';margin-bottom:4px">' + esc(stateSummary(g.byState)) + '</div>' +
        (active.length ? rowsTable(active) : '') +
        (waiting.length ? '<div style="font-size:12px;line-height:20px;margin-top:4px"><span style="color:' + C.muted + '">Not started (' + waiting.length + '):</span> ' + waiting.map(storyIdCell).join(', ') + '</div>' : '');
    }).join('');
  }

  function subjectFor(report) {
    return SETTINGS.REPORT_SUBJECT + ' · ' + report.progress.name + ' · ' + formatLongToday(new Date(report.generatedAt));
  }

  function renderHtml(report, full, chatAddr) {
    const p = report.progress;
    const chatHelp = chatAddr
      ? 'Questions about any ticket? Reply to this email or write to ' + link('mailto:' + chatAddr, chatAddr) + ', for example “sc-1234”, “what is Priya working on”, “Ready in QA”, or “help”.<br>'
      : '';
    const body =
      '<tr><td style="padding:20px 20px 0 20px"><div style="font-size:12px;color:' + C.muted + ';text-transform:uppercase;letter-spacing:.04em">Daily team report</div>' +
      '<h1 style="margin:2px 0 0 0;font-size:21px;line-height:28px">' + esc(formatLongToday(new Date(report.generatedAt))) + '</h1></td></tr>' +
      section('Sprint status', sprintHtml(p, report.otherIterations)) +
      section('Customer-priority tickets', customerHtml(report.newCustomer, report.openCustomer)) +
      section('Needs attention', flagsHtml(report.flags, report.staleDays, Boolean(p.points))) +
      section('Work status by person', peopleHtml(report.byPerson, full),
        'Every story in ' + esc(p.name) + ', grouped by owner.' + (full ? '' : ' Not-started tickets are listed as links; the attached file has full details for every story.'));
    return page(subjectFor(report), p.name + ': ' + stateSummary(p.byState), body,
      chatHelp + 'Generated ' + esc(formatIST(report.generatedAt)) + ' from Shortcut. Times are India Standard Time.');
  }

  function renderText(report, chatAddr) {
    const p = report.progress, f = report.flags, out = [];
    const line = function (r, withOwner) {
      return 'sc-' + r.id + ' ' + truncate(r.title) + ' | ' + (withOwner ? (r.owner || 'no owner') + ' | ' : '') + r.state + ' | ' + r.pr.label;
    };
    out.push('DAILY TEAM REPORT: ' + formatLongToday(new Date(report.generatedAt)), '');
    out.push('SPRINT: ' + p.name + ' (' + formatDay(p.startDate) + ' – ' + formatDay(p.endDate) + ', ' + daysText(p) + ', ' + p.total + ' stories)');
    p.byState.forEach(function (s) { out.push('  ' + s.name + ': ' + s.count); });
    out.push('Completed: ' + p.done + ' of ' + p.total + ' (' + p.pctCount + '%)', p.url, '');
    out.push('CUSTOMER-PRIORITY TICKETS');
    out.push('  New in the last 24 hours (' + report.newCustomer.items.length + ')');
    report.newCustomer.items.forEach(function (r) { out.push('    ' + line(r, true) + ' | raised by ' + (r.requester || '—') + ' | ' + formatIST(r.createdAt)); });
    out.push('  All open (' + report.openCustomer.length + ')');
    report.openCustomer.forEach(function (r) { out.push('    ' + (r.isNew ? '[NEW] ' : '') + line(r, true)); });
    out.push('', 'NEEDS ATTENTION');
    [['In progress ' + report.staleDays + '+ days, no PR', f.staleNoPr], ['PR merged, story not in a Done state', f.mergedNotDone],
      ['PRs open ' + report.staleDays + '+ days', f.oldOpenPrs], ['Blocked', f.blocked], ['No owner', f.noOwner]].forEach(function (x) {
      out.push('  ' + x[0] + ': ' + x[1].length);
      x[1].slice(0, FLAG_LIMIT).forEach(function (r) { out.push('    - sc-' + r.id + ' ' + truncate(r.title, 80) + ' (' + (r.owner || 'no owner') + ', ' + r.state + ')'); });
    });
    out.push('', 'WORK STATUS BY PERSON');
    report.byPerson.forEach(function (g) {
      out.push('  ' + g.name + ' (' + g.rows.length + '): ' + stateSummary(g.byState));
      g.rows.forEach(function (r) { out.push('    ' + line(r, false)); });
    });
    if (chatAddr) out.push('', 'Questions? Reply to this email or write to ' + chatAddr + '. Send "help" for examples.');
    return out.join('\n');
  }

  function chatAddress() {
    const me = Session.getEffectiveUser().getEmail();
    const parts = me.split('@');
    return parts[0] + '+shortcut@' + parts[1];
  }

  function sendReport(recipients, subjectPrefix) {
    if (!recipients.length) throw new Error('REPORT_RECIPIENTS is empty in SETTINGS.');
    const report = buildReport(new Date());
    const addr = SETTINGS.CHAT_ENABLED ? chatAddress() : '';
    const html = renderHtml(report, false, addr);
    const fullHtml = renderHtml(report, true, addr);
    // MailApp only needs "send email" permission (no inbox access).
    const msg = {
      to: recipients.join(','),
      subject: subjectPrefix + subjectFor(report),
      body: renderText(report, addr),
      htmlBody: html,
      name: SETTINGS.FROM_NAME,
      attachments: [Utilities.newBlob(fullHtml, 'text/html', report.progress.name + ' - full sprint report.html')],
    };
    if (addr) msg.replyTo = addr;
    MailApp.sendEmail(msg);
    Logger.log('Report sent to %s recipient(s). Sprint has %s stories.', recipients.length, report.progress.total);
    return report;
  }

  // ---------------- Email assistant ----------------

  const STOP = new Set(('a an the is are was were be been am i me my we our you your he she they them it its this that these those of to in on at for from by with about ' +
    'what whats what\'s which who whom whose when where why how can could would should will shall do does did any some please pls thanks thank ' +
    'status update tell show give list get find check info details detail know anything there here and or not no yes hi hello hey team story stories ' +
    'ticket tickets sc issue issues task tasks currently current now today latest').split(/\s+/));

  const MAX_LIST = 40, MAX_PR_LOOKUPS = 30;
  let openCache = null, vocabCache = null, iterCache = null;

  function iterations() {
    if (!iterCache) iterCache = sc.iterations();
    return iterCache;
  }
  function openCached() {
    if (!openCache) openCache = openStories();
    return openCache;
  }

  function extractStoryIds(text, wordCount) {
    const ids = [];
    const re = /(?<![\w])(?:sc-?|#|story\s*#?|ticket\s*#?|card\s*#?)\s?(\d{1,7})\b/gi;
    let m;
    while ((m = re.exec(text))) if (ids.indexOf(Number(m[1])) < 0) ids.push(Number(m[1]));
    if (!ids.length && wordCount <= 8) (text.match(/\b\d{3,7}\b/g) || []).forEach(function (n) { if (ids.indexOf(Number(n)) < 0) ids.push(Number(n)); });
    return ids.slice(0, 5);
  }

  function findPeople(ws, lower) {
    const words = new Set(lower.match(/[a-z][a-z.'-]+/g) || []);
    const hits = [];
    ws.people.forEach(function (p, id) {
      if (p.inactive) return;
      const fullName = lc(p.name), first = fullName.split(/\s+/)[0], mention = lc(p.mention);
      if ((fullName.indexOf(' ') > 0 && lower.indexOf(fullName) >= 0) ||
          (mention && (words.has(mention) || lower.indexOf('@' + mention) >= 0)) ||
          (first.length >= 3 && !STOP.has(first) && words.has(first))) {
        hits.push({ id: id, name: p.name, mention: p.mention });
      }
    });
    return hits;
  }

  const INTENT_WORDS = new Set(['started', 'done', 'completed', 'unstarted', 'to-do', 'todo', 'blocked', 'build']);
  const KIND_ORDER = ['state', 'label', 'team', 'iteration', 'epic', 'type', 'field'];

  // Names from the workspace (read live): states, labels, teams, sprints, epics, types, field values.
  function vocabulary(ws) {
    if (vocabCache) return vocabCache;
    const terms = [];
    const add = function (kind, name, extra) {
      const phrase = lc(name);
      if (phrase.length < 3 || !/[a-z]/.test(phrase) || STOP.has(phrase) || INTENT_WORDS.has(phrase)) return;
      terms.push(Object.assign({ kind: kind, name: String(name).trim(), phrase: phrase }, extra || {}));
    };
    const seenStates = new Set();
    ws.states.forEach(function (s) { if (!seenStates.has(s.name)) { seenStates.add(s.name); add('state', s.name); } });
    ws.labels.forEach(function (l) { if (!l.archived) add('label', l.name); });
    ws.teams.forEach(function (g) { if (!g.archived) add('team', g.name); });
    iterations().forEach(function (i) { add('iteration', i.name); });
    let epics = [];
    try { epics = sc.epics(); } catch (e) { /* optional */ }
    epics.forEach(function (e) { if (!e.archived && e.name && e.name.length >= 5) add('epic', e.name); });
    ['bug', 'feature', 'chore'].forEach(function (t) { add('type', t, { value: t }); add('type', t + 's', { value: t }); });
    ws.customFields.forEach(function (f) {
      if (f.enabled === false) return;
      (f.values || []).forEach(function (v) { add('field', v.value, { field: f.name, valueId: v.id }); });
    });
    vocabCache = terms;
    return terms;
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findTerms(vocab, lower, people) {
    const personWords = new Set();
    people.forEach(function (p) { personWords.add(lc(p.name)); personWords.add(lc(p.name).split(/\s+/)[0]); personWords.add(lc(p.mention)); });
    const hits = [];
    vocab.forEach(function (t) {
      if (personWords.has(t.phrase)) return;
      const re = new RegExp('(?<![a-z0-9])' + escapeRe(t.phrase) + '(?![a-z0-9])', 'g');
      let m;
      while ((m = re.exec(lower))) hits.push(Object.assign({}, t, { start: m.index, end: m.index + t.phrase.length }));
    });
    hits.sort(function (a, b) { return (b.end - b.start) - (a.end - a.start) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind); });
    const taken = [];
    hits.forEach(function (h) {
      if (!taken.some(function (t) { return h.start < t.end && t.start < h.end; })) taken.push(h);
    });
    return taken;
  }

  const FILLER = new Set(('label labels tagged tag state states stage column team teams sprint sprints iteration epic epics type types field fields ' +
    'priority severity open opened pending assigned owned owner owners working work doing progress dev development wip ongoing ' +
    'done completed finished closed shipped all everything items cards ones count many much number how has have having marked under ' +
    'customer customers blocked blocking blocker stuck').split(/\s+/));

  function q(v) { return '"' + String(v).replace(/"/g, '') + '"'; }

  function sortByState(ws, arr) {
    const order = { started: 0, unstarted: 1, done: 2 };
    return arr.slice().sort(function (a, b) {
      return (order[stateOf(ws, a).type] == null ? 3 : order[stateOf(ws, a).type]) - (order[stateOf(ws, b).type] == null ? 3 : order[stateOf(ws, b).type]) ||
        String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
  }

  function storyListAnswer(ws, title, arr, opts) {
    opts = opts || {};
    const showOwner = opts.showOwner !== false;
    const total = arr.length;
    const shown = sortByState(ws, arr).slice(0, MAX_LIST);
    const prsKnown = shown.length <= MAX_PR_LOOKUPS;
    const stories = prsKnown ? sc.storiesFull(shown.map(function (s) { return s.id; })) : shown;
    const rows = stories.map(function (s) { return storyRow(ws, s); });
    const more = total > shown.length ? ' Showing ' + shown.length + ' of ' + total + '.' : '';
    const cols = ['Story', 'Title'].concat(showOwner ? ['Owner'] : [], ['Status'], prsKnown ? ['PR'] : []);
    const html = rows.length
      ? table(cols, rows.map(function (r) {
          const cells = [storyIdCell(r), esc(truncate(r.title)) + (r.blocked ? ' ' + tag('Blocked', 'red') : '')];
          if (showOwner) cells.push(esc(r.owner || '—'));
          cells.push(tag(r.state, stateTone(r.stateType)));
          if (prsKnown) cells.push(prCell(r.pr));
          return cells;
        }))
      : emptyNote('Nothing found.');
    const text = rows.map(function (r) {
      return '- sc-' + r.id + ' ' + r.title + ' | ' + (showOwner ? (r.owner || 'no owner') + ' | ' : '') + r.state + (prsKnown ? ' | ' + r.pr.label : '') + '\n  ' + r.url;
    });
    return {
      title: title,
      html: section(title + ' (' + total + ')', html, esc(opts.note || '') + more),
      text: title.toUpperCase() + ' (' + total + ')' + (opts.note ? '\n' + opts.note : '') + more + '\n' + (text.join('\n') || 'Nothing found.'),
    };
  }

  function storyDetail(ws, id) {
    let s;
    try {
      s = sc.story(id);
    } catch (e) {
      if (e.status === 404) return { title: 'sc-' + id, html: section('sc-' + id, emptyNote('Story sc-' + id + ' was not found.')), text: 'sc-' + id + ': not found.' };
      throw e;
    }
    const st = stateOf(ws, s), pr = prSummary(s);
    const team = s.group_id && ws.teams.get(s.group_id) ? ws.teams.get(s.group_id).name : '';
    const it = iterations().filter(function (i) { return i.id === s.iteration_id; })[0];
    const labels = (s.labels || []).map(function (l) { return l.name; }).join(', ');
    const fields = (s.custom_fields || []).map(function (cf) { return ws.fieldValues.get(cf.value_id); }).filter(Boolean)
      .map(function (v) { return v.field + ': ' + v.value; }).join(', ');
    const customer = isCustomerPriority(ws, s);
    const desc = String(s.description || '').replace(/\s+/g, ' ').trim();
    const comments = (s.comments || []).filter(function (c) { return !c.deleted && c.text; }).slice(-3).map(function (c) {
      return { who: personName(ws, c.author_id), when: formatIST(c.created_at), text: c.text.replace(/\s+/g, ' ').slice(0, 300) };
    });
    const facts = [
      ['Status', pill(st.name, stateTone(isDone(ws, s) ? 'done' : st.type)) + (isBlocked(ws, s) ? ' ' + pill('Blocked', 'red') : '')],
      ['Owner', esc(ownerNames(ws, s) || 'No owner')],
      ['Raised by', esc(personName(ws, s.requested_by_id) || '—')],
      ['Type', esc(s.story_type || '')],
      ['Estimate', esc(s.estimate == null ? 'Not estimated' : s.estimate)],
      ['Sprint', esc(it ? it.name : 'Not in a sprint')],
      ['Team', esc(team || '—')],
      ['Labels', esc(labels || '—')],
      ['Fields', esc(fields || '—')],
      ['Customer priority', customer ? pill('Yes', 'amber') : 'No'],
      ['Created', esc(formatIST(s.created_at))],
      ['Last updated', esc(formatIST(s.updated_at))],
    ];
    const factRows = facts.map(function (f) {
      return '<tr><td style="padding:4px 10px 4px 0;font-size:13px;color:' + C.muted + ';white-space:nowrap;vertical-align:top">' + f[0] + '</td><td style="padding:4px 0;font-size:13px">' + f[1] + '</td></tr>';
    }).join('');
    const prHtml = pr.prs.length
      ? '<ul style="margin:4px 0 0 0;padding-left:18px">' + pr.prs.map(function (p) {
          return '<li style="font-size:13px;margin-bottom:3px">' + link(p.url, 'PR #' + (p.number == null ? '' : p.number) + ' ' + (p.title || '')) + ' ' +
            pill(PR_LABEL[prState(p)], prTone(prState(p))) + ' <span style="color:' + C.muted + '">opened ' + esc(formatIST(p.created_at)) + '</span></li>';
        }).join('') + '</ul>'
      : emptyNote('No PR linked.');
    const commentHtml = comments.map(function (c) {
      return '<div style="font-size:13px;margin:6px 0;padding:6px 10px;background:' + C.bg + ';border-radius:6px"><b>' + esc(c.who) + '</b> <span style="color:' + C.muted + '">' + esc(c.when) + '</span><br>' + esc(c.text) + '</div>';
    }).join('');
    const html = section('sc-' + s.id + ': ' + s.name,
      '<div style="margin-bottom:8px">' + link(storyLink(s), 'Open in Shortcut') + '</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0">' + factRows + '</table>' +
      '<div style="font-size:14px;font-weight:600;margin:12px 0 0 0">Pull requests</div>' + prHtml +
      (desc ? '<div style="font-size:14px;font-weight:600;margin:12px 0 4px 0">Description</div><div style="font-size:13px">' + esc(truncate(desc, 500)) + '</div>' : '') +
      (commentHtml ? '<div style="font-size:14px;font-weight:600;margin:12px 0 0 0">Latest comments</div>' + commentHtml : ''));
    const text = ['sc-' + s.id + ': ' + s.name, storyLink(s), 'Status: ' + st.name + (isBlocked(ws, s) ? ' (BLOCKED)' : ''),
      'Owner: ' + (ownerNames(ws, s) || 'No owner'), 'Raised by: ' + (personName(ws, s.requested_by_id) || '—'),
      'Sprint: ' + (it ? it.name : 'Not in a sprint'), 'Customer priority: ' + (customer ? 'Yes' : 'No'),
      'Created: ' + formatIST(s.created_at) + ' · Updated: ' + formatIST(s.updated_at),
      'PRs: ' + (pr.prs.length ? pr.prs.map(function (p) { return PR_LABEL[prState(p)] + ' ' + p.url; }).join(' ; ') : 'No PR')]
      .concat(comments.length ? ['Latest comments:'].concat(comments.map(function (c) { return '  ' + c.who + ' (' + c.when + '): ' + c.text; })) : [])
      .join('\n');
    return { title: 'sc-' + s.id, html: html, text: text };
  }

  function sprintAnswer(ws) {
    const cur = findCurrentIteration(ws);
    const slim = sc.iterationStories(cur.iteration.id).filter(function (s) { return !s.archived; });
    const p = sprintProgress(ws, cur.iteration, slim);
    p.byState = countByState(slim.map(function (s) { return storyRow(ws, s); }));
    return { title: 'Sprint status', html: section('Sprint status', sprintHtml(p, [])),
      text: p.name + ': ' + daysText(p) + '. ' + stateSummary(p.byState) + '. Completed ' + p.done + ' of ' + p.total + '.' };
  }

  function flagsAnswer(ws) {
    const cur = findCurrentIteration(ws);
    const slim = sc.iterationStories(cur.iteration.id).filter(function (s) { return !s.archived; });
    const f = buildFlags(ws, sc.storiesFull(slim.map(function (s) { return s.id; })));
    const groups = [['In progress ' + CFG.staleDays + '+ days with no PR', f.staleNoPr], ['PR merged but story not in a Done state', f.mergedNotDone],
      ['PRs open ' + CFG.staleDays + '+ days', f.oldOpenPrs], ['Blocked', f.blocked], ['No owner', f.noOwner]];
    const html = groups.map(function (g) {
      return section(g[0] + ' (' + g[1].length + ')', g[1].length
        ? '<ul style="margin:0;padding-left:18px;font-size:13px">' + g[1].map(function (r) {
            return '<li>' + storyIdCell(r) + ' ' + esc(r.title) + ' <span style="color:' + C.muted + '">· ' + esc(r.owner || 'no owner') + ' · ' + esc(r.state) + '</span></li>';
          }).join('') + '</ul>'
        : emptyNote('None.'));
    }).join('');
    const text = groups.map(function (g) {
      return g[0] + ': ' + g[1].length + '\n' + g[1].map(function (r) { return '  - sc-' + r.id + ' ' + r.title + ' (' + (r.owner || 'no owner') + ', ' + r.state + ')'; }).join('\n');
    }).join('\n');
    return { title: 'Needs attention in ' + cur.iteration.name, html: html, text: text };
  }

  function newTicketsAnswer(ws) {
    const now = Date.now(), since = now - DAY;
    const from = new Date(since - DAY).toISOString().slice(0, 10), to = new Date(now + DAY).toISOString().slice(0, 10);
    const found = sc.search('created:' + from + '..' + to).filter(function (s) { return new Date(s.created_at).getTime() >= since; });
    const note = customerRuleConfigured() ? found.filter(function (s) { return isCustomerPriority(ws, s); }).length + ' of these are customer priority.' : '';
    return storyListAnswer(ws, 'Tickets created in the last 24 hours', found, { note: note });
  }

  function searchAnswer(ws, question) {
    const words = (lc(question).match(/[a-z0-9][a-z0-9'_-]*/g) || []).filter(function (w) { return !STOP.has(w) && w.length > 1; });
    if (!words.length) return null;
    const query = words.slice(0, 6).join(' ');
    let results = [];
    try { results = sc.search(query + ' !is:archived', 25); } catch (e) { if (e.status !== 400) throw e; }
    return storyListAnswer(ws, 'Search results for “' + query + '”', results.slice(0, 15),
      { note: results.length >= 25 ? 'Many matches — add more words to narrow it down.' : '' });
  }

  function helpAnswer() {
    const ex = [
      ['sc-1234  (or "status of 1234")', 'Full details of a ticket: status, owner, PRs, latest comments'],
      ['what is Priya working on', "A person's in-progress tickets"],
      ['in progress', 'Everything currently in development, across all teams'],
      ['Ready in QA', 'Tickets in any status, by its name'],
      ['backend bugs', 'Any label + story type'],
      ['Engineering team blocked', 'Any team, with blocked / in progress / done'],
      ['Severity 1 tickets  ·  Highest priority', 'Any Priority, Severity or other field value'],
      ['bugs in this sprint  ·  Squid Game done', 'Any sprint by name, or "this sprint"'],
      ['customer priority', 'Open customer-priority tickets'],
      ['sprint status', 'Current sprint status'],
      ['needs attention', 'Flags for the current sprint'],
      ['new tickets', 'Tickets created in the last 24 hours'],
      ['login timeout', 'Anything else is a keyword search across all tickets'],
    ];
    return {
      title: 'Help',
      html: section('What you can ask', table(['Write', 'You get'], ex.map(function (e) { return ['<b>' + esc(e[0]) + '</b>', esc(e[1])]; })),
        'Mix and match, e.g. “Priya backend bugs in Ready in QA”. Labels, statuses, teams, sprints and field values are read live from Shortcut.'),
      text: 'WHAT YOU CAN ASK\n' + ex.map(function (e) { return '- ' + e[0] + ': ' + e[1]; }).join('\n'),
    };
  }

  function filteredAnswer(ws, ctx) {
    const ops = [], desc = [], fieldFilters = new Map();
    let hasState = false;
    ctx.terms.forEach(function (t) {
      if (t.kind === 'state') { ops.push('state:' + q(t.name)); hasState = true; }
      else if (t.kind === 'label') ops.push('label:' + q(t.name));
      else if (t.kind === 'team') ops.push('team:' + q(t.name));
      else if (t.kind === 'iteration') ops.push('iteration:' + q(t.name));
      else if (t.kind === 'epic') ops.push('epic:' + q(t.name));
      else if (t.kind === 'type') ops.push('type:' + t.value);
      else if (t.kind === 'field') {
        if (!fieldFilters.has(t.field)) fieldFilters.set(t.field, new Set());
        fieldFilters.get(t.field).add(t.valueId);
      }
      desc.push(t.kind === 'field' ? t.field + ': ' + t.name : t.kind === 'type' ? t.value + 's' : (t.kind === 'iteration' ? 'sprint' : t.kind) + ' “' + t.name + '”');
    });
    if (/\b(this|current) (sprint|iteration)\b/.test(ctx.lower) && !ctx.terms.some(function (t) { return t.kind === 'iteration'; })) {
      try { const cur = findCurrentIteration(ws); ops.push('iteration:' + q(cur.iteration.name)); desc.push('sprint “' + cur.iteration.name + '”'); } catch (e) { /* none */ }
    }
    if (ctx.wantsBlocked) { ops.push('is:blocked'); desc.push('blocked'); }
    if (ctx.wantsProgress && !hasState) { ops.push('is:started'); desc.push('in progress'); }
    if (ctx.wantsDone && !hasState) { ops.push('is:done'); desc.push('done'); }
    const positive = ops.length > 0;
    if (!hasState && !ctx.wantsDone && !ctx.wantsAll) ops.push('!is:done');
    ops.push('!is:archived');

    const used = new Set();
    ctx.terms.forEach(function (t) { t.phrase.split(/\s+/).forEach(function (w) { used.add(w); }); });
    ctx.people.forEach(function (p) { lc(p.name).split(/\s+/).concat([lc(p.mention)]).forEach(function (w) { used.add(w); }); });
    const extra = (ctx.lower.match(/[a-z][a-z0-9'_-]*/g) || []).filter(function (w) {
      return w.length > 2 && !STOP.has(w) && !FILLER.has(w) && !used.has(w) && !used.has(w.replace(/s$/, ''));
    });

    const owners = ctx.people.length ? ctx.people.slice(0, 3) : [null];
    return owners.map(function (person) {
      const d = desc.slice();
      let arr;
      if (!positive && !person) {
        arr = ctx.wantsAll || ctx.wantsDone ? sc.search('!is:archived', 300) : openCached();
      } else {
        const base = (person && person.mention ? ['owner:' + person.mention] : []).concat(ops);
        arr = [];
        if (extra.length) { try { arr = sc.search(extra.slice(0, 4).concat(base).join(' '), 300); } catch (e) { arr = []; } }
        if (arr.length) d.push('matching “' + extra.slice(0, 4).join(' ') + '”');
        else arr = sc.search(base.join(' '), 300);
      }
      fieldFilters.forEach(function (ids) {
        arr = arr.filter(function (s) { return (s.custom_fields || []).some(function (cf) { return ids.has(cf.value_id); }); });
      });
      if (ctx.wantsCustomer) {
        arr = arr.filter(function (s) { return isCustomerPriority(ws, s); });
        d.push('customer priority');
      }
      const status = ctx.wantsDone || hasState || ctx.wantsAll || ctx.wantsProgress || ctx.wantsBlocked ? '' : 'Open';
      const label = d.length ? d.join(' · ') : 'tickets';
      let title = person ? person.name + ': ' + (status ? status.toLowerCase() + ' ' : '') + label : (status ? status + ' ' : '') + label;
      title = title.charAt(0).toUpperCase() + title.slice(1);
      return storyListAnswer(ws, title, arr, { showOwner: !person, note: arr.length >= 300 ? 'Over 300 matches — add more detail to narrow it down.' : '' });
    });
  }

  function answerQuestion(raw) {
    const question = String(raw || '').trim().slice(0, 1000);
    const lower = lc(question);
    const wordCount = lower.split(/\s+/).filter(Boolean).length;
    if (!question || /^(help|hi|hello|hey|\?|commands|menu)\W*$/.test(lower)) return finish(question, [helpAnswer()]);

    const ws = workspace();
    const ids = extractStoryIds(question, wordCount);
    if (ids.length) return finish(question, ids.map(function (id) { return storyDetail(ws, id); }));

    const has = function (re) { return re.test(lower); };
    const people = findPeople(ws, lower);
    const wantsCustomer = has(/\bcustomer/) && customerRuleConfigured();
    let terms = findTerms(vocabulary(ws), lower, people);
    if (wantsCustomer) terms = terms.filter(function (t) { return t.phrase.indexOf('customer') < 0; });
    const ctx = {
      lower: lower, terms: terms, people: people, wantsCustomer: wantsCustomer,
      wantsBlocked: has(/\bblock(ed|ing|er)?\b/),
      wantsProgress: has(/\b(in[ -]?progress|in[ -]?dev(elopment)?|wip|working|ongoing|started|doing)\b/),
      wantsDone: has(/\b(done|completed|finished|closed|shipped)\b/),
      wantsAll: has(/\b(all|every|everything)\b/),
    };
    const anyFilter = terms.length || people.length || wantsCustomer || ctx.wantsBlocked || ctx.wantsProgress || ctx.wantsDone;
    const plain = !terms.length && !people.length;

    let parts;
    if (has(/\b(attention|flags?|risks?|stale|overdue|no pr)\b/) && plain) parts = [flagsAnswer(ws)];
    else if (has(/\b(sprint|iteration)\b/) && has(/\b(progress|status|how|summary|update)\b/) && plain) parts = [sprintAnswer(ws)];
    else if (has(/\b(new|raised|created|last 24|yesterday)\b/) && plain) parts = [newTicketsAnswer(ws)];
    else if (anyFilter) parts = filteredAnswer(ws, ctx);
    else if (/^\s*(sprint|iteration|current sprint)\W*$/.test(lower)) parts = [sprintAnswer(ws)];
    else parts = [searchAnswer(ws, question) || helpAnswer()];
    return finish(question, parts);
  }

  function finish(question, parts) {
    const title = parts.map(function (p) { return p.title; }).join(' · ');
    const intro = question
      ? '<tr><td style="padding:18px 20px 0 20px;font-size:13px;color:' + C.muted + '">You asked: <i>' + esc(question.slice(0, 300)) + '</i></td></tr>'
      : '';
    return {
      title: title,
      html: page(title, '', intro + parts.map(function (p) { return p.html; }).join(''),
        'Reply to ask another question. Send “help” to see examples. Answers come straight from Shortcut; times are IST.'),
      text: parts.map(function (p) { return p.text; }).join('\n\n') + '\n\nReply to ask another question. Send "help" for examples.',
    };
  }

  // Keep only the new text of a reply: drop quoted history and signatures.
  function extractQuestion(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^On\b.*wrote:$/i.test(t) || (/^On\b/.test(t) && /wrote:$/i.test(String(lines[i + 1] || '').trim()))) break;
      if (/^-{2,}\s*Original Message/i.test(t) || /^_{5,}$/.test(t) || /^From:\s/i.test(t)) break;
      if (t === '--' || /^Sent from my /i.test(t)) break;
      if (t.indexOf('>') === 0) continue;
      kept.push(lines[i]);
    }
    return kept.join('\n').trim().slice(0, 1000);
  }

  function senderAddress(from) {
    const m = String(from || '').match(/<([^>]+)>/);
    return lc(m ? m[1] : from);
  }

  function isAllowed(address) {
    const allowed = list(SETTINGS.CHAT_ALLOWED_SENDERS).length ? list(SETTINGS.CHAT_ALLOWED_SENDERS) : list(SETTINGS.REPORT_RECIPIENTS);
    return allowed.some(function (e) { e = lc(e); return e.charAt(0) === '@' ? address.slice(-e.length) === e : address === e; });
  }

  // Remember which messages were answered (and ignore anything older than setup).
  function startChat() {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('CHAT_SINCE', String(Date.now()));
    props.setProperty('CHAT_ANSWERED', '[]');
  }

  function checkQuestions() {
    if (!SETTINGS.CHAT_ENABLED) return;
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) return; // a previous check is still running
    try {
      const props = PropertiesService.getScriptProperties();
      if (!props.getProperty('CHAT_SINCE')) startChat();
      const since = Number(props.getProperty('CHAT_SINCE'));
      let answered = JSON.parse(props.getProperty('CHAT_ANSWERED') || '[]');
      const done = new Set(answered);
      const me = lc(Session.getEffectiveUser().getEmail());
      const addr = chatAddress();
      const subject = SETTINGS.REPORT_SUBJECT.replace(/"/g, '');
      const threads = GmailApp.search('newer_than:2d -from:me {deliveredto:' + addr + ' to:' + addr + ' subject:"' + subject + '"}', 0, 30);
      let count = 0;
      threads.forEach(function (thread) {
        thread.getMessages().forEach(function (msg) {
          const id = msg.getId();
          if (done.has(id) || msg.getDate().getTime() < since || count >= 10) return;
          const from = senderAddress(msg.getFrom());
          const auto = lc(msg.getHeader('Auto-Submitted') || 'no') !== 'no' || /mailer-daemon|no-?reply|postmaster/.test(from);
          done.add(id);
          answered.push(id);
          if (from === me || auto || !isAllowed(from)) return;
          let answer;
          try {
            answer = answerQuestion(extractQuestion(msg.getPlainBody()));
          } catch (e) {
            answer = { text: "Sorry, I couldn't answer that just now: " + e.message, html: '<p>Sorry, I couldn\'t answer that just now: ' + esc(e.message) + '</p>' };
          }
          msg.reply(answer.text, { htmlBody: answer.html, name: SETTINGS.FROM_NAME, replyTo: addr });
          count++;
        });
      });
      props.setProperty('CHAT_ANSWERED', JSON.stringify(answered.slice(-300)));
      if (count) Logger.log('Answered %s question(s).', count);
    } finally {
      lock.releaseLock();
    }
  }

  return {
    TZ: TZ,
    list: list,
    checkToken: checkToken,
    sendReport: sendReport,
    answerQuestion: answerQuestion,
    checkQuestions: checkQuestions,
    startChat: startChat,
    // for local testing
    _buildReport: buildReport,
    _renderHtml: renderHtml,
    _extractQuestion: extractQuestion,
  };
})();
