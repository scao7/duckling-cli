import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../shared/logger';
import { SessionSummary } from '../shared/protocol';
import { Session, SessionCallbacks, SessionSpawnOpts } from './sdk-session';

/**
 * Tracks all live SDK sessions, the "current" one for free-text routing, and
 * cheap daily bookkeeping for /stats. The manager is owned by the daemon
 * entrypoint; it wires Session callbacks to whatever the daemon wants to do
 * (typically: send WS events to the relay).
 *
 * No persistence. If the daemon dies, sessions die. The Claude SDK keeps the
 * actual conversation in `~/.claude/projects/`, so a user can /resume after
 * restart and pick up the underlying conversation — they just won't see the
 * mid-flight in-memory state we'd have lost.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  /** claudeSessionId → duckling session id, for resume-by-claude-id lookups. */
  private claudeIdIndex = new Map<string, string>();
  private currentId: string | undefined;

  // /stats counters, reset at local midnight (best-effort).
  private dayKey = todayKey();
  private costToday = 0;
  private launchedToday = 0;

  /** When true, daemon forwards routine tool_use events; else only Todo/Ask. */
  verbose = false;
  /** Default model for new sessions when caller doesn't override. */
  defaultModel: string | undefined;

  constructor(private readonly callbacks: SessionCallbacks) {}

  spawn(opts: SessionSpawnOpts): Session {
    this.rollDayIfNeeded();
    const merged: SessionSpawnOpts = {
      ...opts,
      model: opts.model ?? this.defaultModel,
    };
    const session = new Session(merged, this.wrapCallbacks());
    this.sessions.set(session.id, session);
    this.currentId = session.id;
    this.launchedToday++;
    log.info(`spawned session ${session.id} (name=${session.name})`);
    session.start();
    return session;
  }

  /** Find by duckling id, name, or claudeSessionId. */
  resolve(idOrName: string): Session | undefined {
    if (!idOrName) return undefined;
    const direct = this.sessions.get(idOrName);
    if (direct) return direct;
    const viaClaude = this.claudeIdIndex.get(idOrName);
    if (viaClaude) return this.sessions.get(viaClaude);
    // Name match — newest first so users get the most-recent on collisions.
    const all = [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
    return all.find((s) => s.name === idOrName);
  }

  current(): Session | undefined {
    return this.currentId ? this.sessions.get(this.currentId) : undefined;
  }

  setCurrent(id: string): void {
    if (this.sessions.has(id)) this.currentId = id;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((s) => s.summary());
  }

  /**
   * Route free-form text to the current (or explicitly named) session.
   * Returns the session that took the message, or `null` if no live target
   * exists. The caller is responsible for telling the user to /new — we
   * never auto-spawn on a bare chat, to keep session creation explicit.
   */
  routeChat(text: string, explicitSessionId?: string): Session | null {
    const target = explicitSessionId
      ? this.resolve(explicitSessionId)
      : this.current();
    if (target && target.status !== 'completed' && target.status !== 'failed' && target.status !== 'killed') {
      this.currentId = target.id;
      target.sendMessage(text);
      return target;
    }
    return null;
  }

  kill(idOrName: string): Session | undefined {
    const s = this.resolve(idOrName);
    if (!s) return undefined;
    s.kill();
    return s;
  }

  /**
   * Hard delete: kill the session if alive, drop the in-memory record, and
   * remove the underlying Claude conversation jsonl from disk so /resume
   * can't bring it back.
   *
   * Returns the duckling session id we forgot, or undefined if no match.
   */
  forget(idOrName: string): string | undefined {
    const s = this.resolve(idOrName);
    if (!s) return undefined;
    const id = s.id;
    s.kill();
    this.sessions.delete(id);
    if (s.claudeSessionId) {
      this.claudeIdIndex.delete(s.claudeSessionId);
      try {
        deleteClaudeSessionFile(s.cwd, s.claudeSessionId);
      } catch (e) {
        log.warn('forget: failed to delete claude jsonl:', e instanceof Error ? e.message : e);
      }
    }
    if (this.currentId === id) {
      // Promote the most recent live session, if any, as the new current.
      const live = [...this.sessions.values()]
        .filter((x) => x.status === 'running' || x.status === 'waiting' || x.status === 'starting')
        .sort((a, b) => b.startedAt - a.startedAt);
      this.currentId = live[0]?.id;
    }
    return id;
  }

  killAll(): void {
    for (const s of this.sessions.values()) s.kill();
  }

  async stopCurrent(): Promise<void> {
    const s = this.current();
    if (!s) return;
    await s.interrupt();
  }

  stats(): { totalCostUsdToday: number; sessionsLaunchedToday: number; runningCount: number } {
    this.rollDayIfNeeded();
    let running = 0;
    for (const s of this.sessions.values()) {
      if (s.status === 'running' || s.status === 'waiting' || s.status === 'starting') running++;
    }
    return {
      totalCostUsdToday: this.costToday,
      sessionsLaunchedToday: this.launchedToday,
      runningCount: running,
    };
  }

  currentSessionId(): string | undefined {
    return this.currentId;
  }

  // ---------- internal ----------

  private wrapCallbacks(): SessionCallbacks {
    const cb = this.callbacks;
    return {
      onSessionInit: (s) => {
        if (s.claudeSessionId) this.claudeIdIndex.set(s.claudeSessionId, s.id);
        this.currentId = s.id;
        cb.onSessionInit?.(s);
      },
      onAssistantText: (s, text) => {
        this.currentId = s.id;
        cb.onAssistantText?.(s, text);
      },
      onToolUse: (s, tool, input, toolUseId) => {
        if (!this.verbose) return;
        cb.onToolUse?.(s, tool, input, toolUseId);
      },
      onToolResult: (s, toolUseId, output) => {
        cb.onToolResult?.(s, toolUseId, output);
      },
      onPlanUpdate: (s, todos) => {
        cb.onPlanUpdate?.(s, todos);
      },
      onQuestion: (s, toolUseId, questions) => {
        this.currentId = s.id;
        cb.onQuestion?.(s, toolUseId, questions);
      },
      onComplete: (s, finalText) => {
        this.bumpCost(s.costUsd);
        cb.onComplete?.(s, finalText);
      },
      onFailed: (s, err) => {
        this.bumpCost(s.costUsd);
        cb.onFailed?.(s, err);
      },
    };
  }

  /** We accumulate `costUsd` from the SDK's per-result totals. To avoid
   *  double-counting we just track the running session's latest cost — the
   *  SDK reports cumulative-per-session, not per-turn delta — so we sum the
   *  current totals across all sessions started today on each request. */
  private bumpCost(_latest: number): void {
    this.rollDayIfNeeded();
    let total = 0;
    for (const s of this.sessions.values()) {
      if (sameDay(s.startedAt, this.dayKey)) total += s.costUsd;
    }
    this.costToday = total;
  }

  private rollDayIfNeeded(): void {
    const k = todayKey();
    if (k !== this.dayKey) {
      this.dayKey = k;
      this.costToday = 0;
      this.launchedToday = 0;
    }
  }
}

/**
 * Locate and unlink the Claude conversation file for a given session.
 *
 * Claude Code stores per-session transcripts as
 *   ~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl
 *
 * The encoding of the project directory differs subtly across Claude versions
 * (some encode `_` too), so we just hunt for any subdirectory containing a
 * file named `<sessionId>.jsonl` and rm whatever we find.
 */
function deleteClaudeSessionFile(cwd: string | undefined, sessionId: string): void {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return;
  const fname = `${sessionId}.jsonl`;
  let removed = 0;
  const tryRm = (p: string): void => {
    try {
      fs.unlinkSync(p);
      removed++;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw e;
    }
  };
  // Fast path: if cwd is known, try the canonical encoding first.
  if (cwd) {
    const encoded = cwd.replace(/\//g, '-');
    tryRm(path.join(projectsDir, encoded, fname));
  }
  if (removed > 0) return;
  // Fallback: scan all project subdirs for a matching filename.
  for (const entry of fs.readdirSync(projectsDir)) {
    const candidate = path.join(projectsDir, entry, fname);
    if (fs.existsSync(candidate)) tryRm(candidate);
  }
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function sameDay(epoch: number, key: string): boolean {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === key;
}
