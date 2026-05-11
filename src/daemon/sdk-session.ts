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
  prompt: string;
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

  /** Push a tool_result back to the SDK — used to answer AskUserQuestion. */
  pushToolResult(toolUseId: string, content: unknown, claudeSessionId: string): void {
    this.queue.push({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(content) },
        ],
      },
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
  /** Raw AskUserQuestion input keyed by tool_use id, kept so we can echo
   *  it back in the tool_result the SDK schema expects. */
  private pendingQuestions = new Map<string, unknown>();

  constructor(opts: SessionSpawnOpts, callbacks: SessionCallbacks) {
    this.id = randomId(8);
    this.name = opts.name ?? slugFromPrompt(opts.prompt);
    this.prompt = opts.prompt;
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
    // First user message goes into the stream BEFORE we start the query.
    // We don't have the Claude session_id yet — pass empty and the SDK will
    // fill it in on the `system.init` it emits back.
    this.inputStream.push(this.opts.prompt, '');
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
    if (this.status !== 'running' && this.status !== 'waiting') {
      log.warn(`sendMessage on session ${this.id} (status=${this.status}) — ignored`);
      return;
    }
    this.inputStream.push(text, this.claudeSessionId ?? '');
    this.status = 'running';
  }

  /** Answer an AskUserQuestion the model is waiting on. */
  answerQuestion(toolUseId: string, answers: string[]): void {
    // AskUserQuestionOutput shape (per the SDK's tool schema):
    //   { questions: [...echo of input...], answers: { [questionText]: chosen } }
    // We kept the raw input on dispatch; rebuild the output now so the model
    // doesn't read it as a cancellation.
    const rawInput = this.pendingQuestions.get(toolUseId);
    this.pendingQuestions.delete(toolUseId);
    const qs = (rawInput as { questions?: unknown })?.questions;
    const qArray = Array.isArray(qs) ? qs : [];
    const answersMap: Record<string, string> = {};
    for (let i = 0; i < qArray.length; i++) {
      const q = qArray[i] as { question?: string };
      if (q && typeof q.question === 'string') {
        answersMap[q.question] = answers[i] ?? '';
      }
    }
    const output = { questions: qArray, answers: answersMap };
    this.inputStream.pushToolResult(toolUseId, output, this.claudeSessionId ?? '');
    this.status = 'running';
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
    } catch (e) {
      if (this.status !== 'killed') {
        this.fail(e instanceof Error ? e.message : String(e));
      }
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
          if (b.name === 'TodoWrite') {
            const todos = extractTodos(b.input);
            this.lastTodos = todos;
            this.callbacks.onPlanUpdate?.(this, todos);
          } else if (b.name === 'AskUserQuestion') {
            const questions = extractQuestions(b.input);
            this.status = 'waiting';
            this.pendingQuestions.set(toolUseId, b.input);
            this.callbacks.onQuestion?.(this, toolUseId, questions);
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
        this.status = 'failed';
        this.completedAt = Date.now();
        this.lastError = `SDK result ${r.subtype}`;
        this.callbacks.onFailed?.(this, this.lastError);
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
function slugFromPrompt(p: string): string {
  const words = p
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 5);
  if (words.length === 0) return 'session-' + randomId(4);
  const slug = words.join('-').slice(0, 40);
  return slug || 'session-' + randomId(4);
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
