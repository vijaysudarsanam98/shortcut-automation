# Shortcut daily team report + email assistant

Every weekday at **9:00 AM IST**, this emails the team a report from Shortcut:

1. **Sprint progress**: current sprint, dates, days left, done / in progress / not started, % complete
2. **Customer-priority tickets**: new in the last 24 hours (who raised them, when) and all open ones, with owner, status and PR
3. **Needs attention**: in progress 3+ days with no PR, merged PR but not Done, PRs open 3+ days, blocked, no owner, no estimate
4. **Work status by person**: each person's tickets with their Shortcut status and PR status (No PR / open / draft / merged / closed)

Statuses use your board's own names (In Development, PR Review, Ready in QA, …) in board order. To keep the email under Gmail's size limit, not-started tickets appear as links in the email. A **full report with every story** is attached.

It also runs an **email assistant**. Anyone on the list can reply to the report, or email the assistant address, and get an answer from Shortcut, usually within 15–30 minutes. The assistant covers every ticket in the workspace, not only the current sprint. Things you can ask:

| Write | You get |
|---|---|
| `sc-1234` or `status of 1234` | The ticket's state, owner, PRs and latest comments |
| `what is Priya working on` | That person's in-progress tickets |
| `in progress` | Everything in development, across all teams |
| `Ready in QA` | Tickets in any status, by its name |
| `backend bugs` · `iOS in progress` | Any label, story type, or combination |
| `Engineering team blocked` | Any team, with blocked / in progress / done |
| `Severity 0 bugs` · `Highest priority` | Any Priority, Severity or other field value |
| `bugs in this sprint` · `Squid Game done` | Any sprint by name, or "this sprint" |
| `customer priority` | Open customer-priority tickets |
| `blocked` / `blocked tickets for Arjun` | Blocked tickets (for one person if you name them) |
| `sprint status` | Current sprint progress |
| `needs attention` | This sprint's flags |
| `new tickets` | Tickets created in the last 24 hours |
| anything else, e.g. `login timeout` | Keyword search across all tickets |
| `help` | This list |

Labels, statuses, teams, sprints, epics, field values and people are read live from Shortcut every time, so new ones work without changing anything. The assistant uses fixed rules, with no AI service, so it costs nothing. It only answers people on the allowed list.

---

## 1. One-time setup on your computer

You need **Node.js 18 or newer**. Check by opening Terminal and typing `node -v`. If it says "command not found", download the LTS version from https://nodejs.org and install it.

In the project folder, run:

```bash
npm install
cp .env.example .env     # creates your private settings file
```

Open `.env` in VS Code and fill it in (steps below). `.env` is never uploaded to GitHub.

### Shortcut token
Shortcut → click your avatar → **Settings** → **Your Account** → **API Tokens** → **Generate Token**. Copy it into `SHORTCUT_API_TOKEN=`.

### Gmail app password
Gmail won't accept your normal password from a program. It needs an **App Password**:

1. Go to https://myaccount.google.com/security
2. Turn on **2-Step Verification** if it's off (App Passwords require it).
3. Go to https://myaccount.google.com/apppasswords
4. Name it `Shortcut report` and click **Create**.
5. Copy the 16-letter password into `EMAIL_PASSWORD=`. Spaces don't matter.
6. Put the Gmail address in `EMAIL_USER=`.

For the assistant, Gmail's IMAP access must be on: Gmail → ⚙️ → **See all settings** → **Forwarding and POP/IMAP** → **Enable IMAP** → Save. Newer Gmail accounts have it on already.

> **Tip:** use a separate Gmail account just for this, such as `yourteam.reports@gmail.com`. The assistant then never touches anyone's personal inbox.

### Choose how "customer priority" is marked

```bash
npm run list-config
```

This lists your labels, Priority values, workflow states and teams. Fill in any of these in `.env`. A ticket counts if it matches **any** of them. Current setup:

```
CUSTOMER_LABELS=CustomerIssue
CUSTOMER_STATES=Customer Priority
```

Other options: `CUSTOMER_PRIORITY_VALUES=Highest,High`, `CUSTOMER_STORY_TYPES=bug`, `CUSTOMER_TEAMS=Customer Success`.

### Preview before anything is emailed

```bash
npm run report:dry                      # saves report.html, so open it in your browser
npm run ask -- "what is Priya working on"   # tries the assistant, saves answer.html
npm run report                          # sends the real email
```

---

## 2. Run it automatically with GitHub Actions

The schedules live in [.github/workflows/](.github/workflows/). They need your settings stored in GitHub:

Repo on github.com → **Settings** → **Secrets and variables** → **Actions**.

**Secrets** tab, "New repository secret", one per line (hidden, even from you after saving):

| Name | Value |
|---|---|
| `SHORTCUT_API_TOKEN` | your Shortcut token |
| `EMAIL_USER` | the Gmail address |
| `EMAIL_PASSWORD` | the 16-letter app password |
| `REPORT_RECIPIENTS` | e.g. `shreedevi@adhish.in,another@adhish.in` |
| `CHAT_ALLOWED_SENDERS` | optional, e.g. `@adhish.in` lets anyone at the company ask |

**Variables** tab, "New repository variable" (visible, easy to edit later):

| Name | Example |
|---|---|
| `EMAIL_PROVIDER` | `gmail` |
| `CUSTOMER_LABELS` | `CustomerIssue` |
| `CUSTOMER_STATES` | `Customer Priority` |
| `ITERATION_TEAM` | only if several teams run sprints at once |

Then upload the code (commit and push). To test right away: **Actions** tab → **Daily Shortcut report** → **Run workflow**.

> ⚠️ This repository is **public**. The code holds no secrets and the logs show only counts, but consider making it private: **Settings → General → Danger Zone → Change visibility**. Private repos get 2,000 free Actions minutes a month. The two schedules use about 900–1,000 minutes, so they fit.

---

## 3. Everyday changes

**Change recipients:** edit the `REPORT_RECIPIENTS` secret on GitHub (and in `.env` for local runs). Separate addresses with commas.

**Change the send time:** edit the `cron` line in [.github/workflows/daily-report.yml](.github/workflows/daily-report.yml). GitHub uses UTC, which is IST minus 5½ hours:

| IST | cron |
|---|---|
| 9:00 AM | `30 3 * * 1-5` |
| 9:30 AM | `0 4 * * 1-5` |
| 10:00 AM | `30 4 * * 1-5` |

`1-5` means Monday to Friday.

**Change how often questions are checked:** edit the `cron` in [.github/workflows/chat-replies.yml](.github/workflows/chat-replies.yml). For instant replies, leave `npm run chat:watch` running on an always-on computer instead.

**Change the "3 days" threshold:** set the `FLAG_STALE_DAYS` variable.

**Count more statuses as finished (optional):** by default only Shortcut's "done" statuses (e.g. Completed) count. To also count others, set `DONE_STATES=Ready in Production`. To stop flagging merged PRs that are already in QA, set `MERGED_OK_STATES=Ready in QA,Completed in QA,Ready in Production`. On GitHub, add them as variables.

---

## 4. Handing this over to someone else

1. Add them to the GitHub repo (**Settings → Collaborators**), or transfer the repo.
2. They create their **own** Shortcut token and replace the `SHORTCUT_API_TOKEN` secret. Then delete your old token in Shortcut.
3. If the sending Gmail account changes, they create a new app password and update `EMAIL_USER` / `EMAIL_PASSWORD`.
4. Point them to this README. Nothing else needs to be installed on a server.

## If something goes wrong

| Message | Fix |
|---|---|
| "Shortcut rejected the API token" | Copy the token again, with no spaces or quotes |
| "No current sprint found" | In Shortcut, check the current iteration is *started* and its dates include today |
| "The email server rejected the login" | Use a Gmail **App Password**, not your normal password |
| "Could not log in to the mailbox" | Turn on IMAP in Gmail settings |
| Report OK but no customer tickets | Run `npm run list-config` and check the `CUSTOMER_*` names match exactly |

Run failures show up on GitHub's **Actions** tab, and GitHub emails the repo owner.

## Without GitHub

On a Mac that is on at 9:00 AM, run `crontab -e` and add:

```
0 9 * * 1-5 cd /path/to/shortcut-automation && /usr/local/bin/npm run report
```

Find the right npm path with `which npm`. For the assistant, keep `npm run chat:watch` running on that computer.

## Project layout

| File | What it does |
|---|---|
| `src/shortcut.js` | Talks to the Shortcut API (rate limits, retries, paging) |
| `src/workspace.js` | People, states, PR status and customer-priority rules |
| `src/report-builder.js` | Collects the report data |
| `src/email-template.js`, `src/html.js` | Email layout (HTML and plain text) |
| `src/mailer.js` | Sends email |
| `src/assistant.js` | Understands questions and builds answers |
| `src/chat.js` | Reads the mailbox and replies |
| `src/list-config.js` | The `list-config` helper |
