import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../shared/logger';
import {
  QuestionItem,
  SessionStatus,
  SessionSummary,
  TodoItem,
} from '../shared/protocol';

/**
 * One Claude Code SDK session, wrapped so the daemon can drive it as a
 * long-lived multi-turn conversation.
 *
 * Internals follow the same shape openclaw-claude-code-plugin uses:
 *   - a `MessageStream` async-iterable feeds user prompts into the SDK query
 *   - the SDK query's async-generator output we consume into a stream of
 *     callback events (assistant text, tool use, plan update, etc.)
 *   - on `result` the session finishes (unless multi-turn keeps it open)
 *
 * The daemon (session-manager.ts) wires the callbacks to WS messages that
 * eventually surface in Telegram.
 */

export interface SessionSpawnOpts {
  /** Initial task. Empty/undefined means "blank employee" — Session waits for
   *  the first chat message to start the first turn (no tokens burned). */
  prompt?: string;
  name?: string;
  cwd?: string;
  model?: string;
  /** Resume an existing Claude session. The SDK gives us multi-turn for free. */
  resumeClaudeSessionId?: string;
  forkSession?: boolean;
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  allowedTools?: string[];
  systemPrompt?: string;
  /** Max USD before SDK aborts. 0 = no cap (use sparingly). */
  maxBudgetUsd?: number;
}

export interface SessionCallbacks {
  onSessionInit?: (s: Session) => void;
  onAssistantText?: (s: Session, text: string) => void;
  onToolUse?: (s: Session, tool: string, input: unknown, toolUseId: string) => void;
  onToolResult?: (s: Session, toolUseId: string, output: unknown) => void;
  onPlanUpdate?: (s: Session, todos: TodoItem[]) => void;
  onQuestion?: (s: Session, toolUseId: string, questions: QuestionItem[]) => void;
  onComplete?: (s: Session, finalText: string | undefined) => void;
  onFailed?: (s: Session, error: string) => void;
}

// User-side input stream we push into. The SDK's query() consumes this as
// an AsyncIterable, so pushing a message kicks Claude into a new turn.
class MessageStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  push(content: string, claudeSessionId: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: claudeSessionId || undefined,
    });
    this.wake();
  }

  end(): void {
    this.done = true;
    this.wake();
  }

  private wake(): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) yield next;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
  }
}

export class Session {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly startedAt: number;

  status: SessionStatus = 'starting';
  claudeSessionId?: string;
  costUsd = 0;
  completedAt?: number;
  lastError?: string;
  numTurns = 0;
  /** Snapshot of the most recent TodoWrite. */
  lastTodos: TodoItem[] = [];

  private readonly opts: SessionSpawnOpts;
  private readonly callbacks: SessionCallbacks;
  private readonly inputStream = new MessageStream();
  private queryHandle: ReturnType<typeof query> | null = null;
  private abortController = new AbortController();
  private currentTurnTextChunks: string[] = [];
  /**
   * True if the current turn invoked a tool, produced a plan, or asked a
   * question. Used by the daemon to decide whether to push a `session_done`
   * footer — pure conversational replies (no work done) don't get one.
   * Resets at the start of each turn (`system.init`).
   */
  currentTurnDidWork = false;
  /**
   * Pending AskUserQuestion resolvers keyed by tool_use id. The SDK invokes
   * our `canUseTool` callback when the model wants to ask the user; the
   * callback parks a Promise here and returns it. Later, when the relay
   * delivers the user's answer via `answerQuestion()`, we resolve the
   * matching Promise so `canUseTool` returns `{ behavior: 'allow', ... }`.
   */
  private questionResolvers = new Map<string, (answers: string[]) => void>();

  constructor(opts: SessionSpawnOpts, callbacks: SessionCallbacks) {
    this.id = randomId(8);
    this.name = opts.name ?? slugFromPrompt(opts.prompt ?? '');
    this.prompt = opts.prompt ?? '';
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.startedAt = Date.now();
    this.opts = opts;
    this.callbacks = callbacks;
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      name: this.name,
      claudeSessionId: this.claudeSessionId,
      status: this.status,
      promptPreview: this.prompt.slice(0, 80),
      cwd: this.cwd,
      model: this.model,
      costUsd: this.costUsd,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  /** Begin the SDK query and start the consumer loop. Resolves immediately. */
  start(): void {
    // If we have an initial prompt, push it BEFORE starting the query so
    // the first turn fires immediately. If it's empty (the "blank employee"
    // case: user did /new with no task and will send one in the next chat
    // message), don't push anything — query() just waits on the stream and
    // the first `sendMessage()` will kick off the first turn.
    if (this.opts.prompt && this.opts.prompt.trim().length > 0) {
      this.inputStream.push(this.opts.prompt, '');
    }
    const options: Record<string, unknown> = {
      cwd: this.opts.cwd,
      model: this.opts.model,
      permissionMode: this.opts.permissionMode ?? 'bypassPermissions',
      allowDangerouslySkipPermissions:
        (this.opts.permissionMode ?? 'bypassPermissions') === 'bypassPermissions',
      allowedTools: this.opts.allowedTools,
      systemPrompt: this.opts.systemPrompt,
      includePartialMessages: false,
      abortController: this.abortController,
      pathToClaudeCodeExecutable: resolveClaudeBinary(),
      canUseTool: this.canUseTool.bind(this),
    };
    if (typeof this.opts.maxBudgetUsd === 'number' && this.opts.maxBudgetUsd > 0) {
      options.maxBudgetUsd = this.opts.maxBudgetUsd;
    }
    if (this.opts.resumeClaudeSessionId) {
      options.resume = this.opts.resumeClaudeSessionId;
      if (this.opts.forkSession) options.forkSession = true;
    }
    try {
      this.queryHandle = query({
        prompt: this.inputStream,
        options: options as unknown as Parameters<typeof query>[0]['options'],
      });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    void this.consumeMessages();
  }

  /** Send a follow-up user message. */
  sendMessage(text: string): void {
    // 'starting' is allowed because the "blank employee" spawn path (empty
    // initial prompt) leaves the SDK query waiting on an empty input stream —
    // we never reach system.init until the first chat lands. Reject only on
    // terminal states.
    if (
      this.status === 'completed' ||
      this.status === 'failed' ||
      this.status === 'killed'
    ) {
      log.warn(`sendMessage on session ${this.id} (status=${this.status}) — ignored`);
      return;
    }
    this.inputStream.push(text, this.claudeSessionId ?? '');
    this.status = 'running';
  }

  /**
   * Resolve the pending AskUserQuestion this id is parked on. Called by
   * the daemon when the relay forwards the user's button tap / typed reply.
   * No-op if nothing is parked (stale answer, double-answer, etc.) — log so
   * we notice if that happens.
   */
  answerQuestion(toolUseId: string, answers: string[]): void {
    const resolver = this.questionResolvers.get(toolUseId);
    if (!resolver) {
      log.warn(`answerQuestion: no pending resolver for tool_use ${toolUseId}`);
      return;
    }
    this.questionResolvers.delete(toolUseId);
    resolver(answers);
    this.status = 'running';
  }

  /**
   * SDK permission callback. The SDK invokes this for **every** tool the
   * model wants to use — that's where we hook AskUserQuestion to route to
   * Telegram. For everything else we just allow (the daemon already runs
   * with `bypassPermissions`; gating tools is Claude Code's job, not ours).
   *
   * For AskUserQuestion the SDK schema wants `{ questions, answers }` back
   * as `updatedInput`. We park a Promise keyed by toolUseId and resolve it
   * from `answerQuestion()` when the user replies in Telegram.
   */
  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; toolUseID: string },
  ): Promise<{ behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    if (toolName !== 'AskUserQuestion') {
      // Any tool invocation other than the question prompt counts as "did
      // work" — when the SDK opens the turn footer later, we want to surface
      // the summary because something happened.
      this.currentTurnDidWork = true;
      return { behavior: 'allow', updatedInput: input };
    }
    const toolUseId = opts.toolUseID;
    const questions = extractQuestions(input);
    this.status = 'waiting';
    this.currentTurnDidWork = true;
    this.callbacks.onQuestion?.(this, toolUseId, questions);
    let answers: string[];
    try {
      answers = await new Promise<string[]>((resolve, reject) => {
        this.questionResolvers.set(toolUseId, resolve);
        const onAbort = () => {
          this.questionResolvers.delete(toolUseId);
          reject(new Error('aborted'));
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      });
    } catch (e) {
      return { behavior: 'deny', message: e instanceof Error ? e.message : String(e) };
    }
    // Build the answers map the AskUserQuestion tool schema expects:
    //   { questions: [...echo...], answers: { [questionText]: chosenLabel } }
    const qs = Array.isArray((input as { questions?: unknown }).questions)
      ? ((input as { questions: unknown[] }).questions)
      : [];
    const answersMap: Record<string, string> = {};
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i] as { question?: string };
      if (q && typeof q.question === 'string') {
        answersMap[q.question] = answers[i] ?? '';
      }
    }
    return {
      behavior: 'allow',
      updatedInput: { questions: qs, answers: answersMap },
    };
  }

  /** Interrupt the current generation. Session stays open for more turns. */
  async interrupt(): Promise<void> {
    if (this.queryHandle && typeof this.queryHandle.interrupt === 'function') {
      try {
        await this.queryHandle.interrupt();
      } catch (e) {
        log.warn('interrupt failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  /** Terminate the session entirely. */
  kill(): void {
    if (this.status === 'completed' || this.status === 'failed' || this.status === 'killed') {
      return;
    }
    this.status = 'killed';
    this.completedAt = Date.now();
    try {
      this.abortController.abort();
    } catch {
      // Already aborted — fine.
    }
    this.inputStream.end();
    // Surface termination so the daemon can emit session_done. The consume
    // loop's abort-triggered catch is suppressed when status==='killed', so
    // without this the user would never see the close-out.
    this.callbacks.onFailed?.(this, 'killed by user');
  }

  // ---------- internal ----------

  private fail(error: string): void {
    // Idempotent: if the session already ended (success / failed / killed),
    // ignore late failure events. The SDK can deliver both a result-with-
    // error AND a thrown exception from the same underlying problem; we
    // only want one session_done out.
    if (
      this.status === 'failed' ||
      this.status === 'killed' ||
      this.status === 'completed'
    ) {
      return;
    }
    this.status = 'failed';
    this.lastError = error;
    this.completedAt = Date.now();
    this.callbacks.onFailed?.(this, error);
  }

  private async consumeMessages(): Promise<void> {
    if (!this.queryHandle) return;
    try {
      for await (const m of this.queryHandle) {
        this.handleSdkMessage(m);
      }
      // Stream ended without a thrown exception. If we recorded a deferred
      // failure via lastError (from a result.error_* subtype), flush it now.
      if (this.lastError && this.status === 'running') {
        this.fail(this.lastError);
      }
    } catch (e) {
      // Prefer the thrown message — usually more actionable than the bare
      // SDK result subtype we stashed in lastError. `fail()` is idempotent
      // and returns early if the session has already terminated.
      const errMsg = e instanceof Error ? e.message : String(e);
      this.fail(errMsg || this.lastError || 'SDK error');
    }
  }

  private handleSdkMessage(m: unknown): void {
    const msg = m as { type?: string; [k: string]: unknown };
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
      // The SDK emits `system.init` at the start of EVERY turn (it's claude's
      // way of declaring the active session_id), not just the first. Only fire
      // onSessionInit once per Session so we don't repaint the "🚀 session
      // started" banner on every turn.
      const sysInit = msg as { session_id?: string };
      const firstInit = !this.claudeSessionId;
      this.claudeSessionId = sysInit.session_id;
      this.status = 'running';
      // New turn → reset the "did work" flag. We re-set it when a tool runs,
      // a plan appears, or a question is asked. Pure conversational replies
      // (Claude says "OK" with no work) leave it false → no summary footer.
      this.currentTurnDidWork = false;
      if (firstInit) this.callbacks.onSessionInit?.(this);
      return;
    }

    if (msg.type === 'assistant') {
      const assistant = msg as { message?: { content?: unknown[] } };
      const blocks = assistant.message?.content ?? [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string; name?: string; id?: string; input?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') {
          this.currentTurnTextChunks.push(b.text);
          this.callbacks.onAssistantText?.(this, b.text);
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          const toolUseId = b.id ?? '';
          // Any tool invocation counts as "did work" for footer purposes.
          this.currentTurnDidWork = true;
          if (b.name === 'TodoWrite') {
            const todos = extractTodos(b.input);
            this.lastTodos = todos;
            this.callbacks.onPlanUpdate?.(this, todos);
          } else if (b.name === 'AskUserQuestion') {
            // Handled in `canUseTool` — that's where we park the Promise and
            // route the question to Telegram. The SDK calls our callback
            // before completing the tool_use, so we don't need to react here.
          } else {
            this.callbacks.onToolUse?.(this, b.name, b.input, toolUseId);
          }
        }
      }
      return;
    }

    if (msg.type === 'result') {
      const r = msg as {
        subtype?: string;
        total_cost_usd?: number;
        duration_ms?: number;
        num_turns?: number;
        is_error?: boolean;
      };
      if (typeof r.total_cost_usd === 'number') this.costUsd = r.total_cost_usd;
      if (typeof r.num_turns === 'number') this.numTurns = r.num_turns;
      if (r.subtype === 'success') {
        // Multi-turn: stay alive, await next user message. We surface a
        // logical "turn ended" via onComplete with finalText.
        const finalText = this.currentTurnTextChunks.join('\n\n');
        this.currentTurnTextChunks = [];
        this.status = 'running'; // ready for next sendMessage
        this.callbacks.onComplete?.(this, finalText);
      } else {
        // Don't fail immediately — the SDK usually throws a more detailed
        // error message right after this result. Record the subtype as a
        // fallback and let consumeMessages() catch the thrown error for
        // the real message. If no throw arrives, the post-loop flush below
        // emits with the recorded fallback.
        this.lastError = `SDK result ${r.subtype}`;
        this.inputStream.end();
      }
    }
  }
}

/**
 * Pick a Claude Code native binary the SDK can spawn. The SDK ships
 * platform-specific subpackages (`-linux-x64`, `-linux-x64-musl`, etc.) but
 * its libc auto-detect is unreliable in some environments (e.g. picks the
 * musl build on a glibc system). We override `pathToClaudeCodeExecutable`
 * with a deliberate choice:
 *   1. DUCKLING_CLAUDE_BIN — user override, no questions asked.
 *   2. On Linux glibc, prefer the `-linux-x64` package over `-linux-x64-musl`.
 *   3. Whatever sibling package exists next to the SDK install.
 *   4. Undefined — let the SDK try its own detection (and fail loudly if that
 *      doesn't work, with the original error message intact).
 */
function resolveClaudeBinary(): string | undefined {
  const fromEnv = process.env.DUCKLING_CLAUDE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  let anthropicDir: string;
  try {
    // Resolve the SDK's main entry, then walk up to the package root, then up
    // one more to get the `@anthropic-ai/` namespace dir that holds the
    // platform sibling packages.
    const main = require.resolve('@anthropic-ai/claude-agent-sdk');
    let dir = path.dirname(main);
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
    anthropicDir = path.dirname(dir);
  } catch {
    return undefined;
  }

  const candidates: string[] = [];
  if (process.platform === 'linux' && process.arch === 'x64') {
    // glibc first — covers Ubuntu/Debian/Fedora/etc.
    if (!isMuslRuntime()) {
      candidates.push(path.join(anthropicDir, 'claude-agent-sdk-linux-x64', 'claude'));
    }
    candidates.push(path.join(anthropicDir, 'claude-agent-sdk-linux-x64-musl', 'claude'));
  } else if (process.platform === 'linux' && process.arch === 'arm64') {
    candidates.push(path.join(anthropicDir, 'claude-agent-sdk-linux-arm64', 'claude'));
  } else if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    candidates.push(path.join(anthropicDir, `claude-agent-sdk-${arch}`, 'claude'));
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function isMuslRuntime(): boolean {
  // process.report exposes the glibc runtime version on glibc systems and
  // omits it on musl. Cheap, no spawn required.
  try {
    const hdr = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
      ?.header;
    return !hdr?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function randomId(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, bytes);
}

/** Crude slug from the first 4-6 words of the prompt. */
/**
 * Build a short, task-flavoured slug from the first user prompt. The goal is
 * "the user can recognise this session in /sessions without having seen its
 * id" — so we strip filler words ("please", "help", "我", "帮我", "可以"...)
 * and keep the verbs + nouns. Falls back to a random suffix if the prompt is
 * empty or pure stop-words.
 */
function slugFromPrompt(p: string): string {
  // English / generic filler that adds no task signal.
  const STOP_EN = new Set([
    'a', 'an', 'the', 'please', 'pls', 'can', 'could', 'would', 'should',
    'help', 'me', 'i', 'you', 'we', 'our', 'my', 'your', 'this', 'that',
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or', 'but', 'with',
    'do', 'does', 'did', 'have', 'has', 'had', 'will', 'just',
  ]);
  // Chinese fillers (subjects, particles, politeness).
  const STOP_ZH = new Set([
    '我', '你', '他', '她', '它', '我们', '你们', '他们',
    '的', '了', '吗', '呢', '吧', '啊', '嗯', '哦',
    '请', '帮', '帮我', '麻烦', '可以', '能', '能不能', '可不可以',
    '一下', '现在', '一个', '这个', '那个',
  ]);

  // Split on whitespace + punctuation. Keep CJK characters as-is so each
  // ideograph survives the split intact.
  const tokens = p
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_EN.has(w) && !STOP_ZH.has(w));

  // Take the first 5 surviving tokens. Cap total length so the chat picker
  // / TG buttons stay legible.
  const slug = tokens.slice(0, 5).join('-').slice(0, 40);
  return slug || 'task-' + randomId(4);
}

function extractTodos(input: unknown): TodoItem[] {
  const i = (input ?? {}) as { todos?: unknown };
  if (!Array.isArray(i.todos)) return [];
  const out: TodoItem[] = [];
  for (const t of i.todos) {
    if (t && typeof t === 'object') {
      const o = t as { content?: unknown; status?: unknown };
      if (typeof o.content === 'string') {
        const status =
          o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
        out.push({ content: o.content, status });
      }
    }
  }
  return out;
}

function extractQuestions(input: unknown): QuestionItem[] {
  const i = (input ?? {}) as { questions?: unknown };
  if (!Array.isArray(i.questions)) return [];
  const out: QuestionItem[] = [];
  for (const q of i.questions) {
    if (!q || typeof q !== 'object') continue;
    const o = q as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof o.question !== 'string') continue;
    const opts: string[] = [];
    if (Array.isArray(o.options)) {
      for (const opt of o.options) {
        if (typeof opt === 'string') opts.push(opt);
        else if (opt && typeof opt === 'object') {
          const ol = opt as { label?: unknown };
          if (typeof ol.label === 'string') opts.push(ol.label);
        }
      }
    }
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : undefined,
      options: opts.length > 0 ? opts : undefined,
      multiSelect: o.multiSelect === true ? true : undefined,
    });
  }
  return out;
}
