# Training Reminder Worker

Cloudflare Worker that turns the hosts' Slack messages into scheduled Kit email
reminders — **in real time**. A host posts what their session covers, and the bot
builds and schedules the reminder email automatically; if they change their mind,
the latest message always wins.

- **Runtime:** Cloudflare Workers + Workers AI (Llama 3.3 70B — no external AI key)
- **Email:** Kit (ConvertKit) v4 API
- **Input:** Slack (real-time Events webhook, plus scheduled cron passes as a safety net)

---

## How it works

### Real-time (primary)
Slack pushes every channel message to `POST /slack/events` (signature-verified). The
bot routes it to the right session, builds the email, and **schedules it** for the
session's send time. Posting again **replaces** the prior one — the host's newest
message always wins. Each scheduled email gets a **stable per-session preview link**
that always resolves to the current version.

### Cron (safety net, ET — DST-proof)
The Worker dispatches by the current Eastern time, so the same schedule works in EDT
and EST:

| Time (ET) | What happens |
|---|---|
| **12:00 PM** (Mon/Tue/Thu/Fri) | Reminder — @-mentions a host **only if** he hasn't posted yet and it isn't already scheduled |
| **12:40 PM** (Mon/Tue/Thu/Fri) | Schedule the 1 PM training emails (host's update, or the default) |
| **1:30 PM** (Thu) | IBGS reminder to Lance, only if no `IBGS email:` yet |
| **1:45 PM** (Thu) | Schedule the 2 PM IBGS email |

### Optimistic model (no approval gate)
Emails are **scheduled and ready** as soon as a host posts (or the cron runs). You
review silently; to change one, **post a correction** (latest-wins) or reply
**`cancel`** to pull it. While the system is **paused**, everything is made as a
*draft* (never sends) — see Operations.

---

## Sessions & per-host handling

| Day | Session | Host | Send | Input style |
|-----|---------|------|------|-------------|
| Mon | Training | David | 1 PM ET | **Shorthand** — "Virginia today and tomorrow for Thomas Ball" |
| Tue | Training | David | 1 PM ET | Shorthand (counties; stays general until he names them) |
| Thu | Training | Jeff Austin | 1 PM ET | **Short note** — "today is AARAuctions.com" → merged into the template |
| Thu | IBGS | Lance | 2 PM ET | Message starting **`IBGS email:`** → AI-formatted, conditional exec-summary link |
| Fri | Training | Lance | 1 PM ET | **Complete copy** — formatted faithfully (bullets preserved); subtitle locked |

- **David (Mon/Tue):** AI extracts the **state, counties, and requesting student** from his shorthand and writes the email. Tuesday stays general ("selected counties") until counties are given. If he posts nothing, a **generic** version is used.
- **Jeff (Thu):** his short note is **merged** into the template (body + header subtitle become the topic; the rest is untouched).
- **Lance (Fri):** he sends the whole email body; it's formatted **faithfully** (wording + bullet lists kept). His subheader stays **"Live Research Strategies with Lance."**
- **Lance (IBGS):** the body, header line, and subject are written from his `IBGS email:` post; the **"Download the executive summary"** link is added only when he includes a URL.

---

## How hosts (or the coordinator) submit updates

Post in the channel any time before the session's run. Routing matches the **day** or
**host name** (or the poster's identity), so all of these work:

**Lance / Friday (complete copy + optional subject):**
```
Make changes to my Friday email
Subject line: Today at 2PM: how to use the Magic Map to find deals

Hi <first name>,
Join Lance today at 2 PM Eastern ...
You'll learn how to:
- Navigate the map
- Find profitable properties
```

**David / Monday+Tuesday (shorthand):**
> David: Virginia today and tomorrow for Thomas Ball (put him in the email)

**Jeff / Thursday (short note):**
> Jeff Austin: today's class is on how to use the AARAuctions.com website

**IBGS (Lance):**
> IBGS email:
> Hi Everyone, ... (full body) ...
> the executive summary https://.../IBGS-Class-X.pdf      ← or → "No executive summary"

**No changes:** `Lance: no changes`  •  **Skip:** `No session today - holiday`

Notes:
- **Subject line:** add `Subject: ...` or `Subject line: ...` to override (asterisks/markdown stripped — subjects are plain text).
- **Bold:** bolding text in Slack (`*text*`) renders as **bold** in the email body.
- **Coordinator on behalf:** the coordinator (`ADMIN_SLACK_ID`) can post for any host. Because there are two Jeffs (coordinator Jeff F. vs host Jeff A.), posting for the host requires **"Jeff Austin"** / **"Jeff A"** — bare "Jeff" won't trigger it. David/Lance just need their first name, or the day word.

---

## Weekly schedule block

Every email contains a shared **"This Week's Sessions"** block, injected at the
`<!--WEEKLY_SCHEDULE-->` placeholder with **"← Today"** auto-marked. Each slot has a
**generic default**; David's Monday post fills in the Mon/Tue lines (state/counties).
Overrides are **week-stamped and auto-reset every Monday**, so last week's topics
never linger. Set lines manually with `POST /schedule {"mon":"..."}`.

---

## Repo layout

- `current/` — the **live** templates the bot uses (placeholder shells for the
  dynamically-generated days). `scripts/upload-template.js` reads from here.
- `default/` — complete, ready-to-send **generic** emails per day, as a manual fallback.

---

## Setup

### 1. Wrangler + Cloudflare
```bash
npm install
npx wrangler login          # use the account that hosts the Worker
```

### 2. Slack app
Bot Token Scopes: `groups:history` (private channel), `chat:write`, `channels:join`.
**Event Subscriptions:** enable, set Request URL to `https://<worker>/slack/events`,
subscribe to **`message.groups`** (private channel), Save, reinstall. Invite the bot
to the channel.

### 3. KV namespace
```bash
npx wrangler kv namespace create KV     # paste the id into wrangler.toml
```

### 4. Config (`wrangler.toml [vars]`)
`SLACK_CHANNEL_ID`, `DAVID_SLACK_ID`, `LANCE_SLACK_ID`, `JEFF_SLACK_ID`,
`ADMIN_SLACK_ID` (coordinator), `WORKER_URL`, `AI_MODEL`, and the Kit tag filters
(`KIT_DEFAULT_FILTER_ID`, `KIT_THU_IBGS_FILTER_ID`, …). The cron list covers both
EDT and EST UTC times — the handler acts only at the intended ET moment.

### 5. Secrets
```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET   # verifies the Events webhook
npx wrangler secret put KIT_API_KEY
npx wrangler secret put ADMIN_TOKEN            # guards admin HTTP endpoints
npx wrangler secret put PREVIEW_TOKEN          # low-privilege token for preview links
```
(AI uses the Workers AI binding — no key.)

### 6. Deploy + seed templates
```bash
npx wrangler deploy
export WORKER_URL=https://<worker>.workers.dev ADMIN_TOKEN=...
node scripts/upload-template.js --all          # uploads current/*.txt to KV
# single day (also how a live template edit is pushed):
node scripts/upload-template.js friday "../current/4 Friday email.txt"
```

> **Compliance footer:** Kit **auto-injects** the mailing address + unsubscribe footer
> at send time, so the templates carry only the "Ted Thomas Training Facilitator Team"
> signature — do **not** add address/unsubscribe lines, or they'd appear twice.

---

## Operations

- **Pause / resume:** `POST /pause` and `POST /resume`. While paused, cron runs are
  skipped and real-time posts make **drafts** (no sends). `GET /` shows `paused`.
- **Preview:** `GET /preview?session=<key>&token=<PREVIEW_TOKEN>` always shows that
  session's current broadcast. (`?broadcast=<id>` also works.)
- **Manually-scheduled emails:** the cron doesn't know about broadcasts created
  outside the Worker — set a `done:<session>:<date>` KV marker so it won't double-up.
- **Monitor:** `npx wrangler tail`, and watch the Slack channel for confirmations.

---

## Endpoints

All except `GET /` and `POST /slack/events` require `X-Admin-Token: <ADMIN_TOKEN>`
(preview also accepts `PREVIEW_TOKEN` via `?token=`).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Health check (shows `paused`) |
| POST | `/slack/events` | Slack Events webhook (signature-verified) |
| GET | `/preview?session=KEY` or `?broadcast=ID` | Render an email (subject banner + body) |
| POST | `/pause` · `/resume` | Global kill-switch |
| POST | `/trigger?session=KEY` | Run one session — **dry-run by default**; add `&live=1` to actually schedule |
| POST | `/phase1` | Run today's scheduling pass for all sessions |
| POST | `/remind?kind=training\|ibgs` | Fire reminders manually |
| GET/POST/DELETE | `/schedule` | View / set / reset the weekly schedule overrides |
| PUT/GET | `/template/TYPE` · GET `/templates` | Manage stored templates |
| PUT/GET | `/footer` | Optional appended footer (unused — Kit auto-injects) |
| POST | `/merge-test` · `/david-test` · `/ibgs-test` | Build a draft from sample text (no send) |

Session keys: `mon-training`, `tue-training`, `thu-training`, `thu-ibgs`, `fri-training`
Template types: `monday`, `tuesday`, `thursday`, `ibgs`, `friday`

---

## Troubleshooting

- **A post didn't trigger anything** — it must name the day/host (e.g. "Friday", "David", "Jeff Austin") or come from the host's account, and be substantive (short chatter is ignored). For Jeff Austin on behalf, use "Jeff Austin"/"Jeff A".
- **It made a draft, not a scheduled send** — the system is **paused**. `POST /resume`.
- **Schedule shows generic Mon/Tue** — David hasn't posted yet this week (overrides reset each Monday), or set them via `POST /schedule`.
- **Wrong send time** — EDT/EST is handled automatically; check the `send_at` returned by a `/trigger` call.
- **Kit rejects a broadcast** — confirm the V4 API key and the tag ID; the error surfaces in the Slack message.
