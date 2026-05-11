/**
 * duckling-relay Worker entry.
 *
 * Routes:
 *   GET  /healthz              health probe (returns bot username)
 *   POST /pair/new             mint a pairing token (called by `duckling setup`)
 *   GET  /pair/status          poll a pairing token (called by `duckling setup`)
 *   POST /pair/bind            admin escape hatch — bypass Telegram (gated)
 *   POST /tg-webhook           Telegram delivers updates here (set via setWebhook)
 *   GET  /ws?token=<deviceToken>  daemon WebSocket connection (HTTP Upgrade)
 *
 * The Worker is the entry/routing layer; all state lives in Durable Objects:
 *   - DirectoryDO  (singleton)  — pair tokens + deviceToken → user lookups
 *   - UserDO       (per user)   — chatId, devices, sessions, pending approvals,
 *                                 hibernated WebSocket connections
 */

import { esc } from '../shared/render';
import { TgApi } from './tg-api';
import type { Env } from './types';

export { DirectoryDO } from './directory-do';
export { UserDO } from './user-do';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      console.error('worker error', e);
      return json(500, { error: e instanceof Error ? e.message : 'internal' });
    }
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // CORS preflight — `duckling setup` calls /pair/* from a Node fetch, no
  // browser involved, but we leave permissive CORS in place for future
  // tooling (e.g. a web dashboard).
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      },
    });
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return handleHealthz(env);
  }
  if (request.method === 'POST' && url.pathname === '/pair/new') {
    return handlePairNew(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/pair/status') {
    return forwardToDirectory(
      env,
      request,
      `/pair/status?token=${encodeURIComponent(url.searchParams.get('token') ?? '')}`,
    );
  }
  if (request.method === 'POST' && url.pathname === '/pair/bind') {
    return handlePairBind(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/tg-webhook') {
    return handleTgWebhook(request, env);
  }
  if (url.pathname === '/ws') {
    return handleWsUpgrade(request, env);
  }

  return json(404, { error: 'not found' });
}

// ---------- /healthz ----------

const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'new', description: '开新会话 · /new <prompt>' },
  { command: 'sessions', description: '查看会话列表' },
  { command: 'switch', description: '切到某会话 · /switch <id|name>' },
  { command: 'resume', description: '继续会话 · /resume <id|name>' },
  { command: 'fork', description: '分叉会话 · /fork <id|name>' },
  { command: 'kill', description: '结束会话 · /kill <id|name>' },
  { command: 'forget', description: '完全删除会话+历史 · /forget <id|name>' },
  { command: 'stop', description: '中断当前会话的本轮生成' },
  { command: 'stats', description: '今日用量与花费' },
  { command: 'model', description: '设默认模型 · /model sonnet|opus|haiku' },
  { command: 'verbose', description: '路由 tool_use 事件 · /verbose on|off' },
  { command: 'help', description: '命令速查' },
];
// Hash of the commands list — used to re-push when the catalog changes.
const BOT_COMMANDS_HASH = JSON.stringify(BOT_COMMANDS);
let lastSyncedCommandsHash: string | null = null;

async function handleHealthz(env: Env): Promise<Response> {
  try {
    const tg = new TgApi(env.TELEGRAM_BOT_TOKEN);
    const me = await tg.getMe();
    // Re-push the catalog whenever the hardcoded list differs from what this
    // isolate last sent. Telegram dedupes server-side, so this is idempotent.
    if (lastSyncedCommandsHash !== BOT_COMMANDS_HASH) {
      try {
        await tg.setMyCommands(BOT_COMMANDS);
        lastSyncedCommandsHash = BOT_COMMANDS_HASH;
      } catch (e) {
        console.warn('setMyCommands failed:', e instanceof Error ? e.message : e);
      }
    }
    return json(200, { ok: true, bot: me.username, commandsSynced: lastSyncedCommandsHash !== null });
  } catch (e) {
    return json(503, { ok: false, error: e instanceof Error ? e.message : 'unknown' });
  }
}

// ---------- /pair/new + /pair/status ----------

function forwardToDirectory(env: Env, request: Request, doPath: string): Promise<Response> {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
  const fwdUrl = `https://do${doPath}`;
  return stub.fetch(fwdUrl, {
    method: request.method,
    headers: { 'content-type': 'application/json' },
    body: request.method === 'POST' ? request.body : undefined,
  });
}

// Cache the bot username across requests served by the same isolate. Workers
// reuse global scope until the isolate is recycled — typically minutes — and
// every isolate that needs it will fetch once.
let cachedBotUsername: string | undefined;

async function getBotUsername(env: Env): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  const me = await new TgApi(env.TELEGRAM_BOT_TOKEN).getMe();
  cachedBotUsername = me.username;
  return cachedBotUsername;
}

async function handlePairNew(request: Request, env: Env): Promise<Response> {
  const dirRes = await forwardToDirectory(env, request, '/pair/new');
  if (!dirRes.ok) return dirRes;
  const data = (await dirRes.json()) as { pairToken: string; expiresAt: number };
  const botUsername = await getBotUsername(env);
  return json(200, {
    ...data,
    deepLink: `https://t.me/${botUsername}?start=${data.pairToken}`,
  });
}

// ---------- /pair/bind (admin escape hatch) ----------

async function handlePairBind(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) {
    return json(404, { error: 'admin bind disabled (set ADMIN_TOKEN secret to enable)' });
  }
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json(401, { error: 'unauthorized' });
  }
  const body = (await request.json()) as {
    pairToken?: string;
    tgUserId?: string;
    tgUsername?: string;
  };
  if (!body.pairToken || !body.tgUserId) {
    return json(400, { error: 'pairToken and tgUserId required' });
  }
  const dirStub = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
  const bindRes = await dirStub.fetch('https://do/pair/bind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!bindRes.ok) return new Response(await bindRes.text(), { status: bindRes.status });
  const bindData = (await bindRes.json()) as {
    deviceName: string;
    paired?: { deviceToken: string; deviceId: string; tgUserId: string };
  };
  if (!bindData.paired) return json(500, { error: 'bind succeeded but paired info missing' });

  // Send welcome via UserDO so it caches chatId (= tgUserId for DM mode).
  await env.USER.get(env.USER.idFromName(bindData.paired.tgUserId)).fetch(
    'https://do/welcome-paired',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: bindData.paired.tgUserId,
        deviceName: bindData.deviceName,
      }),
    },
  );

  return json(200, {
    status: 'paired',
    tgUserId: bindData.paired.tgUserId,
    deviceId: bindData.paired.deviceId,
  });
}

// ---------- /tg-webhook ----------

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number | string } };
    data?: string;
  };
}

async function handleTgWebhook(request: Request, env: Env): Promise<Response> {
  // Optional shared-secret verification. setWebhook can register a secret which
  // Telegram echoes in this header; the Worker rejects requests without it.
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (got !== env.TG_WEBHOOK_SECRET) {
      return json(401, { error: 'bad webhook secret' });
    }
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return json(400, { error: 'bad json' });
  }

  // We must respond to Telegram quickly (within seconds) or it'll retry. Do
  // the actual work and only return once it's complete — Workers can run
  // ctx.waitUntil for fire-and-forget, but for correctness here we await.
  const tg = new TgApi(env.TELEGRAM_BOT_TOKEN);

  if (update.message?.text?.startsWith('/start')) {
    await handleStartCommand(update, tg, env);
    return new Response('ok');
  }
  if (update.message?.text === '/help') {
    await handleHelpCommand(update, tg);
    return new Response('ok');
  }
  if (update.message?.text?.startsWith('/')) {
    await handleSlashCommand(update, env);
    return new Response('ok');
  }
  if (update.message?.text) {
    await handleFreeText(update, env);
    return new Response('ok');
  }
  if (update.callback_query?.data) {
    await handleCallbackQuery(update, tg, env);
    return new Response('ok');
  }

  return new Response('ok');
}

async function handleFreeText(update: TgUpdate, env: Env): Promise<void> {
  const msg = update.message!;
  const fromUserId = String(msg.from?.id ?? msg.chat.id);
  const userStub = env.USER.get(env.USER.idFromName(fromUserId));
  await userStub.fetch('https://do/inbox-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: msg.text,
      fromUsername: msg.from?.username,
      chatId: String(msg.chat.id),
    }),
  });
}

async function handleHelpCommand(update: TgUpdate, tg: TgApi): Promise<void> {
  const chatId = String(update.message!.chat.id);
  try {
    await tg.sendMessage(
      chatId,
      `🦆 <b>duckling</b> — 在 Telegram 上跑 Claude Code\n\n` +
        `<b>常用：</b>\n` +
        `  · 直接发消息 → 当前会话继续聊\n` +
        `  · <code>/new 帮我写个 quicksort</code> → 开新会话\n` +
        `  · <code>/sessions</code> → 看看有哪些会话\n` +
        `  · <code>/stop</code> → 打断当前生成（会话不关）\n\n` +
        `<b>会话管理：</b>\n` +
        `  <code>/new &lt;prompt&gt;</code> — 新开会话\n` +
        `  <code>/switch &lt;id|name&gt;</code> — 切到指定会话（或点会话头上的"▶"按钮）\n` +
        `  <code>/resume &lt;id|name&gt;</code> — 继续旧会话\n` +
        `  <code>/fork &lt;id|name&gt;</code> — 从某会话分叉一条新支线\n` +
        `  <code>/kill &lt;id|name&gt;</code> — 结束某会话（历史保留，可 /resume）\n` +
        `  <code>/forget &lt;id|name&gt;</code> — 完全删掉某会话+jsonl 历史，不可恢复\n\n` +
        `<b>设置：</b>\n` +
        `  <code>/model sonnet|opus|haiku</code> — 默认模型\n` +
        `  <code>/verbose on|off</code> — 是否转发常规 tool_use 事件\n` +
        `  <code>/stats</code> — 今日用量\n\n` +
        `<b>问题回答：</b>Claude 弹出选项时直接点按钮；如果是多个问题，按 <code>答1 | 答2</code> 的格式回复。`,
      { parseMode: 'HTML', silent: true },
    );
  } catch (e) {
    console.warn('help send failed:', e);
  }
}

async function handleSlashCommand(update: TgUpdate, env: Env): Promise<void> {
  const msg = update.message!;
  const text = (msg.text ?? '').slice(1); // strip leading '/'
  const space = text.indexOf(' ');
  // Strip any /command@bot_username Telegram sometimes appends in groups.
  const rawCommand = space === -1 ? text : text.slice(0, space);
  const command = rawCommand.split('@')[0];
  const args = space === -1 ? '' : text.slice(space + 1);
  const chatId = String(msg.chat.id);
  const fromUserId = String(msg.from?.id ?? msg.chat.id);

  // Aliases for the few commands we handle locally (don't need a daemon roundtrip).
  if (command === 'sessions' || command === 'list') {
    await env.USER.get(env.USER.idFromName(fromUserId)).fetch('https://do/sessions-list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId }),
    });
    return;
  }

  await env.USER.get(env.USER.idFromName(fromUserId)).fetch('https://do/inbox-command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, command, args, fromUsername: msg.from?.username }),
  });
}

async function handleCallbackQuery(update: TgUpdate, tg: TgApi, env: Env): Promise<void> {
  const cb = update.callback_query!;
  const fromUserId = String(cb.from.id);
  const chatId = cb.message ? String(cb.message.chat.id) : fromUserId;
  // Always answer the callback so TG stops the spinner; we don't need to surface text.
  try {
    await tg.answerCallbackQuery(cb.id);
  } catch (e) {
    console.warn('answerCallbackQuery failed:', e);
  }
  if (!cb.data) return;
  await env.USER.get(env.USER.idFromName(fromUserId)).fetch('https://do/inbox-callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: cb.data, chatId }),
  });
}

async function handleStartCommand(update: TgUpdate, tg: TgApi, env: Env): Promise<void> {
  const msg = update.message!;
  const after = (msg.text ?? '').slice('/start'.length).trim();
  const chatId = String(msg.chat.id);
  const fromUserId = String(msg.from?.id ?? msg.chat.id);
  const fromUsername = msg.from?.username;

  console.log(`/start from ${fromUserId}${fromUsername ? ` (@${fromUsername})` : ''}${after ? ` token=${after.slice(0, 8)}…` : ' (no token)'}`);

  if (!after) {
    // Stray /start — echo their TG user ID so they can fall back to admin
    // bind if the deep link doesn't honour the start parameter.
    try {
      await tg.sendMessage(
        chatId,
        `🦆 Hi! Open this bot from a fresh <code>duckling setup</code> deep link to pair a device.\n\n` +
          `Your Telegram user ID is: <code>${esc(fromUserId)}</code>`,
        { parseMode: 'HTML', silent: true },
      );
    } catch (e) {
      console.warn('greeting send failed:', e);
    }
    return;
  }

  const dirStub = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
  const bindRes = await dirStub.fetch('https://do/pair/bind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken: after, tgUserId: fromUserId, tgUsername: fromUsername }),
  });

  if (bindRes.status === 404) {
    try {
      await tg.sendMessage(
        chatId,
        `That pairing link is expired or already used. Run <code>duckling setup</code> again to get a fresh one.`,
        { parseMode: 'HTML', silent: true },
      );
    } catch (e) {
      console.warn('expiry notice send failed:', e);
    }
    return;
  }
  if (!bindRes.ok) {
    console.warn('Directory bindPair failed', bindRes.status, await bindRes.text());
    return;
  }

  const bindData = (await bindRes.json()) as {
    deviceName: string;
    paired?: { deviceToken: string; deviceId: string };
  };
  if (!bindData.paired) {
    console.warn('bind returned without paired info');
    return;
  }

  // Cache chatId in UserDO and send the welcome message.
  try {
    await env.USER.get(env.USER.idFromName(fromUserId)).fetch('https://do/welcome-paired', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, deviceName: bindData.deviceName }),
    });
  } catch (e) {
    console.warn('welcome dispatch failed:', e);
  }
}

// callback_query routing was removed when the inline-button UX (approval /
// AskUserQuestion buttons) went away. duckling no longer attaches inline
// keyboards, so any callback that arrives is a stale message from the old
// design; we silently ignore.

// ---------- /ws (daemon WebSocket) ----------

async function handleWsUpgrade(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('upgrade') !== 'websocket') {
    return json(400, { error: 'expected websocket upgrade' });
  }
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token) return new Response('missing token', { status: 401 });

  const dirStub = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
  const authRes = await dirStub.fetch(
    `https://do/auth?token=${encodeURIComponent(token)}`,
  );
  if (!authRes.ok) {
    return new Response('Unauthorized', { status: 401 });
  }
  const auth = (await authRes.json()) as {
    tgUserId: string;
    deviceId: string;
    deviceName: string;
  };

  const userStub = env.USER.get(env.USER.idFromName(auth.tgUserId));

  const fwdHeaders = new Headers(request.headers);
  fwdHeaders.set('x-duckling-device-id', auth.deviceId);
  fwdHeaders.set('x-duckling-device-name', auth.deviceName);

  const fwdReq = new Request('https://do/ws', {
    method: 'GET',
    headers: fwdHeaders,
  });
  return userStub.fetch(fwdReq);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
