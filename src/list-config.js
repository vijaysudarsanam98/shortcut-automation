// Helper: lists labels, custom fields, workflow states, story types and teams
// so you can choose how "customer priority" is marked.
import * as sc from './shortcut.js';
import { config, requireShortcut, customerRuleConfigured } from './config.js';
import { todayIST } from './time.js';
import { runMain } from './run.js';

function heading(t) {
  console.log('\n' + t + '\n' + '-'.repeat(t.length));
}

runMain(async () => {
  requireShortcut();
  const [labels, fields, workflows, groups, iterations] = await Promise.all([
    sc.getLabels(),
    sc.getCustomFields(),
    sc.getWorkflows(),
    sc.getGroups(),
    sc.getIterations(),
  ]);

  heading('LABELS  (use with CUSTOMER_LABELS)');
  const active = labels.filter((l) => !l.archived).sort((a, b) => a.name.localeCompare(b.name));
  console.log(active.length ? active.map((l) => `  ${l.name}`).join('\n') : '  (no labels)');

  heading('CUSTOM FIELDS  (Priority values go in CUSTOMER_PRIORITY_VALUES)');
  if (!fields.length) console.log('  (no custom fields)');
  for (const f of fields) {
    const tag = f.canonical_name === 'priority' ? '  <- built-in Priority field' : '';
    console.log(`  ${f.name}${f.enabled === false ? ' (disabled)' : ''}${tag}`);
    for (const v of f.values || []) console.log(`      - ${v.value}`);
  }

  heading('WORKFLOW STATES  (use with CUSTOMER_STATES; type: unstarted / started / done)');
  for (const wf of workflows) {
    console.log(`  Workflow: ${wf.name}`);
    for (const s of wf.states || []) console.log(`      - ${s.name}  [${s.type}]`);
  }

  heading('STORY TYPES  (use with CUSTOMER_STORY_TYPES)');
  console.log('  feature, bug, chore');

  heading('TEAMS  (use with CUSTOMER_TEAMS or ITERATION_TEAM)');
  const activeGroups = groups.filter((g) => !g.archived);
  console.log(activeGroups.length ? activeGroups.map((g) => `  ${g.name}`).join('\n') : '  (no teams)');

  heading('CURRENT ITERATIONS');
  const today = todayIST();
  const current = iterations.filter((i) => i.status === 'started' && i.start_date <= today && today <= i.end_date);
  console.log(
    current.length
      ? current.map((i) => `  ${i.name}  (${i.start_date} to ${i.end_date})`).join('\n')
      : `  None running today (${today}).`
  );

  heading('YOUR CURRENT CUSTOMER-PRIORITY SETTING');
  if (!customerRuleConfigured()) console.log('  Not set yet.');
  else {
    const c = config.customer;
    if (c.labels.length) console.log(`  Labels: ${c.labels.join(', ')}`);
    if (c.priorityValues.length) console.log(`  Priority values: ${c.priorityValues.join(', ')}`);
    if (c.storyTypes.length) console.log(`  Story types: ${c.storyTypes.join(', ')}`);
    if (c.teams.length) console.log(`  Teams: ${c.teams.join(', ')}`);
    if (c.states.length) console.log(`  Workflow states: ${c.states.join(', ')}`);
  }
  console.log('');
});
