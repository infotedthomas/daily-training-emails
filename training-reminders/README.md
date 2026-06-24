# Training Reminder Worker (v2)

Cloudflare Worker that automates session email reminders with a two-phase approval workflow.

## How It Works

**Phase 1** (~11 AM ET, cron): For each session today, reads the host's Slack message, determines what to do, and either auto-schedules or creates a draft for review.

**Phase 2** (~12:15–1:55 PM ET, cron every 20 min): Checks for "go ahead" replies on any pending drafts. Schedules approved broadcasts. Reminds the channel once about anything still waiting. Because it runs repeatedly, a late approval still goes out (if approved after the planned send time, it goes ~2 minutes later).

> **Auth:** every HTTP endpoint except the health check (`GET /`) requires an `X-Admin-Token: <ADMIN_TOKEN>` header (or `Authorization: Bearer <ADMIN_TOKEN>`). Set `ADMIN_TOKEN` as a secret (see Setup).

### Smart Approval Logic

| Situation | What happens |
|---|---|
| Host posts changes | AI merges into template, creates **draft**, posts preview. Requires "go ahead" to send. |
| Host posts "no changes needed" | Uses default template, **auto-schedules**. No approval needed. |
| Someone posts "skip" or "no session today" | Suppressed entirely. Confirmation posted. |
| Nobody posts anything | Uses default template, **auto-schedules**. Warning posted. |

Changes require human approval. Unchanged templates don't. This follows the automate-vs-augment principle: no taste required = automate; taste required = augment with a human checkpoint.

---

## Session Schedule

| Day | Session | Host | Reminder Sends | Session Time |
|-----|---------|------|---------------|-------------|
| Monday | Training | David Baker | 1:00 PM ET | 2:00 PM ET |
| Tuesday | Training | David Baker | 1:00 PM ET | 2:00 PM ET |
| Thursday | Training | Jeff Austin | 1:00 PM ET | 2:00 PM ET |
| Thursday | IBGS | Lance | 2:00 PM ET | 3:00 PM ET |
| Friday | Training | Lance | 1:00 PM ET | 2:00 PM ET |

---

## Setup

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Slack Bot

Create a Slack app (or use existing) with these Bot Token Scopes:
- `channels:history` - read messages
- `chat:write` - post previews and confirmations

Install to workspace. Copy the Bot User OAuth Token (xoxb-...).

Create a channel (e.g. `#training-reminders`) where:
- David, Lance, and Jeff post their updates
- The bot posts previews and confirmations
- Anyone can reply "go ahead" or "cancel"

Invite the bot to the channel.

### 3. Get IDs

- **Channel ID**: Right-click channel name > View channel details > ID at bottom
- **User IDs**: Click each person's profile > three dots > Copy member ID
- **Kit API key**: Kit > Settings > Developer > Create V4 key
- **Kit template ID**: `curl -H "X-Kit-Api-Key: KEY" https://api.kit.com/v4/email_templates`
- **Kit tag/segment IDs**: Kit > Subscribers > Tags (or Segments) > click the relevant one > ID in URL
- **Gemini API key**: Google AI Studio (https://aistudio.google.com/apikey) > Create API key (free tier)

### 4. Configure wrangler.toml

Fill in all the placeholder values. See comments in the file for guidance.

### 5. Create KV Namespace

```bash
wrangler kv namespace create KV
```

Paste the printed ID into wrangler.toml.

### 6. Set Secrets

```bash
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put GEMINI_API_KEY
wrangler secret put KIT_API_KEY
wrangler secret put ADMIN_TOKEN   # any long random string; guards the HTTP endpoints
```

### 7. Deploy

```bash
npm install
wrangler deploy
```

### 8. Upload Templates

The five email files live in the parent `KitTemplates` folder. Upload all of them in one go:

```bash
export WORKER_URL=https://training-reminders.YOUR_SUBDOMAIN.workers.dev
export ADMIN_TOKEN=the-token-you-set-above

node scripts/upload-template.js --all
```

Or upload a single day (also how you push a **live daily edit** — edit the `.txt` file, then re-run):

```bash
node scripts/upload-template.js monday "../1 Monday email.txt"
```

Raw `curl` equivalent (note the auth header):

```bash
curl -X PUT $WORKER_URL/template/monday \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: text/html" \
  --data-binary @"../1 Monday email.txt"
```

Template types: `monday`, `tuesday`, `thursday`, `ibgs`, `friday`.

### 8a. Compliance Footer (address + unsubscribe)

Kit v4 has no "clone broadcast" endpoint, so API-created broadcasts don't inherit a prior broadcast's footer. To guarantee every send carries the mailing address and unsubscribe link, store a footer once — the worker appends it to every broadcast's content (after any AI edit):

```bash
curl -X PUT $WORKER_URL/footer \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: text/html" \
  --data-binary @footer.html
```

Use the exact footer HTML (with the address merge field + unsubscribe link) from one of your existing broadcasts. **Skip this step if your Kit email template (`KIT_EMAIL_TEMPLATE_ID`) already includes the footer** — otherwise it would appear twice.

---

## How Hosts Submit Updates

Post in the channel before 11 AM ET. Keep it simple.

**Want changes:**
> Today we're covering how to read the tax sale list. Remind them to bring their county list from last week.

**Custom subject line:**
> SUBJECT: Special Guest Today at 2 PM ET!
> We have a special guest joining to share their first deal experience.

**No changes:**
> No changes needed

**On behalf of someone else:**
> David's email - no changes needed

**Skip a session:**
> No session today - holiday

---

## Endpoints

All endpoints except `GET /` require the `X-Admin-Token` header.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Health check |
| POST | `/phase1` | Manually run draft phase |
| POST | `/phase2` | Manually run approval phase |
| POST | `/trigger?session=KEY` | Process one session |
| POST | `/force-approve?session=KEY` | Emergency: schedule pending broadcast without approval |
| GET | `/pending` | List pending approvals |
| PUT | `/template/TYPE` | Upload template HTML |
| GET | `/template/TYPE` | View stored template |
| GET | `/templates` | List all templates |

Session keys: `mon-training`, `tue-training`, `thu-training`, `thu-ibgs`, `fri-training`
Template types: `monday`, `tuesday`, `thursday`, `ibgs`, `friday`

---

## Monitoring

```bash
wrangler tail
```

Watch the Slack channel for all confirmations, warnings, and approval requests.

---

## Troubleshooting

**"No template in KV"** — Upload the HTML template for that day. See step 8.

**Bot can't read messages** — Make sure it's in the channel and has `channels:history` scope.

**"Still waiting for approval" but nobody replied** — Reply "go ahead" in the thread (not as a new message). Or use `/force-approve?session=KEY` endpoint.

**Wrong send time** — The code handles EDT/EST automatically. Verify with a manual `/trigger` call and check the `sendAt` in the response.

**Kit rejects the broadcast** — Check that your API key is V4, the template ID exists, and the tag/segment ID is valid. The Kit error message in the Slack notification will usually say what's wrong.
