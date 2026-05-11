/**
 * UserDO — one Durable Object per Telegram user.
 *
 * SDK era: the daemon emits structured events (assistant text, plan updates,
 * questions, tool use, completion) and we render each into a TG message.
 * Two pieces of in-DO state matter:
 *   - `chatId` — where to send TG messages
 *   - `ses:<sessionId>` — per-session record (current status, plan message id
 *     for edit-in-place, last question context for button callbacks).
 *
 * Most SDK events translate into a single TG sendMessage. The plan update is
 * special: we cache its TG message id and edit it on subsequent updates so
 * the user sees TODOs evolve in place.
 */

import { DaemonToRelay, QuestionItem, RelayToDaemon, SessionSummary, TodoItem } from '../shared/protocol';
import { esc } from '../shared/render';
import { InlineKeyboard, TgApi } from './tg-api';
import type { Env } from './types';

interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  createdAt: number;
  lastSeen?: number;
}

interface SessionRecord {
  name: string;
  deviceId: string;
  deviceName: string;
  status: string;
  planMessageId?: number;
  /** The "anchor" message — sent on session_started, edited as status changes. */
  anchorMessageId?: number;
  startedAt: number;
  claudeSessionId?: string;
  promptPreview?: string;
}

interface QuestionCtx {
  sessionId: string;
  toolUseId: string;
  questions: QuestionItem[];
  createdAt: number;
}

interface WsAttachment {
  deviceId: string;
  deviceName: string;
}

const TG_MAX_LEN = 4000;

export class UserDO implements DurableObject {
  private storage: DurableObjectStorage;
  private tg: TgApi;

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    this.storage = state.storage;
    this.tg = new TgApi(env.TELEGRAM_BOT_TOKEN);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/upsert-device':
          return await this.handleUpsertDevice(request);
        case '/welcome-paired':
          return await this.handleWelcomePaired(request);
        case '/sessions-list':
          return await this.handleSessionsList(request);
        case '/inbox-text':
          return await this.handleInboxText(request);
        case '/inbox-command':
          return await this.handleInboxCommand(request);
        case '/inbox-callback':
          return await this.handleInboxCallback(request);
        case '/ws':
          return await this.handleWsUpgrade(request);
        default:
          return json(404, { error: 'unknown user-do route' });
      }
    } catch (e) {
      console.error('UserDO error', e);
      return json(500, { error: e instanceof Error ? e.message : 'internal' });
    }
  }

  // -------- device records --------

  private async handleUpsertDevice(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      deviceId: string;
      deviceName: string;
      deviceToken: string;
    };
    const rec: DeviceRecord = {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      deviceToken: body.deviceToken,
      createdAt: Date.now(),
    };
    await this.storage.put(`dev:${body.deviceId}`, rec);
    return json(200, { ok: true });
  }

  // -------- WS (daemon ↔ relay) --------

  private async handleWsUpgrade(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') {
      return json(400, { error: 'expected websocket upgrade' });
    }
    const deviceId = request.headers.get('x-duckling-device-id');
    const deviceName = request.headers.get('x-duckling-device-name');
    if (!deviceId || !deviceName) {
      return json(400, { error: 'missing device headers' });
    }
    const dev = await this.storage.get<DeviceRecord>(`dev:${deviceId}`);
    if (!dev) return json(401, { error: 'device not registered' });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ deviceId, deviceName } satisfies WsAttachment);
    this.state.acceptWebSocket(server);

    dev.lastSeen = Date.now();
    await this.storage.put(`dev:${deviceId}`, dev);

    const chatId = await this.ensureChatId();
    const welcome: RelayToDaemon = {
      type: 'welcome',
      tgUserId: chatId ?? deviceId,
      deviceId,
    };
    server.send(JSON.stringify(welcome));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) {
      console.warn('ws message with no attachment, closing');
      ws.close(1011, 'missing attachment');
      return;
    }
    let msg: DaemonToRelay;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text) as DaemonToRelay;
    } catch (e) {
      console.warn('bad daemon message:', e);
      return;
    }
    await this.handleDaemonMessage(att, msg);
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string): Promise<void> {
    // Devices live in storage, attachment GC'd with ws — nothing to clean up.
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.warn('ws error:', error);
  }

  private async handleDaemonMessage(att: WsAttachment, msg: DaemonToRelay): Promise<void> {
    const chatId = await this.ensureChatId();
    if (!chatId) {
      console.warn('no chatId yet for this user; ignoring daemon msg', msg.type);
      return;
    }
    switch (msg.type) {
      case 'hello':
      case 'pong':
        return;
      case 'session_started':
        await this.onSessionStarted(chatId, att, msg.session);
        return;
      case 'assistant_text':
        await this.onAssistantText(chatId, att, msg.sessionId, msg.text);
        return;
      case 'tool_use':
        await this.onToolUse(chatId, att, msg.sessionId, msg.tool, msg.input);
        return;
      case 'tool_result':
        // No-op for now — the only tool_results we'd want surface via the
        // assistant_text that follows. AskUserQuestion answers flow through
        // /inbox-callback, not here.
        return;
      case 'plan_update':
        await this.onPlanUpdate(chatId, att, msg.sessionId, msg.todos);
        return;
      case 'question':
        await this.onQuestion(chatId, att, msg.sessionId, msg.toolUseId, msg.questions);
        return;
      case 'session_done':
        await this.onSessionDone(chatId, att, msg.sessionId, msg);
        return;
      case 'sessions_snapshot':
        await this.cacheSessionsSnapshot(msg.sessions, msg.currentId);
        return;
      case 'stats':
        await this.sendStats(chatId, msg);
        return;
      case 'notice':
        await this.safeSend(chatId, () =>
          this.tg.sendMessage(chatId, msg.text, { parseMode: 'HTML', silent: true }),
        );
        return;
      case 'session_forgotten':
        await this.onSessionForgotten(chatId, msg.sessionId);
        return;
    }
  }

  private async onSessionForgotten(chatId: string, sessionId: string): Promise<void> {
    const rec = await this.storage.get<SessionRecord>(`ses:${sessionId}`);
    if (rec?.anchorMessageId) {
      try {
        // Best effort — bots can only delete messages they sent within 48h.
        // Anything older we just leave with a "forgotten" body via edit.
        await this.tg.deleteMessage(chatId, rec.anchorMessageId);
      } catch {
        try {
          await this.tg.editMessage(chatId, rec.anchorMessageId, `🗑 <i>session forgotten</i>`, {
            parseMode: 'HTML',
          });
        } catch {
          // Both delete and edit failed — give up.
        }
      }
    }
    await this.storage.delete(`ses:${sessionId}`);
  }

  // ---------- daemon → TG renderers ----------

  private async onSessionStarted(
    chatId: string,
    att: WsAttachment,
    session: SessionSummary,
  ): Promise<void> {
    const rec: SessionRecord = {
      name: session.name,
      deviceId: att.deviceId,
      deviceName: att.deviceName,
      status: session.status,
      startedAt: session.startedAt,
      claudeSessionId: session.claudeSessionId,
      promptPreview: session.promptPreview,
    };
    const body = renderAnchor(rec, session.id, true);
    const keyboard: InlineKeyboard = [
      [
        { text: '▶ 切到此会话', callback_data: `s:${session.id}:switch` },
        { text: '🛑 结束会话', callback_data: `s:${session.id}:kill` },
      ],
    ];
    try {
      const msgId = await this.tg.sendMessage(chatId, body, {
        parseMode: 'HTML',
        silent: true,
        keyboard,
      });
      rec.anchorMessageId = msgId;
    } catch (e) {
      console.warn('anchor send failed:', e);
    }
    await this.storage.put(`ses:${session.id}`, rec);
  }

  private async refreshAnchor(
    chatId: string,
    sessionId: string,
    isCurrent: boolean,
  ): Promise<void> {
    const rec = await this.storage.get<SessionRecord>(`ses:${sessionId}`);
    if (!rec?.anchorMessageId) return;
    const body = renderAnchor(rec, sessionId, isCurrent);
    const stillAlive = rec.status === 'running' || rec.status === 'starting' || rec.status === 'waiting';
    const keyboard: InlineKeyboard | undefined = stillAlive
      ? [
          [
            { text: isCurrent ? '✓ 当前' : '▶ 切到此会话', callback_data: `s:${sessionId}:switch` },
            { text: '🛑 结束会话', callback_data: `s:${sessionId}:kill` },
          ],
        ]
      : undefined;
    try {
      await this.tg.editMessage(chatId, rec.anchorMessageId, body, {
        parseMode: 'HTML',
        keyboard,
      });
    } catch (e) {
      // Editing a deleted/old message will 400 — not fatal.
      console.warn('anchor edit failed:', e instanceof Error ? e.message : e);
    }
  }

  private async onAssistantText(
    chatId: string,
    att: WsAttachment,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    const rec = await this.storage.get<SessionRecord>(`ses:${sessionId}`);
    const head = `<b>${esc(rec?.name ?? sessionId)}</b> · ${esc(att.deviceName)}`;
    const chunks = chunkForTg(clean, TG_MAX_LEN - head.length - 8);
    for (let i = 0; i < chunks.length; i++) {
      const body = esc(chunks[i]);
      const suffix = chunks.length > 1 ? ` <i>(${i + 1}/${chunks.length})</i>` : '';
      // Fire typing right before each chunk — the message itself will cancel
      // it, so the user sees a brief "…is typing" then the message lands.
      void this.tg.sendChatAction(chatId);
      await this.safeSend(chatId, () =>
        this.tg.sendMessage(chatId, `${head}${suffix}\n${body}`, {
          parseMode: 'HTML',
          silent: true,
        }),
      );
    }
  }

  private async onToolUse(
    chatId: string,
    _att: WsAttachment,
    sessionId: string,
    tool: string,
    input: unknown,
  ): Promise<void> {
    // Fire typing right before the bot speaks — the upcoming sendMessage
    // cancels it, so the user sees a brief "…is typing" then the message.
    void this.tg.sendChatAction(chatId);
    const rec = await this.storage.get<SessionRecord>(`ses:${sessionId}`);
    const preview = previewToolInput(tool, input);
    await this.safeSend(chatId, () =>
      this.tg.sendMessage(
        chatId,
        `🔧 <b>${esc(rec?.name ?? sessionId)}</b> · <code>${esc(tool)}</code>` +
          (preview ? `\n<pre>${esc(preview)}</pre>` : ''),
        { parseMode: 'HTML', silent: true },
      ),
    );
  }

  private async onPlanUpdate(
    chatId: string,
    _att: WsAttachment,
    sessionId: string,
    todos: TodoItem[],
  ): Promise<void> {
    // Fire typing right before sending the plan render (or before editing it).
    void this.tg.sendChatAction(chatId);
    const rec = await this.storage.get<SessionRecord>(`ses:${sessionId}`);
    if (!rec) return;
    const body = renderPlan(rec.name, todos);
    if (rec.planMessageId) {
      try {
        await this.tg.editMessage(chatId, rec.planMessageId, body, { parseMode: 'HTML' });
        return;
      } catch (e) {
        // Edit failed (message deleted, too old, etc.) — fall through to send a fresh one.
        console.warn('plan edit failed, resending:', e instanceof Error ? e.message : e);
      }
    }
    try {
      const id = await this.tg.sendMessage(chatId, body, { parseMode: 'HTML', silent: true });
      rec.planMessageId = id;
      await this.storage.put(`ses:${sessionId}`, rec);
    } catch (e) {
      console.warn('plan send failed:', e);
    }
  }

  private async onQuestion(
    chatId: string,
    _att: WsAttachment,
    sessionId: string,
    toolUseId: string,
    questions: QuestionItem[],
  ): Promise<void> {
    const rec = await this.storage.get<SessionRecord>(`ses:${sessionId}`);
    const sesName = rec?.name ?? sessionId;
    if (questions.length === 0) return;

    // Single question with options → inline keyboard, one-tap answer.
    const single = questions[0];
    if (questions.length === 1 && single.options && single.options.length > 0 && !single.multiSelect) {
      const short = shortId();
      const ctx: QuestionCtx = { sessionId, toolUseId, questions, createdAt: Date.now() };
      await this.storage.put(`qctx:${short}`, ctx);
      const keyboard: InlineKeyboard = single.options.map((opt, i) => [
        {
          text: opt.length > 40 ? opt.slice(0, 37) + '…' : opt,
          callback_data: `q:${short}:0:${i}`,
        },
      ]);
      await this.safeSend(chatId, () =>
        this.tg.sendMessage(
          chatId,
          `❓ <b>${esc(sesName)}</b>${single.header ? ` · ${esc(single.header)}` : ''}\n${esc(single.question)}`,
          { parseMode: 'HTML', keyboard, silent: true },
        ),
      );
      return;
    }

    // Fallback: render all questions as text, ask user to reply with `|`-separated answers.
    const short = shortId();
    const ctx: QuestionCtx = { sessionId, toolUseId, questions, createdAt: Date.now() };
    await this.storage.put(`qctx:${short}`, ctx);
    await this.storage.put('pendingQ', short);
    const lines = questions
      .map((q, i) => {
        const opts = q.options ? `\n   Options: ${q.options.map((o) => `<code>${esc(o)}</code>`).join(', ')}` : '';
        return `<b>${i + 1}.</b> ${esc(q.question)}${opts}`;
      })
      .join('\n\n');
    await this.safeSend(chatId, () =>
      this.tg.sendMessage(
        chatId,
        `❓ <b>${esc(sesName)}</b> needs your input:\n\n${lines}\n\n` +
          `<i>Reply with your answers separated by " | ".</i>`,
        { parseMode: 'HTML', silent: true },
      ),
    );
  }

  private async onSessionDone(
    chatId: string,
    _att: WsAttachment,
    sessionId: string,
    msg: Extract<DaemonToRelay, { type: 'session_done' }>,
  ): Promise<void> {
    const rec = await this.storage.get<SessionRecord>(`ses:${sessionId}`);
    const name = rec?.name ?? sessionId;
    const icon = msg.status === 'completed' ? '✅' : msg.status === 'killed' ? '🛑' : '❌';
    const cost = msg.costUsd > 0 ? ` · $${msg.costUsd.toFixed(4)}` : '';
    const dur = formatMs(msg.durationMs);
    let body = `${icon} <b>${esc(name)}</b> ${esc(msg.status)} · ${dur}${cost}`;
    if (msg.errorMessage) body += `\n<i>${esc(msg.errorMessage)}</i>`;
    await this.safeSend(chatId, () =>
      this.tg.sendMessage(chatId, body, { parseMode: 'HTML', silent: true }),
    );
    if (rec) {
      rec.status = msg.status;
      await this.storage.put(`ses:${sessionId}`, rec);
      // Redraw the anchor so its buttons disappear and its status updates.
      await this.refreshAnchor(chatId, sessionId, false);
    }
  }

  private async cacheSessionsSnapshot(
    sessions: SessionSummary[],
    currentId: string | undefined,
  ): Promise<void> {
    await this.storage.put('snapshot', { sessions, currentId, at: Date.now() });
    // Keep every anchor's "current ◀" marker in sync with the daemon's view.
    // Limit to a handful per snapshot to stay under TG's 30 msg/s/chat budget;
    // realistic session counts (≤ ~10) fit comfortably.
    const chatId = await this.ensureChatId();
    if (!chatId) return;
    for (const s of sessions.slice(0, 12)) {
      // Update the cached record's status before redrawing so the anchor
      // shows the daemon's latest view (running/waiting/completed/...).
      const rec = await this.storage.get<SessionRecord>(`ses:${s.id}`);
      if (rec && rec.status !== s.status) {
        rec.status = s.status;
        await this.storage.put(`ses:${s.id}`, rec);
      }
      await this.refreshAnchor(chatId, s.id, s.id === currentId);
    }
  }

  private async sendStats(
    chatId: string,
    msg: Extract<DaemonToRelay, { type: 'stats' }>,
  ): Promise<void> {
    await this.safeSend(chatId, () =>
      this.tg.sendMessage(
        chatId,
        `📊 <b>Today</b>\n` +
          `Running: ${msg.runningCount}\n` +
          `Launched: ${msg.sessionsLaunchedToday}\n` +
          `Cost: $${msg.totalCostUsdToday.toFixed(4)}`,
        { parseMode: 'HTML', silent: true },
      ),
    );
  }

  // ---------- TG → daemon routing ----------

  private async handleInboxText(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      text: string;
      fromUsername?: string;
      chatId: string;
    };
    // If there's a pending multi-question, treat this reply as the answer.
    const pendingShort = await this.storage.get<string>('pendingQ');
    if (pendingShort) {
      const ctx = await this.storage.get<QuestionCtx>(`qctx:${pendingShort}`);
      if (ctx) {
        await this.storage.delete('pendingQ');
        await this.storage.delete(`qctx:${pendingShort}`);
        const parts = body.text.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
        const answers: string[] = [];
        for (let i = 0; i < ctx.questions.length; i++) answers.push(parts[i] ?? '');
        const answerMsg: RelayToDaemon = {
          type: 'question_answer',
          sessionId: ctx.sessionId,
          toolUseId: ctx.toolUseId,
          answers,
        };
        const delivered = this.broadcastToDaemons(answerMsg);
        if (delivered === 0) {
          await this.tg
            .sendMessage(body.chatId, `<i>No daemon online — answer not delivered.</i>`, {
              parseMode: 'HTML',
              silent: true,
            })
            .catch(() => undefined);
        }
        return json(200, { ok: true, kind: 'question_answer' });
      }
    }
    // Otherwise route as free-form chat to the current session.
    const chatMsg: RelayToDaemon = {
      type: 'chat',
      text: body.text,
      fromUsername: body.fromUsername,
    };
    const delivered = this.broadcastToDaemons(chatMsg);
    if (delivered === 0) {
      try {
        await this.tg.sendMessage(
          body.chatId,
          `<i>📭 No daemon online — your message wasn't delivered. Run <code>duckling start</code> on a paired device.</i>`,
          { parseMode: 'HTML', silent: true },
        );
      } catch (e) {
        console.warn('no-daemon notice failed:', e);
      }
    }
    return json(200, { ok: true, delivered });
  }

  private async handleInboxCommand(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      chatId: string;
      command: string;
      args: string;
      fromUsername?: string;
    };
    const parsed = parseCommand(body.command, body.args, body.fromUsername);
    if (!parsed.msg) {
      // For commands that operate on a session, replace the "type the id"
      // hint with a tappable picker — the user doesn't have to know any IDs.
      if (
        body.command === 'kill' ||
        body.command === 'switch' ||
        body.command === 'use' ||
        body.command === 'resume' ||
        body.command === 'fork' ||
        body.command === 'forget' ||
        body.command === 'purge'
      ) {
        await this.showSessionPicker(body.chatId, body.command);
        return json(200, { ok: false, picker: true });
      }
      const hint = parsed.usage
        ? `用法：<code>${esc(parsed.usage)}</code>`
        : `未知命令：<code>/${esc(body.command)}</code>。发送 <code>/help</code> 查看完整列表。`;
      try {
        await this.tg.sendMessage(body.chatId, hint, { parseMode: 'HTML', silent: true });
      } catch {
        // Ignore — the user can retype.
      }
      return json(200, { ok: false });
    }
    const delivered = this.broadcastToDaemons(parsed.msg);
    if (delivered === 0) {
      try {
        await this.tg.sendMessage(
          body.chatId,
          `<i>📭 没有在线的 daemon —— 在某台机器上跑 <code>duckling start</code> 后再试 <code>/${esc(body.command)}</code>。</i>`,
          { parseMode: 'HTML', silent: true },
        );
      } catch {
        // Ignore — not worth retrying.
      }
    }
    return json(200, { ok: true, delivered });
  }

  /**
   * Show a tappable list of sessions for the given action so the user
   * doesn't have to type an ID. `kill`/`switch` only list live sessions;
   * `resume`/`fork` include completed ones too.
   */
  private async showSessionPicker(chatId: string, action: string): Promise<void> {
    const includeDone = action === 'resume' || action === 'fork' || action === 'forget' || action === 'purge';
    const snap = await this.storage.get<{
      sessions: SessionSummary[];
      currentId?: string;
      at: number;
    }>('snapshot');
    let sessions = snap?.sessions ?? [];
    if (!includeDone) {
      sessions = sessions.filter(
        (s) => s.status === 'running' || s.status === 'waiting' || s.status === 'starting',
      );
    }
    if (sessions.length === 0) {
      // Ping the daemon for a fresh snapshot in case our cache is stale,
      // and tell the user nothing is available right now.
      this.broadcastToDaemons({ type: 'list_sessions' });
      try {
        await this.tg.sendMessage(
          chatId,
          includeDone
            ? `没有可恢复的 session。用 <code>/new &lt;prompt&gt;</code> 开一个。`
            : `没有正在跑的 session。用 <code>/new &lt;prompt&gt;</code> 开一个。`,
          { parseMode: 'HTML', silent: true },
        );
      } catch {
        // Ignore — the user can retry.
      }
      return;
    }
    const label = pickerLabel(action);
    const keyboard: InlineKeyboard = sessions.map((s) => {
      const mark = s.id === snap?.currentId ? ' ✓' : '';
      const status = statusIcon(s.status);
      const name = s.name.length > 20 ? s.name.slice(0, 19) + '…' : s.name;
      return [
        {
          text: `${status} ${name}${mark}`,
          callback_data: `s:${s.id}:${normalizeAction(action)}`,
        },
      ];
    });
    try {
      await this.tg.sendMessage(chatId, `选一个 session 来 <b>${esc(label)}</b>：`, {
        parseMode: 'HTML',
        silent: true,
        keyboard,
      });
    } catch (e) {
      console.warn('picker send failed:', e);
    }
  }

  private async handleInboxCallback(request: Request): Promise<Response> {
    const body = (await request.json()) as { data: string; chatId: string };
    const parts = body.data.split(':');
    // q:<short>:<qIdx>:<oIdx>  — AskUserQuestion option pick
    if (parts[0] === 'q' && parts.length === 4) {
      const [, short, qIdxStr, oIdxStr] = parts;
      const ctx = await this.storage.get<QuestionCtx>(`qctx:${short}`);
      if (!ctx) return json(200, { ok: false, error: 'stale' });
      const qIdx = parseInt(qIdxStr, 10);
      const oIdx = parseInt(oIdxStr, 10);
      const q = ctx.questions[qIdx];
      const choice = q?.options?.[oIdx];
      if (!q || choice === undefined) return json(200, { ok: false, error: 'bad idx' });
      await this.storage.delete(`qctx:${short}`);
      const msg: RelayToDaemon = {
        type: 'question_answer',
        sessionId: ctx.sessionId,
        toolUseId: ctx.toolUseId,
        answers: [choice],
      };
      const delivered = this.broadcastToDaemons(msg);
      return json(200, { ok: true, delivered, choice });
    }
    // s:<sessionId>:<action>  — anchor button taps or picker selections
    if (parts[0] === 's' && parts.length === 3) {
      const [, sessionId, action] = parts;
      if (action === 'switch') {
        const ok = this.broadcastToDaemons({ type: 'set_current', idOrName: sessionId });
        // Optimistically refresh the anchor — daemon's broadcastSnapshot
        // will overwrite our cached current marker, but the visual flip is
        // instant for the user.
        await this.refreshAnchor(body.chatId, sessionId, true);
        return json(200, { ok: true, delivered: ok });
      }
      if (action === 'kill') {
        const ok = this.broadcastToDaemons({ type: 'kill_session', idOrName: sessionId });
        return json(200, { ok: true, delivered: ok });
      }
      if (action === 'resume') {
        const ok = this.broadcastToDaemons({ type: 'resume_session', idOrName: sessionId });
        return json(200, { ok: true, delivered: ok });
      }
      if (action === 'fork') {
        const ok = this.broadcastToDaemons({
          type: 'resume_session',
          idOrName: sessionId,
          fork: true,
        });
        return json(200, { ok: true, delivered: ok });
      }
      if (action === 'forget' || action === 'purge') {
        const ok = this.broadcastToDaemons({ type: 'forget_session', idOrName: sessionId });
        return json(200, { ok: true, delivered: ok });
      }
    }
    return json(200, { ok: false });
  }

  private broadcastToDaemons(msg: RelayToDaemon): number {
    let n = 0;
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(JSON.stringify(msg));
        n++;
      } catch (e) {
        console.warn('ws send failed:', e);
      }
    }
    return n;
  }

  // -------- /sessions and welcome --------

  private async handleSessionsList(request: Request): Promise<Response> {
    const body = (await request.json()) as { chatId: string };
    const snapshot = await this.storage.get<{
      sessions: SessionSummary[];
      currentId?: string;
      at: number;
    }>('snapshot');
    const devList = await this.storage.list<DeviceRecord>({ prefix: 'dev:' });
    const devices = [...devList.values()].sort(
      (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
    );
    const online = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (att) online.add(att.deviceId);
    }
    let devicesBlock = '';
    if (devices.length > 0) {
      const lines = devices.map((d) => {
        const dot = online.has(d.deviceId) ? '🟢' : '⚪';
        const seen = d.lastSeen ? ` · last seen ${formatAgo(Date.now() - d.lastSeen)}` : '';
        return `${dot} <b>${esc(d.deviceName)}</b>${seen}`;
      });
      devicesBlock = `\n<b>Devices (${devices.length}):</b>\n${lines.join('\n')}`;
    }

    let sessionsBlock = '';
    if (snapshot && snapshot.sessions.length > 0) {
      // Live snapshot from daemon — preferred.
      const lines = snapshot.sessions.map((s) => {
        const icon = statusIcon(s.status);
        const cur = s.id === snapshot.currentId ? ' ◀' : '';
        return `${icon} <b>${esc(s.name)}</b> · <code>${esc(s.id)}</code>${cur}`;
      });
      sessionsBlock = `<b>Sessions:</b>\n${lines.join('\n')}\n`;
    } else {
      sessionsBlock = `<i>No live sessions cached. Ask the daemon to refresh with /sessions.</i>\n`;
      // Also ping daemons so they emit a snapshot next time.
      this.broadcastToDaemons({ type: 'list_sessions' });
    }

    try {
      await this.tg.sendMessage(body.chatId, sessionsBlock + devicesBlock, {
        parseMode: 'HTML',
        silent: true,
      });
    } catch (e) {
      console.warn('sessions-list send failed:', e);
    }
    return json(200, { ok: true });
  }

  private async handleWelcomePaired(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      chatId: string;
      deviceName: string;
    };
    await this.storage.put('chatId', body.chatId);
    try {
      await this.tg.sendMessage(
        body.chatId,
        `🦆 已配对 <b>${esc(body.deviceName)}</b>。\n\n` +
          `在那台机器上跑 <code>duckling start</code>，然后：\n` +
          `  · <code>/new &lt;prompt&gt;</code> —— 开新会话\n` +
          `  · 直接发消息 —— 接着当前会话聊\n` +
          `  · <code>/sessions</code> —— 看看有哪些会话\n` +
          `  · <code>/help</code> —— 命令速查`,
        { parseMode: 'HTML', silent: true },
      );
    } catch (e) {
      console.warn('welcome send failed:', e);
    }
    return json(200, { ok: true });
  }

  // -------- helpers --------

  private async ensureChatId(): Promise<string | null> {
    return (await this.storage.get<string>('chatId')) ?? null;
  }

  private async safeSend(chatId: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.warn('TG send failed:', e instanceof Error ? e.message : e, 'chatId=', chatId);
    }
  }
}

// ---------- pure helpers ----------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / 86400_000)}d ago`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'running':
      return '🟢';
    case 'waiting':
      return '🔴';
    case 'starting':
      return '🟡';
    case 'completed':
      return '✅';
    case 'failed':
      return '❌';
    case 'killed':
      return '🛑';
    default:
      return '⚪';
  }
}

function pickerLabel(action: string): string {
  switch (action) {
    case 'kill':
      return '结束';
    case 'switch':
    case 'use':
      return '切换';
    case 'resume':
      return '恢复';
    case 'fork':
      return '分叉';
    case 'forget':
    case 'purge':
      return '🗑 完全删除';
    default:
      return action;
  }
}

function normalizeAction(action: string): string {
  // Aliases collapse onto a single callback verb so handlers stay simple.
  if (action === 'use') return 'switch';
  if (action === 'purge') return 'forget';
  return action;
}

function renderAnchor(rec: SessionRecord, sessionId: string, isCurrent: boolean): string {
  const icon = statusIcon(rec.status);
  const cur = isCurrent ? '  <i>(current)</i>' : '';
  const prompt = rec.promptPreview ? `\n<i>${esc(rec.promptPreview)}</i>` : '';
  return (
    `🚀 <b>${esc(rec.name)}</b> · ${esc(rec.deviceName)} · ${icon} ${esc(rec.status)}${cur}` +
    prompt +
    `\n<code>${esc(sessionId)}</code>`
  );
}

function renderPlan(sessionName: string, todos: TodoItem[]): string {
  if (todos.length === 0) return `📋 <b>${esc(sessionName)}</b>\n<i>(no items)</i>`;
  const lines = todos.map((t) => {
    const mark =
      t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔵' : '⬜';
    return `${mark} ${esc(t.content)}`;
  });
  return `📋 <b>${esc(sessionName)}</b>\n${lines.join('\n')}`;
}

function previewToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  if (tool === 'Bash' && typeof i.command === 'string') return clip(i.command, 200);
  if ((tool === 'Edit' || tool === 'Write') && typeof i.file_path === 'string') {
    return clip(String(i.file_path), 200);
  }
  if (tool === 'Read' && typeof i.file_path === 'string') return clip(String(i.file_path), 200);
  // Generic — first stringy field.
  for (const k of Object.keys(i)) {
    if (typeof i[k] === 'string') return clip(`${k}: ${i[k] as string}`, 200);
  }
  return '';
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function chunkForTg(text: string, limit: number): string[] {
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let breakAt = remaining.lastIndexOf('\n', limit);
    if (breakAt <= 0) breakAt = remaining.lastIndexOf(' ', limit);
    if (breakAt <= 0) breakAt = limit;
    out.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\s+/, '');
  }
  if (remaining) out.push(remaining);
  return out;
}

function shortId(): string {
  // 6 alphanumeric chars — enough entropy for concurrent-question disambiguation
  // without bloating the 64-byte callback_data budget.
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

interface ParsedCommand {
  msg: RelayToDaemon | null;
  /** Usage hint shown when args are missing or malformed. */
  usage?: string;
}

function parseCommand(command: string, args: string, fromUsername?: string): ParsedCommand {
  switch (command) {
    case 'new': {
      const prompt = args.trim();
      if (!prompt) return { msg: null, usage: '/new <prompt>' };
      return { msg: { type: 'new_session', prompt, fromUsername } };
    }
    case 'resume': {
      const idOrName = args.trim();
      if (!idOrName) return { msg: null, usage: '/resume <id|name>' };
      return { msg: { type: 'resume_session', idOrName } };
    }
    case 'fork': {
      const idOrName = args.trim();
      if (!idOrName) return { msg: null, usage: '/fork <id|name>' };
      return { msg: { type: 'resume_session', idOrName, fork: true } };
    }
    case 'kill': {
      const idOrName = args.trim();
      if (!idOrName) return { msg: null, usage: '/kill <id|name>' };
      return { msg: { type: 'kill_session', idOrName } };
    }
    case 'switch':
    case 'use': {
      const idOrName = args.trim();
      if (!idOrName) return { msg: null, usage: '/switch <id|name>' };
      return { msg: { type: 'set_current', idOrName } };
    }
    case 'forget':
    case 'purge': {
      const idOrName = args.trim();
      if (!idOrName) return { msg: null, usage: '/forget <id|name>' };
      return { msg: { type: 'forget_session', idOrName } };
    }
    case 'stop':
      return { msg: { type: 'stop_current' } };
    case 'stats':
      return { msg: { type: 'get_stats' } };
    case 'verbose': {
      const v = args.trim().toLowerCase();
      if (v === 'on' || v === 'true' || v === '1') return { msg: { type: 'set_verbose', verbose: true } };
      if (v === 'off' || v === 'false' || v === '0') return { msg: { type: 'set_verbose', verbose: false } };
      return { msg: null, usage: '/verbose on|off' };
    }
    case 'model': {
      const model = args.trim();
      if (!model) return { msg: null, usage: '/model sonnet|opus|haiku' };
      return { msg: { type: 'set_model', model } };
    }
    default:
      return { msg: null };
  }
}
