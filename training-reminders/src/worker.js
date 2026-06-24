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
      defaultSubject: 'Reminder: Training Session Today at 2 PM ET',
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
      defaultSubject: 'Reminder: Training Session Today at 2 PM ET',
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


// --------------- ENTRY POINTS ---------------

export default {
  async scheduled(event, env, ctx) {
    // The morning cron runs the draft phase; every other cron is an approval
    // sweep. Running approval on a recurring schedule (not just once) closes the
    // late-approval gap and avoids brittle exact-string cron matching.
    const phase1Cron = env.PHASE1_CRON || '0 15 * * 1,2,4,5';

    const results = (event.cron === phase1Cron)
      ? await runDraftPhase(env)
      : await runApprovalPhase(env);

    console.log('Cron complete:', JSON.stringify(results));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check is the only unauthenticated route.
    if (url.pathname === '/' && request.method === 'GET') {
      return json({ status: 'ok', service: 'training-reminders', version: '2.1' });
    }

    // Everything else requires the admin token.
    const authError = requireAuth(request, env);
    if (authError) return authError;

    // Manual triggers
    if (url.pathname === '/phase1' && request.method === 'POST') {
      return json(await runDraftPhase(env));
    }
    if (url.pathname === '/phase2' && request.method === 'POST') {
      return json(await runApprovalPhase(env));
    }
    if (url.pathname === '/trigger' && request.method === 'POST') {
      const key = url.searchParams.get('session');
      const sessions = buildSessions(env);
      const session = sessions.find(s => s.key === key);
      if (!session) return json({ error: 'Unknown session', valid: sessions.map(s => s.key) }, 400);
      const result = await processSingleSession(session, env);
      // Mark done so the scheduled cron won't re-process and double-send.
      await env.KV.put(`done:${session.key}:${getTodayDateET()}`, JSON.stringify(result), { expirationTtl: 86400 });
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

async function runDraftPhase(env) {
  const sessions = buildSessions(env);
  const todayDow = getTodayDayOfWeek();
  const todaySessions = sessions.filter(s => s.dayOfWeek === todayDow);

  if (todaySessions.length === 0) {
    return { message: 'No sessions today', dayOfWeek: todayDow };
  }

  const dateStr = getTodayDateET();
  const results = [];
  for (const session of todaySessions) {
    // Idempotency: skip any session already handled today so a re-run of the
    // cron (or an overlapping manual /phase1) can't create duplicate broadcasts.
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
      await postToSlack(env, `:x: Failed to create draft for *${session.label}*.\nError: ${err.message}`);
    }
  }
  return { phase: 'draft', dayOfWeek: todayDow, results };
}

async function processSingleSession(session, env) {
  const host = getHost(session.host, env);

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
  let needsApproval = false;

  if (intent.type === 'changes') {
    finalContent = await mergeWithAI(template, intent.text, session, host, env);
    needsApproval = true;
  }

  // Append the compliance footer (mailing address + unsubscribe) if one is
  // stored. Kit v4 has no "clone broadcast" endpoint, so fresh broadcasts don't
  // inherit a prior broadcast's footer — this appends it after any AI merge so
  // the required CAN-SPAM elements are always present and never AI-altered.
  // (Skip this if your Kit email template already includes the footer.)
  const footer = await env.KV.get('footer');
  if (footer) finalContent = `${finalContent}\n${footer}`;

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

  if (needsApproval) {
    // Draft only — no send_at
    const broadcast = await createKitBroadcast(broadcastPayload, env);

    const previewMsg = await postToSlack(env, [
      `:memo: *${session.label}* — Draft ready with changes.`,
      `Subject: ${subject}`,
      `Changes from ${host.name}: "${truncate(intent.text, 150)}"`,
      ``,
      `Reply *go ahead* to schedule for ${formatTime(session.sendHour, session.sendMinute)} ET.`,
      `Reply *cancel* to discard.`,
    ].join('\n'));

    // Store pending approval
    const pendingKey = `pending:${session.key}:${getTodayDateET()}`;
    await env.KV.put(pendingKey, JSON.stringify({
      broadcastId: broadcast.id,
      messageTs: previewMsg.ts,
      sessionKey: session.key,
      sessionLabel: session.label,
      sendAt,
    }), { expirationTtl: 86400 }); // auto-expire after 24h

    return { session: session.key, action: 'pending_approval', broadcastId: broadcast.id };

  } else {
    // Auto-schedule — no changes means no taste required
    broadcastPayload.sendAt = sendAt;
    const broadcast = await createKitBroadcast(broadcastPayload, env);

    await postToSlack(env, [
      `:white_check_mark: *${session.label}* — Auto-scheduled (no changes to template).`,
      `Subject: ${subject}`,
      `Sends at: ${formatTime(session.sendHour, session.sendMinute)} ET`,
      message ? `Note from channel: "${truncate(message, 100)}"` : `No message from ${host.name}. Using default.`,
    ].filter(Boolean).join('\n'));

    return { session: session.key, action: 'auto_scheduled', broadcastId: broadcast.id };
  }
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

  // Priority 1: Direct message from the host
  const fromHost = messages.find(m => m.user === host.slackId);
  if (fromHost) return fromHost.text;

  // Priority 2: Message from anyone mentioning the host by name or session type
  const searchTerms = [
    host.name.toLowerCase(),
    session.host.toLowerCase(),
    session.key.includes('ibgs') ? 'ibgs' : getDayName(session.dayOfWeek).toLowerCase(),
  ];

  const proxy = messages.find(m => {
    const lower = (m.text || '').toLowerCase();
    return searchTerms.some(term => lower.includes(term));
  });
  if (proxy) return proxy.text;

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

  // Has changes — check for subject override
  let subject = null;
  let body = text;
  const subjectMatch = text.match(/^SUBJECT:\s*(.+?)(?:\n|$)/im);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    body = text.replace(subjectMatch[0], '').trim();
  }

  return { type: 'changes', text: body, subject };
}


// --------------- AI (GEMINI) ---------------

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
- Apply the host's changes to the email body content.
- Keep ALL HTML tags, CSS, inline styles, images, links, headers, and footers exactly as they are.
- NEVER alter, move, or remove the footer, the mailing address, or the unsubscribe link/merge fields. They are legally required and must pass through byte-for-byte.
- Only modify the text that describes what today's session covers or any specific instructions the host mentioned.
- If the host mentions a topic, agenda item, or preparation instructions, work them into the relevant section.
- Do not add new HTML sections or restructure the layout.
- Do not invent content the host didn't mention.
- Return ONLY the complete updated HTML. No commentary. No markdown fences. No explanation before or after.`;

  const model = env.GEMINI_MODEL || 'gemini-2.0-flash';
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      }),
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const candidate = data.candidates?.[0];
  // Guard against truncated / blocked output so we never build an email from
  // incomplete HTML. (STOP is normal completion.)
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Gemini stopped early: ${candidate.finishReason}`);
  }
  const content = (candidate?.content?.parts || []).map(p => p.text || '').join('');
  if (!content) throw new Error('Gemini returned empty response');

  // Strip markdown fences if present
  return content.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
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
