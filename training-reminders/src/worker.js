// ============================================================
// Training Reminder Worker — v2
//
// Two-phase workflow:
//   Phase 1 (cron, ~11 AM ET): Read Slack, create drafts, post previews
//   Phase 2 (cron, ~12:15 PM ET): Check for "go ahead" replies, schedule
//
// Smart approval:
//   No changes to template → auto-schedule (no taste needed)
//   AI merged changes → require "go ahead" (taste checkpoint)
//
// Skip handling:
//   Host or anyone posts "skip" / "no session today" → suppressed
//   Host or anyone posts "no changes" → sends default template
//   No message at all → sends default template
// ============================================================


// --------------- SESSION CONFIG ---------------

function buildSessions(env) {
  return [
    {
      key: 'mon-training',
      label: 'Monday Training (David)',
      dayOfWeek: 1,
      host: 'david',
      sendHour: 13, sendMinute: 0,
      sessionTime: '2:00 PM ET',
      templateKey: 'template:monday',
      defaultSubject: 'Reminder: Training Session Today at 2 PM ET',
    },
    {
      key: 'tue-training',
      label: 'Tuesday Training (David)',
      dayOfWeek: 2,
      host: 'david',
      sendHour: 13, sendMinute: 0,
      sessionTime: '2:00 PM ET',
      templateKey: 'template:tuesday',
      defaultSubject: 'Reminder: Training Session Today at 2 PM ET',
    },
    {
      key: 'thu-training',
      label: 'Thursday Training (Jeff)',
      dayOfWeek: 4,
      host: 'jeff',
      sendHour: 13, sendMinute: 0,
      sessionTime: '2:00 PM ET',
      templateKey: 'template:thursday',
      defaultSubject: 'Coach Jeff Austin Training Session starts at 2:00PM',
    },
    {
      key: 'thu-ibgs',
      label: 'Thursday IBGS (Lance)',
      dayOfWeek: 4,
      host: 'lance',
      sendHour: 14, sendMinute: 0,
      sessionTime: '3:00 PM ET',
      templateKey: 'template:ibgs',
      defaultSubject: 'Reminder: IBGS Session Today at 3 PM ET',
    },
    {
      key: 'fri-training',
      label: 'Friday Training (Lance)',
      dayOfWeek: 5,
      host: 'lance',
      sendHour: 13, sendMinute: 0,
      sessionTime: '2:00 PM ET',
      templateKey: 'template:friday',
      defaultSubject: 'Today at 2PM - Lance Shows You How to Narrow an Auction List',
      lockSubtitle: true,     // subheader stays "Live Research Strategies with Lance"
      hostProvidesBody: true, // Lance sends complete copy — format it faithfully, don't merge
    },
  ];
}

function getHost(hostKey, env) {
  const hosts = {
    david: { name: 'David Baker', slackId: env.DAVID_SLACK_ID },
    lance: { name: 'Lance', slackId: env.LANCE_SLACK_ID },
    jeff:  { name: 'Jeff Austin', slackId: env.JEFF_SLACK_ID },
  };
  return hosts[hostKey];
}

// How the coordinator must name a host to post on his behalf. Jeff Austin needs
// "Jeff Austin" / "Jeff A" (NOT bare "Jeff") so it can't be confused with the
// coordinator, who is also named Jeff.
function hostRefRegex(hostKey) {
  return {
    david: /\bdavid\b/i,
    lance: /\blance\b/i,
    jeff:  /\bjeff\s+(austin|a)\b/i,
  }[hostKey];
}


// --------------- WEEKLY SCHEDULE (shared across all emails) ---------------
//
// One schedule, injected into every template at the <!--WEEKLY_SCHEDULE-->
// placeholder, with the current session's row marked "← Today". Each slot has a
// generic default; anything stored in KV ('schedule:overrides') replaces it.
// Update overrides anytime (manually via /schedule, or from host Slack posts),
// and every email built afterward reflects the latest.

function buildScheduleSlots() {
  return [
    { key: 'mon',  day: 'Monday',    time: '2:00 PM', label: 'State Tax Sales with David',                  sessionKey: 'mon-training' },
    { key: 'tue',  day: 'Tuesday',   time: '2:00 PM', label: 'County Deep Dive with David',                 sessionKey: 'tue-training' },
    { key: 'wed',  day: 'Wednesday', time: '9:00 PM', label: 'Weekly Q&A with a Certified Coach',           sessionKey: null },
    { key: 'thu',  day: 'Thursday',  time: '2:00 PM', label: 'Online Auction Tools with Coach Jeff Austin', sessionKey: 'thu-training' },
    { key: 'ibgs', day: 'Thursday',  time: '3:00 PM', label: 'Intensive Business Growth System (IBGS)',     sessionKey: 'thu-ibgs', members: true },
    { key: 'fri',  day: 'Friday',    time: '2:00 PM', label: 'Live Research Strategies with Lance',         sessionKey: 'fri-training' },
  ];
}

async function getScheduleOverrides(env) {
  try { return JSON.parse(await env.KV.get('schedule:overrides') || '{}'); }
  catch (e) { return {}; }
}

async function getScheduleData(env) {
  const overrides = await getScheduleOverrides(env);
  return buildScheduleSlots().map(s => {
    const ov = overrides[s.key] && String(overrides[s.key]).trim();
    return { key: s.key, day: s.day, time: s.time, topic: ov || s.label, isDefault: !ov };
  });
}

async function renderScheduleBlock(env, todaySessionKey, extraOverrides = null) {
  const overrides = { ...(await getScheduleOverrides(env)), ...(extraOverrides || {}) };
  const rows = buildScheduleSlots().map(s => {
    const topic = (overrides[s.key] && String(overrides[s.key]).trim()) || s.label;
    const star = s.members ? '*' : '';
    const today = s.sessionKey && s.sessionKey === todaySessionKey ? ' <strong>← Today</strong>' : '';
    return `      <p><strong>${s.day} ${s.time}</strong> - ${topic}${star}${today}</p>`;
  }).join('\n');
  return [
    '    <div class="weekly-schedule">',
    `      <p class="schedule-header">This Week's Sessions</p>`,
    rows,
    '      <p style="margin-top: 10px; font-size: 12px; color: #999;">*Available to registered members only</p>',
    '    </div>',
  ].join('\n');
}

// Turn a host's free-form Slack update into a SHORT schedule line for their
// slot, styled like the slot's generic default. Used to auto-update the weekly
// schedule when a host posts. Falls back to the default on any error.
async function scheduleTopicFromUpdate(hostText, slot, env) {
  const prompt = `Rewrite the host's update as ONE short "This Week's Sessions" schedule line.
Match the style, format, and length of this example exactly (keep the "with <name>" ending if present):
"${slot.label}"
Host update: ${hostText}
Output ONLY the line itself — no quotes, no trailing period, no preamble, max ~10 words.`;
  try {
    const model = env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const result = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], max_tokens: 48 });
    const line = (result.response || '').trim().split('\n')[0].replace(/^["']|["']$/g, '').replace(/\.\s*$/, '').trim();
    return line || slot.label;
  } catch (e) {
    return slot.label;
  }
}


// --------------- ENTRY POINTS ---------------

export default {
  async scheduled(event, env, ctx) {
    // Global kill-switch: while paused, no cron does anything.
    if (await env.KV.get('paused')) {
      console.log('Paused — skipping cron', event.cron);
      return;
    }

    // Dispatch by the CURRENT Eastern time (not the cron string), so the same
    // schedule works year-round through EDT/EST. Crons are set to fire at both
    // seasons' UTC equivalents; only the intended ET slot acts.
    const { hour, minute, dow } = nowET();
    const trainingDay = [1, 2, 4, 5].includes(dow); // Mon, Tue, Thu, Fri
    const at = (h, m) => hour === h && minute === m;

    let results = null;
    if (trainingDay && at(12, 0)) {
      results = await runReminders(env, 'training');     // 12:00 PM ET — nudge hosts
    } else if (trainingDay && at(12, 40)) {
      results = await runProcess(env, s => s.key !== 'thu-ibgs'); // 12:40 PM ET — schedule training
    } else if (dow === 4 && at(13, 30)) {
      results = await runReminders(env, 'ibgs');         // 1:30 PM ET — nudge Lance
    } else if (dow === 4 && at(13, 45)) {
      results = await runProcess(env, s => s.key === 'thu-ibgs'); // 1:45 PM ET — schedule IBGS
    } else {
      console.log(`Cron fired at ET ${hour}:${pad(minute)} dow=${dow} — no slot matched`);
      return;
    }
    console.log('Cron complete:', JSON.stringify(results));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check is the only unauthenticated route.
    if (url.pathname === '/' && request.method === 'GET') {
      return json({ status: 'ok', service: 'training-reminders', version: '2.4', paused: !!(await env.KV.get('paused')) });
    }

    // Slack Events webhook (real-time). Authenticated by Slack's signature, not
    // the admin token, so it sits before the auth gate.
    if (url.pathname === '/slack/events' && request.method === 'POST') {
      const raw = await request.text();
      let body;
      try { body = JSON.parse(raw); } catch { return new Response('bad', { status: 400 }); }
      // One-time URL verification handshake when you set the Request URL in Slack.
      if (body.type === 'url_verification') {
        return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } });
      }
      if (!(await verifySlackSignature(request, raw, env))) {
        return new Response('bad signature', { status: 401 });
      }
      // Acknowledge immediately (Slack requires <3s); process in the background.
      if (ctx && ctx.waitUntil) ctx.waitUntil(handleSlackEvent(body, env));
      else await handleSlackEvent(body, env);
      return new Response('ok');
    }

    // Email preview — rendered HTML of a broadcast, openable from a browser link.
    // Uses a separate low-privilege token (PREVIEW_TOKEN) so the link can be
    // posted in Slack without exposing the admin token. ADMIN_TOKEN also works.
    if (url.pathname === '/preview' && request.method === 'GET') {
      const t = url.searchParams.get('token');
      if (!env.ADMIN_TOKEN || (t !== env.ADMIN_TOKEN && t !== env.PREVIEW_TOKEN)) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const id = url.searchParams.get('broadcast');
      if (!id) return json({ error: 'Pass ?broadcast=ID' }, 400);
      const r = await fetch(`https://api.kit.com/v4/broadcasts/${id}`, {
        headers: { 'X-Kit-Api-Key': env.KIT_API_KEY },
      });
      if (!r.ok) return json({ error: `Kit get broadcast ${r.status}` }, 502);
      const b = (await r.json()).broadcast;
      const banner = `<div style="font-family:'Segoe UI',Tahoma,sans-serif;background:#1e4578;color:#fff;padding:10px 16px;font-size:14px;font-weight:600;">Subject: ${(b.subject || '(none)').replace(/</g, '&lt;')}</div>`;
      return new Response(banner + (b.content || '<p>(no content)</p>'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Everything else requires the admin token.
    const authError = requireAuth(request, env);
    if (authError) return authError;

    // Manual triggers
    if (url.pathname === '/phase1' && request.method === 'POST') {
      return json(await runProcess(env, () => true));
    }
    // Manually fire reminders for testing: POST /remind?kind=training|ibgs
    if (url.pathname === '/remind' && request.method === 'POST') {
      return json(await runReminders(env, url.searchParams.get('kind') === 'ibgs' ? 'ibgs' : 'training'));
    }
    if (url.pathname === '/phase2' && request.method === 'POST') {
      return json(await runApprovalPhase(env));
    }

    // Global pause / resume — while paused, all cron runs are skipped.
    if (url.pathname === '/pause' && request.method === 'POST') {
      await env.KV.put('paused', '1');
      return json({ ok: true, paused: true });
    }
    if (url.pathname === '/resume' && request.method === 'POST') {
      await env.KV.delete('paused');
      return json({ ok: true, paused: false });
    }

    // Test the merge path (Jeff/Lance training) from a host's update text.
    if (url.pathname === '/merge-test' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || !body.text || !body.session) return json({ error: 'POST {"text":"...","session":"thu-training"}' }, 400);
      const session = buildSessions(env).find(s => s.key === body.session);
      if (!session) return json({ error: 'unknown session' }, 400);
      const { subject, content } = await buildSessionEmail(session, body.text, env);
      const b = await createKitBroadcast({ subject, content, filterType: 'tag', filterId: parseInt(env.KIT_DEFAULT_FILTER_ID || '0') }, env);
      return json({ subject, broadcastId: b.id, preview: env.WORKER_URL ? `${env.WORKER_URL}/preview?broadcast=${b.id}&token=${env.PREVIEW_TOKEN || ''}` : null });
    }

    // Test David's Mon/Tue generation from his shorthand (assembles a draft).
    if (url.pathname === '/david-test' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || !body.update || !body.day) return json({ error: 'POST {"update":"...","day":"monday|tuesday"}' }, 400);
      const day = body.day === 'tuesday' ? 'tuesday' : 'monday';
      const g = await generateDavidContent(body.update, day, env);
      const template = await env.KV.get(`template:${day}`);
      let content = template.replace('<!--DAVID_SUBTITLE-->', g.subtitle).replace('<!--DAVID_INTRO-->', g.intro);
      if (content.includes('<!--WEEKLY_SCHEDULE-->')) {
        content = content.replace('<!--WEEKLY_SCHEDULE-->', await renderScheduleBlock(env, day === 'tuesday' ? 'tue-training' : 'mon-training'));
      }
      const b = await createKitBroadcast({ subject: g.subject, content, filterType: 'tag', filterId: parseInt(env.KIT_DEFAULT_FILTER_ID || '0') }, env);
      return json({
        state: g.state, counties: g.counties, student: g.student,
        subject: g.subject, subtitle: g.subtitle, broadcastId: b.id,
        preview: env.WORKER_URL ? `${env.WORKER_URL}/preview?broadcast=${b.id}&token=${env.PREVIEW_TOKEN || ''}` : null,
      });
    }

    // Test IBGS generation from raw update text (creates a draft, never sends).
    if (url.pathname === '/ibgs-test' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || !body.update) return json({ error: 'POST {"update":"IBGS email: ..."}' }, 400);
      const parsed = parseIBGSUpdate(body.update);
      if (!parsed.body) return json({ error: 'No body parsed from update' }, 400);
      const { content, gen } = await buildIBGS(parsed, env);
      const b = await createKitBroadcast({
        subject: gen.subject, content,
        filterType: env.KIT_THU_IBGS_FILTER_TYPE || 'tag',
        filterId: parseInt(env.KIT_THU_IBGS_FILTER_ID || env.KIT_DEFAULT_FILTER_ID || '0'),
      }, env);
      return json({
        headerLine: gen.headerLine, subject: gen.subject,
        execSummary: ibgsExecStatus(parsed),
        broadcastId: b.id,
        preview: env.WORKER_URL ? `${env.WORKER_URL}/preview?broadcast=${b.id}&token=${env.PREVIEW_TOKEN || ''}` : null,
      });
    }
    if (url.pathname === '/trigger' && request.method === 'POST') {
      const key = url.searchParams.get('session');
      const sessions = buildSessions(env);
      const session = sessions.find(s => s.key === key);
      if (!session) return json({ error: 'Unknown session', valid: sessions.map(s => s.key) }, 400);
      // SAFE BY DEFAULT: /trigger does a dry run (draft only, never sends).
      // Pass ?live=1 to actually run the real schedule/send path.
      const dryRun = url.searchParams.get('live') !== '1';
      const result = await processSingleSession(session, env, dryRun);
      // Only mark done on a real run, so the cron won't re-process & double-send.
      if (!dryRun) {
        await env.KV.put(`done:${session.key}:${getTodayDateET()}`, JSON.stringify(result), { expirationTtl: 86400 });
      }
      return json(result);
    }

    // Force-schedule a pending broadcast (emergency bypass)
    if (url.pathname === '/force-approve' && request.method === 'POST') {
      const key = url.searchParams.get('session');
      const dateStr = getTodayDateET();
      const pendingKey = `pending:${key}:${dateStr}`;
      const raw = await env.KV.get(pendingKey);
      if (!raw) return json({ error: 'No pending broadcast found for that session today' }, 404);
      const pending = JSON.parse(raw);
      await scheduleKitBroadcast(pending.broadcastId, pending.sendAt, env);
      await env.KV.delete(pendingKey);
      await postToSlack(env, `:zap: *${key}* - Force-approved and scheduled via HTTP.`);
      return json({ action: 'force_scheduled', broadcastId: pending.broadcastId });
    }

    // Template management
    if (url.pathname.startsWith('/template/')) {
      const type = url.pathname.replace('/template/', '');
      const validTypes = ['monday', 'tuesday', 'thursday', 'ibgs', 'friday'];
      if (!validTypes.includes(type)) {
        return json({ error: 'Valid types: ' + validTypes.join(', ') }, 400);
      }
      if (request.method === 'PUT') {
        const html = await request.text();
        if (!html || html.length < 50) return json({ error: 'Send HTML as body' }, 400);
        await env.KV.put(`template:${type}`, html);
        return json({ ok: true, type, bytes: html.length });
      }
      if (request.method === 'GET') {
        const html = await env.KV.get(`template:${type}`);
        if (!html) return json({ error: 'No template stored' }, 404);
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      }
    }
    if (url.pathname === '/templates' && request.method === 'GET') {
      const list = await env.KV.list({ prefix: 'template:' });
      return json({ templates: list.keys.map(k => k.name) });
    }

    // Weekly schedule (shared across all emails).
    //   GET    /schedule              -> current slots (topic + isDefault)
    //   POST   /schedule  {mon:"..."} -> set/merge overrides ("" clears a slot)
    //   DELETE /schedule              -> reset all slots to generic defaults
    if (url.pathname === '/schedule') {
      const validKeys = new Set(buildScheduleSlots().map(s => s.key));
      if (request.method === 'GET') {
        return json({ schedule: await getScheduleData(env) });
      }
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json({ error: 'Send JSON like {"mon":"State Tax Sales: Virginia with David"}', validSlots: [...validKeys] }, 400);
        }
        const overrides = await getScheduleOverrides(env);
        for (const [k, v] of Object.entries(body)) {
          if (!validKeys.has(k)) return json({ error: `Unknown slot "${k}"`, validSlots: [...validKeys] }, 400);
          if (v === '' || v === null) delete overrides[k];
          else overrides[k] = String(v);
        }
        await env.KV.put('schedule:overrides', JSON.stringify(overrides));
        return json({ ok: true, schedule: await getScheduleData(env) });
      }
      if (request.method === 'DELETE') {
        await env.KV.delete('schedule:overrides');
        return json({ ok: true, reset: true, schedule: await getScheduleData(env) });
      }
    }

    // Compliance footer (mailing address + unsubscribe), appended to every broadcast.
    if (url.pathname === '/footer') {
      if (request.method === 'PUT') {
        const html = await request.text();
        if (!html || html.length < 20) return json({ error: 'Send footer HTML as body' }, 400);
        await env.KV.put('footer', html);
        return json({ ok: true, bytes: html.length });
      }
      if (request.method === 'GET') {
        const html = await env.KV.get('footer');
        if (!html) return json({ error: 'No footer stored' }, 404);
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      }
    }

    // List pending approvals
    if (url.pathname === '/pending' && request.method === 'GET') {
      const list = await env.KV.list({ prefix: 'pending:' });
      const items = [];
      for (const k of list.keys) {
        items.push({ key: k.name, data: JSON.parse(await env.KV.get(k.name)) });
      }
      return json({ pending: items });
    }

    return json({ error: 'Not found' }, 404);
  },
};


// --------------- PHASE 1: CREATE DRAFTS ---------------

// Current Eastern time, DST-aware: { hour (0-23), minute, dow (0=Sun) }.
function nowET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const val = t => (parts.find(p => p.type === t) || {}).value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(val('hour'), 10);
  if (hour === 24) hour = 0; // some platforms render midnight as 24
  return { hour, minute: parseInt(val('minute'), 10), dow: dowMap[val('weekday')] };
}

// Process today's sessions matching `sessionFilter`: read updates, build, and
// SCHEDULE each (optimistic — ready to go; review/correct by message).
async function runProcess(env, sessionFilter) {
  const sessions = buildSessions(env);
  const todayDow = getTodayDayOfWeek();
  const todaySessions = sessions.filter(s => s.dayOfWeek === todayDow && sessionFilter(s));

  if (todaySessions.length === 0) {
    return { message: 'No matching sessions today', dayOfWeek: todayDow };
  }

  const dateStr = getTodayDateET();
  const results = [];
  for (const session of todaySessions) {
    // Idempotency: skip any session already handled today so a re-run can't
    // create duplicate broadcasts.
    const doneKey = `done:${session.key}:${dateStr}`;
    if (await env.KV.get(doneKey)) {
      results.push({ session: session.key, action: 'already_processed' });
      continue;
    }
    try {
      const result = await processSingleSession(session, env);
      await env.KV.put(doneKey, JSON.stringify(result), { expirationTtl: 86400 });
      results.push(result);
    } catch (err) {
      results.push({ session: session.key, error: err.message });
      await postToSlack(env, `:x: Failed to process *${session.label}*.\nError: ${err.message}`);
    }
  }
  return { dayOfWeek: todayDow, results };
}

// Nudge hosts who haven't posted an update yet, ahead of their send time.
async function runReminders(env, kind) {
  if (kind === 'ibgs') {
    const update = await findIBGSUpdate(env);
    if (update) return { phase: 'reminder-ibgs', action: 'already_posted' };
    const lance = getHost('lance', env);
    await postToSlack(env, `${lance.slackId ? `<@${lance.slackId}> ` : ''}:alarm_clock: Reminder: post your IBGS update for today — start the message with *"IBGS email:"*. It sends at 2:00 PM ET.`);
    return { phase: 'reminder-ibgs', action: 'reminded' };
  }

  // Training reminders (exclude IBGS, which has its own later reminder).
  const sessions = buildSessions(env);
  const todayDow = getTodayDayOfWeek();
  const todays = sessions.filter(s => s.dayOfWeek === todayDow && s.key !== 'thu-ibgs');
  const results = [];
  for (const session of todays) {
    const host = getHost(session.host, env);
    const msg = await findRelevantMessage(session, host, env);
    if (msg) { results.push({ session: session.key, action: 'already_posted' }); continue; }
    await postToSlack(env, `${host.slackId ? `<@${host.slackId}> ` : ''}:alarm_clock: Reminder: post any changes for today's *${session.label}* email, or the default will be sent. Goes out at ${formatTime(session.sendHour, session.sendMinute)} ET.`);
    results.push({ session: session.key, action: 'reminded' });
  }
  return { phase: 'reminder-training', results };
}

async function processSingleSession(session, env, dryRun = false) {
  const host = getHost(session.host, env);

  // IBGS is fully host-authored (Lance posts the whole body via an
  // "IBGS email:" message); it has its own generation path.
  if (session.key === 'thu-ibgs') return processIBGS(session, env, dryRun);

  // David's Mon/Tue are generated from his shorthand (state/county/student),
  // with a generic fallback when he hasn't posted.
  if (session.key === 'mon-training' || session.key === 'tue-training') {
    return processDavid(session, env, dryRun);
  }

  // 1. Read Slack for relevant messages
  const message = await findRelevantMessage(session, host, env);

  // 2. Determine intent
  const intent = parseIntent(message);
  console.log(`${session.key}: intent=${intent.type}, hasMessage=${!!message}`);

  // 3. Handle skip
  if (intent.type === 'skip') {
    await postToSlack(env,
      `:calendar: *${session.label}* — Skipping today's reminder.` +
      (intent.reason ? `\nReason: "${truncate(intent.reason, 100)}"` : '')
    );
    return { session: session.key, action: 'skipped' };
  }

  // 4. Get template from KV
  const template = await env.KV.get(session.templateKey);
  if (!template) {
    throw new Error(`No template in KV for "${session.templateKey}". Upload via PUT /template/${session.templateKey.replace('template:', '')}`);
  }

  // 5. Build content and decide on approval
  let finalContent = template;
  let subject = intent.subject || session.defaultSubject;

  // The schedule slot for this session; when a host posts changes we also derive
  // a proposed schedule line so the weekly schedule stays in sync.
  const scheduleSlot = buildScheduleSlots().find(s => s.sessionKey === session.key);
  let proposedScheduleTopic = null;

  if (intent.type === 'changes') {
    if (session.hostProvidesBody) {
      // Host sends complete copy (Lance) → format it faithfully into the intro.
      finalContent = replaceIntro(template, await generateFormattedBody(intent.text, host, env));
    } else {
      finalContent = await mergeWithAI(template, intent.text, session, host, env);
      if (!session.lockSubtitle) finalContent = await applyTopicSubtitle(finalContent, intent.text, host, env);
      if (scheduleSlot) proposedScheduleTopic = await scheduleTopicFromUpdate(intent.text, scheduleSlot, env);
    }
  }

  // Append the compliance footer (mailing address + unsubscribe) if one is
  // stored. Kit v4 has no "clone broadcast" endpoint, so fresh broadcasts don't
  // inherit a prior broadcast's footer — this appends it after any AI merge so
  // the required CAN-SPAM elements are always present and never AI-altered.
  // (Skip this if your Kit email template already includes the footer.)
  const footer = await env.KV.get('footer');
  if (footer) finalContent = `${finalContent}\n${footer}`;

  // Inject the shared weekly schedule wherever the template has the placeholder,
  // marking this session's row "← Today". Built fresh so it always reflects the
  // latest topics (manual or host-driven).
  if (finalContent.includes('<!--WEEKLY_SCHEDULE-->')) {
    // If a schedule line was proposed from the host's post, show it on this
    // email's own row immediately (it's persisted for the rest of the week only
    // once the change is approved).
    const extra = (proposedScheduleTopic && scheduleSlot) ? { [scheduleSlot.key]: proposedScheduleTopic } : null;
    finalContent = finalContent.replace('<!--WEEKLY_SCHEDULE-->', await renderScheduleBlock(env, session.key, extra));
  }

  // 6. Create broadcast in Kit
  const sendAt = getSendAtISO(session.sendHour, session.sendMinute);
  const kitFilterType = env[`KIT_${session.key.replace(/-/g, '_').toUpperCase()}_FILTER_TYPE`] || env.KIT_DEFAULT_FILTER_TYPE || 'tag';
  const kitFilterId = parseInt(env[`KIT_${session.key.replace(/-/g, '_').toUpperCase()}_FILTER_ID`] || env.KIT_DEFAULT_FILTER_ID || '0');
  const kitTemplateId = parseInt(env.KIT_EMAIL_TEMPLATE_ID || '0');

  const broadcastPayload = {
    subject,
    content: finalContent,
    filterType: kitFilterType,
    filterId: kitFilterId,
    emailTemplateId: kitTemplateId > 0 ? kitTemplateId : undefined,
  };

  // Dry run (the DEFAULT for manual /trigger): create a DRAFT only — never set
  // send_at, never schedule, never store a pending approval. This path cannot
  // send to anyone. A real send requires the cron, or /trigger?live=1.
  if (dryRun) {
    const broadcast = await createKitBroadcast(broadcastPayload, env); // no sendAt → draft
    const previewUrl = env.WORKER_URL
      ? `${env.WORKER_URL}/preview?broadcast=${broadcast.id}&token=${env.PREVIEW_TOKEN || ''}`
      : null;
    await postToSlack(env, [
      `:test_tube: *${session.label}* — DRY RUN draft created (will NOT send).`,
      `Subject: ${subject}`,
      previewUrl ? `:eyes: *Preview the email:* ${previewUrl}` : null,
    ].filter(Boolean).join('\n'));
    return { session: session.key, action: 'dry_run', broadcastId: broadcast.id };
  }

  // Optimistic: schedule it immediately (changes OR default), post a preview, and
  // let the team cancel or correct by posting another message. No "go ahead" gate.
  const changed = intent.type === 'changes';

  // Persist any host-derived schedule line so every email reflects it this week.
  if (proposedScheduleTopic && scheduleSlot) {
    const overrides = await getScheduleOverrides(env);
    overrides[scheduleSlot.key] = proposedScheduleTopic;
    await env.KV.put('schedule:overrides', JSON.stringify(overrides));
  }

  broadcastPayload.sendAt = sendAt;
  const broadcast = await createKitBroadcast(broadcastPayload, env);
  const previewUrl = env.WORKER_URL
    ? `${env.WORKER_URL}/preview?broadcast=${broadcast.id}&token=${env.PREVIEW_TOKEN || ''}`
    : null;

  await postToSlack(env, [
    changed
      ? `:white_check_mark: *${session.label}* — Scheduled with ${host.name}'s changes.`
      : `:white_check_mark: *${session.label}* — Scheduled (default — no changes).`,
    `Subject: ${subject}`,
    changed ? `Changes: "${truncate(intent.text, 150)}"` : null,
    proposedScheduleTopic ? `:calendar: Schedule line → "${proposedScheduleTopic}"` : null,
    `Sends at ${formatTime(session.sendHour, session.sendMinute)} ET.`,
    previewUrl ? `:eyes: *Preview:* ${previewUrl}` : null,
    `Reply *cancel* to stop it, or post a correction to change it.`,
  ].filter(Boolean).join('\n'));

  return { session: session.key, action: changed ? 'scheduled_with_changes' : 'scheduled_default', broadcastId: broadcast.id };
}


// --------------- PHASE 2: CHECK APPROVALS ---------------

async function runApprovalPhase(env) {
  const pendingList = await env.KV.list({ prefix: 'pending:' });

  if (pendingList.keys.length === 0) {
    return { phase: 'approval', message: 'Nothing pending' };
  }

  const results = [];
  for (const key of pendingList.keys) {
    try {
      const pending = JSON.parse(await env.KV.get(key.name));
      const result = await checkApproval(pending, key.name, env);
      results.push(result);
    } catch (err) {
      results.push({ key: key.name, error: err.message });
    }
  }
  return { phase: 'approval', results };
}

async function checkApproval(pending, kvKey, env) {
  // Read thread replies to the preview message
  const replies = await getSlackReplies(env, pending.messageTs);

  const approveMatch = /\b(go ahead|approve[d]?|send it|schedule it|looks good|lgtm)\b/i;
  const cancelMatch = /\b(cancel|don't send|do not send|skip|discard)\b/i;

  const approved = replies.some(r => approveMatch.test(r.text));
  const cancelled = replies.some(r => cancelMatch.test(r.text));

  if (approved) {
    // Persist the host-derived schedule line for the rest of the week so every
    // other email reflects it too (the approver saw it in the preview message).
    if (pending.scheduleSlot && pending.scheduleTopic) {
      const overrides = await getScheduleOverrides(env);
      overrides[pending.scheduleSlot] = pending.scheduleTopic;
      await env.KV.put('schedule:overrides', JSON.stringify(overrides));
    }

    // If approval landed after the planned send time, Kit can't schedule in the
    // past — bump to ~2 minutes out so a late "go ahead" still goes out.
    let sendAt = pending.sendAt;
    let bumped = false;
    if (Date.parse(pending.sendAt) <= Date.now() + 60_000) {
      sendAt = new Date(Date.now() + 120_000).toISOString();
      bumped = true;
    }
    await scheduleKitBroadcast(pending.broadcastId, sendAt, env);
    await env.KV.delete(kvKey);
    await postToSlack(env,
      `:rocket: *${pending.sessionLabel}* — Approved! Scheduled to send at ${sendAt}.` +
      (bumped ? `\n:warning: Approved after the planned time, so it sends in ~2 min.` : '')
    );
    return { session: pending.sessionKey, action: 'scheduled', bumped };
  }

  if (cancelled) {
    await deleteKitBroadcast(pending.broadcastId, env);
    await env.KV.delete(kvKey);
    await postToSlack(env, `:no_entry_sign: *${pending.sessionLabel}* — Cancelled. Broadcast deleted.`);
    return { session: pending.sessionKey, action: 'cancelled' };
  }

  // No response yet. Phase 2 runs on every pass, so only nudge the channel once
  // to avoid spamming the same reminder every 20 minutes.
  if (!pending.reminded) {
    await postToSlack(env, [
      `:hourglass_flowing_sand: *${pending.sessionLabel}* — Still waiting for approval.`,
      `Reply *go ahead* or *cancel* in the thread above.`,
      `If no one approves, this broadcast will NOT send.`,
    ].join('\n'));
    await env.KV.put(kvKey, JSON.stringify({ ...pending, reminded: true }), { expirationTtl: 86400 });
  }

  return { session: pending.sessionKey, action: 'waiting' };
}


// --------------- SLACK ---------------

async function findRelevantMessage(session, host, env) {
  const todayStart = getTodayStartTimestamp();
  const params = new URLSearchParams({
    channel: env.SLACK_CHANNEL_ID,
    oldest: todayStart.toString(),
    limit: '50',
  });

  const resp = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const data = await resp.json();
  if (!data.ok) {
    console.error('Slack history error:', data.error);
    return null;
  }

  // Exclude the bot's own posts (bot_id) and system messages (join/leave, etc.)
  // so the worker never mistakes its own confirmations for a host update.
  const messages = (data.messages || []).filter(m => !m.bot_id && !m.subtype && m.text);

  // Priority 1: Direct message from the host (their own Slack ID — unambiguous).
  const fromHost = messages.find(m => m.user === host.slackId);
  if (fromHost) return fromHost.text;

  // Priority 2: The coordinator posting on the host's behalf — must clearly name
  // the host (e.g. "Jeff Austin: ...", "David: ...").
  const ref = hostRefRegex(session.host);
  const adminId = env.ADMIN_SLACK_ID;
  if (adminId && ref) {
    const onBehalf = messages.find(m => m.user === adminId && ref.test(m.text || ''));
    if (onBehalf) return onBehalf.text;
  }

  // Priority 3: No message found
  return null;
}

async function getSlackReplies(env, parentTs) {
  const params = new URLSearchParams({
    channel: env.SLACK_CHANNEL_ID,
    ts: parentTs,
    limit: '20',
  });
  const resp = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const data = await resp.json();
  if (!data.ok) return [];
  // First message is the parent; the rest are replies
  return (data.messages || []).slice(1);
}

async function postToSlack(env, text) {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text }),
  });
  const data = await resp.json();
  if (!data.ok) console.error('Slack post error:', data.error);
  return data;
}


// --------------- SLACK EVENTS (real-time) ---------------

// Verify a request really came from Slack (HMAC-SHA256 over v0:ts:body).
async function verifySlackSignature(request, rawBody, env) {
  const ts = request.headers.get('X-Slack-Request-Timestamp');
  const sig = request.headers.get('X-Slack-Signature');
  const secret = env.SLACK_SIGNING_SECRET;
  if (!ts || !sig || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${rawBody}`));
  const hex = 'v0=' + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  // constant-time-ish compare
  if (hex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// Next occurrence (date + ISO send time) for a session — today if it's that day
// and before send time, otherwise the next matching weekday.
function getNextSendAtISO(session) {
  const { hour, minute, dow } = nowET();
  let daysAhead = (session.dayOfWeek - dow + 7) % 7;
  if (daysAhead === 0) {
    const past = hour > session.sendHour || (hour === session.sendHour && minute >= session.sendMinute);
    if (past) daysAhead = 7;
  }
  const [y, m, d] = getTodayDateET().split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1, d + daysAhead));
  const dateStr = `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`;
  const offset = getETOffsetHours();
  return { iso: `${dateStr}T${pad(session.sendHour)}:${pad(session.sendMinute)}:00-${pad(offset)}:00`, dateStr };
}

// Which session(s) a message is an update for, based on the IBGS marker, the
// poster's identity, or the coordinator naming a host.
function routeMessageToSessions(text, userId, env) {
  const t = text || '';
  if (/ibgs\s*email\s*:/i.test(t)) return ['thu-ibgs'];
  const isAdmin = userId && userId === env.ADMIN_SLACK_ID;
  if (userId === env.DAVID_SLACK_ID || (isAdmin && /\bdavid\b/i.test(t))) return ['mon-training', 'tue-training'];
  if (userId === env.JEFF_SLACK_ID  || (isAdmin && /\bjeff\s+(austin|a)\b/i.test(t))) return ['thu-training'];
  if (userId === env.LANCE_SLACK_ID || (isAdmin && /\blance\b/i.test(t))) return ['fri-training'];
  return [];
}

// Build {subject, content} for a session from a host's update (no scheduling).
async function buildSessionEmail(session, rawUpdate, env) {
  const host = getHost(session.host, env);
  const { subject: customSubject, body: updateText } = extractSubjectAndBody(rawUpdate);
  if (session.key === 'thu-ibgs') {
    const { content, gen } = await buildIBGS(parseIBGSUpdate(updateText), env);
    return { subject: customSubject || gen.subject, content };
  }
  if (session.key === 'mon-training' || session.key === 'tue-training') {
    const g = await generateDavidContent(updateText, session.key === 'mon-training' ? 'monday' : 'tuesday', env);
    if (g.state) {
      const ov = await getScheduleOverrides(env);
      ov.mon = `State Tax Sales: ${g.state} with David`;
      ov.tue = g.counties ? `County Deep Dive: ${g.counties} with David` : 'County Deep Dive with David';
      await env.KV.put('schedule:overrides', JSON.stringify(ov));
    }
    let content = (await env.KV.get(session.templateKey))
      .replace('<!--DAVID_SUBTITLE-->', g.subtitle).replace('<!--DAVID_INTRO-->', g.intro);
    content = content.replace('<!--WEEKLY_SCHEDULE-->', await renderScheduleBlock(env, session.key));
    return { subject: customSubject || g.subject, content };
  }
  // Jeff / Lance training.
  const template = await env.KV.get(session.templateKey);
  let content;
  if (session.hostProvidesBody) {
    // Lance sends complete copy → format it faithfully into the intro; subtitle
    // and schedule line stay as the template/default.
    content = replaceIntro(template, await generateFormattedBody(updateText, host, env));
  } else {
    // Jeff sends short notes → minimal merge + topic subtitle + schedule line.
    content = await mergeWithAI(template, updateText, session, host, env);
    if (!session.lockSubtitle) content = await applyTopicSubtitle(content, updateText, host, env);
    const slot = buildScheduleSlots().find(s => s.sessionKey === session.key);
    if (slot) {
      const ov = await getScheduleOverrides(env);
      ov[slot.key] = await scheduleTopicFromUpdate(updateText, slot, env);
      await env.KV.put('schedule:overrides', JSON.stringify(ov));
    }
  }
  const footer = await env.KV.get('footer');
  if (footer) content = `${content}\n${footer}`;
  if (content.includes('<!--WEEKLY_SCHEDULE-->')) {
    content = content.replace('<!--WEEKLY_SCHEDULE-->', await renderScheduleBlock(env, session.key));
  }
  return { subject: customSubject || session.defaultSubject, content };
}

// Real-time: build the email and (re)schedule it, always replacing the prior one
// for this session so the host's LATEST message wins. While paused, makes a draft.
async function realtimeProcess(session, updateText, env, paused) {
  const { subject, content } = await buildSessionEmail(session, updateText, env);
  const KEY = session.key.replace(/-/g, '_').toUpperCase();
  const payload = {
    subject, content,
    filterType: env[`KIT_${KEY}_FILTER_TYPE`] || env.KIT_DEFAULT_FILTER_TYPE || 'tag',
    filterId: parseInt(env[`KIT_${KEY}_FILTER_ID`] || env.KIT_DEFAULT_FILTER_ID || '0'),
    emailTemplateId: parseInt(env.KIT_EMAIL_TEMPLATE_ID || '0') > 0 ? parseInt(env.KIT_EMAIL_TEMPLATE_ID) : undefined,
  };
  const { iso: sendAt, dateStr } = getNextSendAtISO(session);

  // Latest-wins: delete whatever we previously created for this session.
  const ptr = `live:${session.key}`;
  const prev = await env.KV.get(ptr);
  if (prev) { try { await deleteKitBroadcast(prev, env); } catch (e) { /* already gone */ } }

  if (!paused) payload.sendAt = sendAt;
  const b = await createKitBroadcast(payload, env);
  await env.KV.put(ptr, String(b.id), { expirationTtl: 4 * 86400 });
  // Mark done so the cron won't also create one for that day.
  if (!paused) await env.KV.put(`done:${session.key}:${dateStr}`, 'realtime', { expirationTtl: 4 * 86400 });

  const previewUrl = env.WORKER_URL ? `${env.WORKER_URL}/preview?broadcast=${b.id}&token=${env.PREVIEW_TOKEN || ''}` : null;
  await postToSlack(env, [
    paused
      ? `:zap: *${session.label}* — updated in real time (draft only; system paused, not scheduled).`
      : `:zap: *${session.label}* — updated in real time. Scheduled for ${sendAt}.`,
    `Subject: ${subject}`,
    previewUrl ? `:eyes: *Preview:* ${previewUrl}` : null,
    `Post again to change it — I always use your latest message.`,
  ].filter(Boolean).join('\n'));
}

// Handle a Slack message event: route it, then process (latest-wins).
async function handleSlackEvent(body, env) {
  if (body.event_id) {
    const seen = `evt:${body.event_id}`;
    if (await env.KV.get(seen)) return;
    await env.KV.put(seen, '1', { expirationTtl: 3600 });
  }
  const ev = body.event || {};
  const msg = ev.subtype === 'message_changed' ? ev.message : ev;
  const text = msg && msg.text;
  const user = msg && msg.user;
  if (!text || (msg && msg.bot_id)) return;
  if (ev.subtype && ev.subtype !== 'message_changed') return; // joins, etc.

  const sessionKeys = routeMessageToSessions(text, user, env);
  if (!sessionKeys.length) return;                 // not a host update we handle
  // Ignore short chatter (the IBGS marker is always substantive).
  if (text.trim().length < 25 && !/ibgs\s*email\s*:/i.test(text)) return;

  const paused = !!(await env.KV.get('paused'));
  const all = buildSessions(env);
  const cancel = parseIntent(text).type === 'skip';
  for (const key of sessionKeys) {
    const session = all.find(s => s.key === key);
    if (!session) continue;
    try {
      if (cancel) {
        const ptr = `live:${session.key}`;
        const prev = await env.KV.get(ptr);
        if (prev) { try { await deleteKitBroadcast(prev, env); } catch (e) {} await env.KV.delete(ptr); }
        await postToSlack(env, `:no_entry_sign: *${session.label}* — cancelled (no email will go out).`);
      } else {
        await realtimeProcess(session, text, env, paused);
      }
    } catch (e) {
      await postToSlack(env, `:x: Real-time update for *${session.label}* failed: ${e.message}`);
    }
  }
}


// --------------- INTENT PARSING ---------------

function parseIntent(message) {
  if (!message) return { type: 'no-change' };

  const text = message.trim();
  const lower = text.toLowerCase();

  // Skip patterns
  if (/\b(skip|no session|cancel.*(session|today)|holiday|off today|no (training|ibgs|class) today)\b/i.test(lower)) {
    return { type: 'skip', reason: text };
  }

  // No-change patterns
  if (/\b(no change|no update|same as|send as.?is|no changes?\s*(needed|required)?|good (to go|as.?is)|unchanged)\b/i.test(lower)) {
    return { type: 'no-change' };
  }

  // Has changes — pull out any host-supplied subject and clean the body.
  const { subject, body } = extractSubjectAndBody(text);
  return { type: 'changes', text: body, subject };
}

// Pull a host-supplied subject ("Subject:" or "Subject line:") out of a message,
// and strip the "Make changes to my ... email" framing from the body.
function extractSubjectAndBody(text) {
  let body = String(text || '').trim();
  let subject = null;
  const m = body.match(/^\s*subject(?:\s*line)?\s*:\s*(.+?)\s*$/im);
  if (m) { subject = m[1].trim(); body = body.replace(m[0], '').trim(); }
  body = body.replace(/^\s*make changes to my[^\n]*\n?/i, '').trim();
  return { subject, body };
}


// --------------- AI (CLOUDFLARE WORKERS AI) ---------------

async function mergeWithAI(template, updateText, session, host, env) {
  const prompt = `You are updating an HTML email reminder for a training session.

SESSION: ${session.label}
TIME: ${session.sessionTime}
HOST: ${host.name}

THE HOST WANTS THESE CHANGES:
${updateText}

HERE IS THE CURRENT HTML EMAIL:
${template}

RULES:
- Change ONLY the body paragraph(s) that describe what the session covers (its topic/agenda), plus any prep instructions the host gave. Phrase cleanly; don't copy the host's casual wording verbatim.
- Keep EVERYTHING ELSE byte-for-byte: the <h1> title, the header subtitle, the greeting, the "Quick reminder – ... is today at ..." line, the weekly schedule, the button, all HTML tags, CSS, styles, links, and the footer.
- NEVER change the host's name.
- NEVER alter, move, or remove the footer, the mailing address, or the unsubscribe link/merge fields. They are legally required and must pass through byte-for-byte.
- Do not add new HTML sections or restructure the layout. Do not invent content the host didn't mention.
- Leave all merge fields (e.g. {{ subscriber.first_name }}, {{ address }}) exactly as written.
- Return ONLY the complete updated HTML. No commentary. No markdown fences. No explanation before or after.`;

  // Cloudflare Workers AI runs on this same account — no external API key, no
  // separate quota/billing, free-tier allocation. Llama 3.3 70B follows the
  // "preserve all HTML, change only the copy" instruction well. Override the
  // model with the AI_MODEL var if needed.
  const model = env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const result = await env.AI.run(model, {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 8192,
  });

  const content = (result.response || '').trim();
  if (!content) throw new Error('Workers AI returned empty response');

  // Strip markdown fences if present
  return content.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
}


// Format a host's COMPLETE email copy into faithful HTML for the .intro section,
// preserving their wording, paragraphs, and any bullet list (rendered as <ul>).
async function generateFormattedBody(updateText, host, env) {
  const prompt = `Format the host's email copy into clean HTML for the body of a reminder email. Be FAITHFUL — keep the host's wording, paragraph breaks, and any list.

RULES:
- Start with exactly: <p>Hi {{ subscriber.first_name }},</p> (replace any greeting line the host wrote, e.g. "Hi <first name>,").
- Wrap each paragraph in <p>...</p>.
- If the host wrote a list (e.g. "You'll learn how to:" followed by items), keep the lead-in line as a <p> and render the items as <ul><li>...</li></ul>. Do NOT collapse a list into a sentence.
- Do not summarize, add, or drop the host's points. Keep their order.
- Output ONLY the inner HTML (<p> and <ul> elements). No commentary, no markdown fences.

Host's copy:
${updateText}`;
  const model = env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const r = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], max_tokens: 1400 });
  return (r.response || '').trim().replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
}

// Replace the inner content of the template's <div class="intro"> with new HTML.
function replaceIntro(html, innerHtml) {
  return html.replace(/(<div class="intro">)[\s\S]*?(<\/div>)/, (m, a, b) => `${a}\n${innerHtml}\n    ${b}`);
}

// Rewrite the header subtitle (the <p> under the <h1>) to today's topic, keeping
// the "with <host>" style. Done as a separate targeted step because the full-HTML
// merge is unreliable at editing the subtitle.
async function applyTopicSubtitle(html, updateText, host, env) {
  const SUB = /(<h1[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>)([\s\S]*?)(<\/p>)/;
  const m = html.match(SUB);
  if (!m) return html;
  const current = m[2].replace(/<[^>]+>/g, '').trim();
  const prompt = `Rewrite this training-email header subtitle to name today's topic, keeping a "with ${host.name}" style ending. Output ONLY the new subtitle — no quotes, no trailing period, max ~10 words.
Current subtitle: "${current}"
Host's note: "${updateText}"`;
  let next = current;
  try {
    const r = await env.AI.run(env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      { messages: [{ role: 'user', content: prompt }], max_tokens: 40 });
    const line = (r.response || '').trim().split('\n')[0].replace(/^["']|["']$/g, '').replace(/\.\s*$/, '').trim();
    if (line) next = line;
  } catch (e) { /* keep current subtitle on failure */ }
  return html.replace(SUB, (full, a, b, c) => a + next + c);
}


// --------------- DAVID (Mon/Tue state & county, from his shorthand) ---------------

// From David's terse note, generate this week's email pieces for the given day.
// Tuesday stays general when no counties are named; references the requesting
// student if David mentioned one.
async function generateDavidContent(update, dayKind, env) {
  const isTue = dayKind === 'tuesday';
  const prompt = `David runs a daily tax-defaulted-property investing training. From his short note, extract the details and write the copy for this week's ${isTue ? 'Tuesday COUNTY deep-dive' : 'Monday STATE overview'} reminder email.

David's note: "${update}"

Guidance:
- ${isTue
    ? 'This is a county-level deep dive within the state. If David named specific counties, feature them by name. If he did NOT name counties, keep it general (e.g. "selected counties in <state>") and do NOT invent county names.'
    : "This is a state-level overview of that state's tax sale rules and what to know before bidding."}
- If David named a student who requested the topic, reference them warmly once, e.g. "This one goes out to fellow student <Name>, who requested the <state> deep dive."
- Warm, practical, concise — no hype. Greeting must be the literal token <p>Hi {{ subscriber.first_name }},</p>.
- The SUBTITLE should read like "${isTue ? '<State> Counties Deep Dive with David' : '<State> Tax Sales with David'}".

Respond EXACTLY in this format and nothing else:
STATE: <state name, or NONE>
COUNTIES: <comma-separated county names, or NONE>
STUDENT: <student name, or NONE>
SUBJECT: <subject line>
SUBTITLE: <short header subtitle>
INTRO:
<2 to 4 short HTML <p> paragraphs, starting with <p>Hi {{ subscriber.first_name }},</p>>`;

  const model = env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const r = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], max_tokens: 900 });
  const out = (r.response || '').trim();
  const grab = (label) => {
    const m = out.match(new RegExp(label + ':\\s*(.+)', 'i'));
    const v = m && m[1] ? m[1].trim() : '';
    return (!v || /^none$/i.test(v)) ? null : v;
  };
  const intro = (out.split(/INTRO:\s*/i)[1] || '').trim()
    .replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
  return {
    state: grab('STATE'),
    counties: grab('COUNTIES'),
    student: grab('STUDENT'),
    subject: grab('SUBJECT') || (isTue ? 'County Deep Dive Today at 2 PM ET' : 'State Tax Sales Today at 2 PM ET'),
    subtitle: grab('SUBTITLE') || (isTue ? 'County Deep Dive with David' : 'State Tax Sales with David'),
    intro,
  };
}

// State-less fallback when David hasn't posted anything by processing time.
function genericDavidContent(dayKind) {
  if (dayKind === 'tuesday') {
    return {
      subject: 'Today at 2PM - County Deep Dive Training with David',
      subtitle: 'County Deep Dive with David',
      intro: `      <p>Hi {{ subscriber.first_name }},</p>\n      <p>Join David today at <strong>2:00 PM Eastern</strong> for a live county deep dive — how to research and evaluate tax-defaulted properties at the county level.</p>\n      <p>Bring your questions and follow along live.</p>`,
    };
  }
  return {
    subject: 'Today at 2PM - State Tax Sales Training with David',
    subtitle: 'State Tax Sales with David',
    intro: `      <p>Hi {{ subscriber.first_name }},</p>\n      <p>Join David today at <strong>2:00 PM Eastern</strong> for a live breakdown of state tax sale rules and what you need to know before bidding.</p>\n      <p>Bring your questions and follow along live.</p>`,
  };
}

// Collect David's recent posts (state note + any later county note) as context.
async function findDavidUpdate(env) {
  const oldest = Math.floor(Date.now() / 1000) - 4 * 86400;
  const params = new URLSearchParams({ channel: env.SLACK_CHANNEL_ID, oldest: String(oldest), limit: '100' });
  const resp = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const data = await resp.json();
  if (!data.ok) return null;
  const david = getHost('david', env);
  const adminId = env.ADMIN_SLACK_ID;
  const msgs = (data.messages || []).filter(m => {
    if (m.bot_id || m.subtype || !(m.text || '').trim()) return false;
    if (m.user === david.slackId) return true;                                  // David posts directly
    if (adminId && m.user === adminId && /\bdavid\b/i.test(m.text)) return true; // coordinator on his behalf
    return false;
  });
  if (!msgs.length) return null;
  return msgs.slice(0, 4).reverse().map(m => m.text).join('\n---\n'); // oldest-first context
}

async function processDavid(session, env, dryRun = false) {
  const dayKind = session.key === 'mon-training' ? 'monday' : 'tuesday';
  const note = await findDavidUpdate(env);
  const usedDefault = !note;
  const g = note ? await generateDavidContent(note, dayKind, env) : genericDavidContent(dayKind);

  const template = await env.KV.get(session.templateKey);
  if (!template) throw new Error(`No ${session.templateKey} in KV.`);

  // Set the shared schedule lines from David's state/counties (covers both days).
  if (!usedDefault && g.state) {
    const overrides = await getScheduleOverrides(env);
    overrides.mon = `State Tax Sales: ${g.state} with David`;
    overrides.tue = g.counties ? `County Deep Dive: ${g.counties} with David` : 'County Deep Dive with David';
    await env.KV.put('schedule:overrides', JSON.stringify(overrides));
  }

  let content = template
    .replace('<!--DAVID_SUBTITLE-->', g.subtitle)
    .replace('<!--DAVID_INTRO-->', g.intro);
  if (content.includes('<!--WEEKLY_SCHEDULE-->')) {
    content = content.replace('<!--WEEKLY_SCHEDULE-->', await renderScheduleBlock(env, session.key));
  }

  const KEY = session.key.replace(/-/g, '_').toUpperCase();
  const broadcastPayload = {
    subject: g.subject, content,
    filterType: env[`KIT_${KEY}_FILTER_TYPE`] || env.KIT_DEFAULT_FILTER_TYPE || 'tag',
    filterId: parseInt(env[`KIT_${KEY}_FILTER_ID`] || env.KIT_DEFAULT_FILTER_ID || '0'),
    emailTemplateId: parseInt(env.KIT_EMAIL_TEMPLATE_ID || '0') > 0 ? parseInt(env.KIT_EMAIL_TEMPLATE_ID) : undefined,
  };
  const sendAt = getSendAtISO(session.sendHour, session.sendMinute);
  const previewLink = id => env.WORKER_URL ? `${env.WORKER_URL}/preview?broadcast=${id}&token=${env.PREVIEW_TOKEN || ''}` : null;
  const summary = usedDefault
    ? '(No update from David — generic version.)'
    : `${g.state || '?'}${g.counties ? ' — ' + g.counties : ''}${g.student ? ' — for ' + g.student : ''}`;

  if (dryRun) {
    const b = await createKitBroadcast(broadcastPayload, env);
    await postToSlack(env, [
      `:test_tube: *${session.label}* — DRY RUN draft (will NOT send).`,
      `Subject: ${g.subject}`, summary,
      previewLink(b.id) ? `:eyes: *Preview:* ${previewLink(b.id)}` : null,
    ].filter(Boolean).join('\n'));
    return { session: session.key, action: 'dry_run', broadcastId: b.id };
  }

  broadcastPayload.sendAt = sendAt;
  const broadcast = await createKitBroadcast(broadcastPayload, env);
  await postToSlack(env, [
    usedDefault
      ? `:white_check_mark: *${session.label}* — Scheduled (generic — no update from David).`
      : `:white_check_mark: *${session.label}* — Scheduled. ${summary}`,
    `Subject: ${g.subject}`,
    `Sends at ${formatTime(session.sendHour, session.sendMinute)} ET.`,
    previewLink(broadcast.id) ? `:eyes: *Preview:* ${previewLink(broadcast.id)}` : null,
    `Reply *cancel* to stop it, or post a correction to change it.`,
  ].filter(Boolean).join('\n'));
  return { session: session.key, action: usedDefault ? 'scheduled_generic' : 'scheduled_with_update', broadcastId: broadcast.id };
}


// --------------- IBGS (host-authored, AI-formatted) ---------------

// Find the most recent "IBGS email:" message in the channel (scans ~6 days, so
// Lance can post it any day before the Thursday session).
async function findIBGSUpdate(env) {
  const oldest = Math.floor(Date.now() / 1000) - 6 * 86400;
  const params = new URLSearchParams({ channel: env.SLACK_CHANNEL_ID, oldest: String(oldest), limit: '100' });
  const resp = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const data = await resp.json();
  if (!data.ok) { console.error('IBGS history error:', data.error); return null; }
  const msgs = (data.messages || []).filter(m => !m.bot_id && !m.subtype && /ibgs\s*email\s*:/i.test(m.text || ''));
  return msgs.length ? msgs[0].text : null; // history is newest-first
}

// Split an "IBGS email:" message into { body, execUrl, excludeExec }.
function parseIBGSUpdate(text) {
  let t = String(text || '').replace(/^[\s\S]*?ibgs\s*email\s*:\s*/i, '');
  const lines = t.split('\n');
  let execUrl = null, excludeExec = false, idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/executive summary/i.test(lines[i])) { idx = i; break; }
  }
  if (idx >= 0) {
    const line = lines[idx];
    if (/no\s+executive summary/i.test(line)) excludeExec = true;
    else { const m = line.match(/https?:\/\/\S+/); if (m) execUrl = m[0]; }
    lines.splice(idx, 1);
  }
  return { body: lines.join('\n').trim(), execUrl, excludeExec };
}

// Generate { headerLine, subject, bodyHtml } from Lance's body + exec decision.
async function generateIBGS({ body, execUrl, excludeExec }, env) {
  const includeExec = !!execUrl && !excludeExec;
  const execRule = includeExec
    ? `Immediately AFTER the join-webinar paragraph, add EXACTLY this paragraph:\n<p><a href="${execUrl}" target="_blank" rel="noopener">Download the executive summary</a></p>`
    : `Do NOT include any executive-summary link anywhere.`;

  const prompt = `You format a Ted Thomas "IBGS" class-reminder email from the host's body text. Do not invent or rewrite the host's content — only format it.

HOST BODY:
${body}

Produce BODY_HTML following these rules in order:
- Start with exactly: <p>Hi {{ subscriber.first_name }},</p>
- Then the host's opening reminder paragraph (the one about being live today at 3:00 PM).
- Then EXACTLY: <p><a href="{{ subscriber.ibgs_link }}" target="_blank" rel="noopener">Join the live webinar here</a></p>
- ${execRule}
- Then the REST of the host's paragraphs in order, each wrapped in <p>...</p>, using the host's exact wording.
- Replace any opening greeting like "Hi Everyone" with the personalized greeting above (do not duplicate it). Keep any closing like "Ted Thomas Team".
- Output only <p> elements — no markdown, no commentary.

Also produce:
- HEADER_LINE: a short line naming today's lesson/cycle (e.g. "Lesson 3 - Interactive Session" or "Brand New 13-Week Cycle - Lesson 1"), inferred from the body. Max ~8 words.
- SUBJECT: a compelling subject line for this IBGS reminder, based on the body. Max ~12 words.

Respond EXACTLY in this format and nothing else:
HEADER_LINE: <line>
SUBJECT: <line>
BODY_HTML:
<html>`;

  const model = env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const result = await env.AI.run(model, { messages: [{ role: 'user', content: prompt }], max_tokens: 2048 });
  const out = (result.response || '').trim();

  const headerLine = (out.match(/HEADER_LINE:\s*(.+)/i) || [])[1]?.trim() || 'Interactive Session';
  const subject = (out.match(/SUBJECT:\s*(.+)/i) || [])[1]?.trim() || 'IBGS Class Starts in 1 Hour - 3:00 PM Eastern';
  let bodyHtml = (out.split(/BODY_HTML:\s*/i)[1] || '').trim()
    .replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
  if (!bodyHtml) throw new Error('IBGS body generation returned empty');
  return { headerLine, subject, bodyHtml };
}

// Build the IBGS broadcast content from a parsed update; returns { content, gen, parsed }.
async function buildIBGS(parsed, env) {
  const gen = await generateIBGS(parsed, env);
  const template = await env.KV.get('template:ibgs');
  if (!template) throw new Error('No template:ibgs in KV. Upload it first.');
  const content = template
    .replace('<!--IBGS_HEADER_LINE-->', gen.headerLine)
    .replace('<!--IBGS_BODY-->', gen.bodyHtml);
  return { content, gen };
}

function ibgsExecStatus(parsed) {
  if (parsed.excludeExec) return 'excluded (Lance said no)';
  return parsed.execUrl ? `included — ${parsed.execUrl}` : 'none provided';
}

async function processIBGS(session, env, dryRun = false) {
  const updateText = await findIBGSUpdate(env);
  if (!updateText) {
    await postToSlack(env, `:warning: *${session.label}* — No IBGS update found. Lance needs to post a message starting with "IBGS email:". Nothing was created.`);
    return { session: session.key, action: 'no_update' };
  }
  const parsed = parseIBGSUpdate(updateText);
  if (!parsed.body) {
    await postToSlack(env, `:warning: *${session.label}* — Found "IBGS email:" but no body content. Nothing was created.`);
    return { session: session.key, action: 'no_body' };
  }

  const { content, gen } = await buildIBGS(parsed, env);

  const kitFilterType = env.KIT_THU_IBGS_FILTER_TYPE || env.KIT_DEFAULT_FILTER_TYPE || 'tag';
  const kitFilterId = parseInt(env.KIT_THU_IBGS_FILTER_ID || env.KIT_DEFAULT_FILTER_ID || '0');
  const kitTemplateId = parseInt(env.KIT_EMAIL_TEMPLATE_ID || '0');
  const broadcastPayload = {
    subject: gen.subject, content,
    filterType: kitFilterType, filterId: kitFilterId,
    emailTemplateId: kitTemplateId > 0 ? kitTemplateId : undefined,
  };
  const sendAt = getSendAtISO(session.sendHour, session.sendMinute);
  const previewLink = (id) => env.WORKER_URL ? `${env.WORKER_URL}/preview?broadcast=${id}&token=${env.PREVIEW_TOKEN || ''}` : null;

  if (dryRun) {
    const b = await createKitBroadcast(broadcastPayload, env);
    await postToSlack(env, [
      `:test_tube: *${session.label}* — DRY RUN draft (will NOT send).`,
      `Subject: ${gen.subject}`,
      `Header: ${gen.headerLine}`,
      `Exec summary: ${ibgsExecStatus(parsed)}`,
      previewLink(b.id) ? `:eyes: *Preview:* ${previewLink(b.id)}` : null,
    ].filter(Boolean).join('\n'));
    return { session: session.key, action: 'dry_run', broadcastId: b.id };
  }

  // Optimistic: schedule it; the team reviews and corrects by message.
  broadcastPayload.sendAt = sendAt;
  const broadcast = await createKitBroadcast(broadcastPayload, env);
  await postToSlack(env, [
    `:white_check_mark: *${session.label}* — Scheduled (auto-written from Lance's update).`,
    `Subject: ${gen.subject}`,
    `Header: ${gen.headerLine}`,
    `Exec summary: ${ibgsExecStatus(parsed)}`,
    `Sends at ${formatTime(session.sendHour, session.sendMinute)} ET.`,
    previewLink(broadcast.id) ? `:eyes: *Preview:* ${previewLink(broadcast.id)}` : null,
    `Reply *cancel* to stop it, or post a correction to change it.`,
  ].filter(Boolean).join('\n'));
  return { session: session.key, action: 'scheduled', broadcastId: broadcast.id };
}


// --------------- KIT API ---------------

async function createKitBroadcast({ subject, content, sendAt, filterType, filterId, emailTemplateId }, env) {
  const body = { subject, content, public: false };

  if (sendAt) body.send_at = sendAt;
  if (emailTemplateId) body.email_template_id = emailTemplateId;
  if (filterId && filterId > 0) {
    body.subscriber_filter = [{ all: [{ type: filterType || 'tag', ids: [filterId] }] }];
  }

  const resp = await fetch('https://api.kit.com/v4/broadcasts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kit-Api-Key': env.KIT_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Kit create broadcast ${resp.status}: ${errBody}`);
  }

  const data = await resp.json();
  return data.broadcast || data;
}

// Kit's PUT /broadcasts/{id} requires the FULL broadcast body — a partial
// { send_at } update is rejected / blanks other fields. So we GET the current
// broadcast, then PUT it back with send_at applied.
async function scheduleKitBroadcast(broadcastId, sendAt, env) {
  const getResp = await fetch(`https://api.kit.com/v4/broadcasts/${broadcastId}`, {
    headers: { 'X-Kit-Api-Key': env.KIT_API_KEY },
  });
  if (!getResp.ok) {
    const errBody = await getResp.text();
    throw new Error(`Kit get broadcast ${getResp.status}: ${errBody}`);
  }
  const b = (await getResp.json()).broadcast;

  const updateBody = {
    email_template_id: b.email_template?.id ?? null,
    email_address: b.email_address ?? null,
    content: b.content,
    description: b.description ?? null,
    public: b.public ?? false,
    published_at: b.published_at ?? null,
    send_at: sendAt,
    thumbnail_alt: b.thumbnail_alt ?? null,
    thumbnail_url: b.thumbnail_url ?? null,
    preview_text: b.preview_text ?? null,
    subject: b.subject,
    subscriber_filter: b.subscriber_filter,
  };

  const resp = await fetch(`https://api.kit.com/v4/broadcasts/${broadcastId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Kit-Api-Key': env.KIT_API_KEY,
    },
    body: JSON.stringify(updateBody),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Kit schedule broadcast ${resp.status}: ${errBody}`);
  }

  return await resp.json();
}

async function deleteKitBroadcast(broadcastId, env) {
  const resp = await fetch(`https://api.kit.com/v4/broadcasts/${broadcastId}`, {
    method: 'DELETE',
    headers: { 'X-Kit-Api-Key': env.KIT_API_KEY },
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Kit delete broadcast ${resp.status}: ${errBody}`);
  }
}


// --------------- TIMEZONE / DATE HELPERS ---------------

function getTodayDayOfWeek() {
  const dayStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
  }).format(new Date());
  const map = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  return map[dayStr];
}

function getDayName(dow) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
}

function getTodayDateET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function getETOffsetHours() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  return Math.round((new Date(utcStr) - new Date(etStr)) / 3600000);
}

function getSendAtISO(hour, minute) {
  const date = getTodayDateET();
  const offset = getETOffsetHours();
  return `${date}T${pad(hour)}:${pad(minute)}:00-${pad(offset)}:00`;
}

function getTodayStartTimestamp() {
  const date = getTodayDateET();
  const offset = getETOffsetHours();
  const midnight = new Date(`${date}T00:00:00Z`);
  midnight.setHours(midnight.getHours() + offset);
  return Math.floor(midnight.getTime() / 1000);
}

function formatTime(hour, minute) {
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h = hour > 12 ? hour - 12 : hour;
  return `${h}:${pad(minute)} ${ampm}`;
}

function pad(n) { return String(n).padStart(2, '0'); }
function truncate(s, len) { return s.length > len ? s.slice(0, len) + '...' : s; }

// Returns a 401 Response if the request is missing/wrong admin token, else null.
// Token may be passed as `X-Admin-Token: <token>` or `Authorization: Bearer <token>`.
function requireAuth(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    return json({ error: 'Server missing ADMIN_TOKEN secret; refusing all requests.' }, 503);
  }
  const header = request.headers.get('X-Admin-Token')
    || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (header !== expected) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
