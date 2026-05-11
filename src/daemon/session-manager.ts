import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../shared/logger';
import { ResumableEntry, SessionSummary } from '../shared/protocol';
import { Session, SessionCallbacks, SessionSpawnOpts } from './sdk-session';

/** Number format helper: 1 → "一号", 2 → "二号", … 10 → "十号", 11+ → "11号". */
const EMPLOYEE_ZH = ['', '一号', '二号', '三号', '四号', '五号', '六号', '七号', '八号', '九号', '十号'];
function employeeName(n: number): string {
  return `员工${n <= 10 ? EMPLOYEE_ZH[n] : `${n}号`}`;
}

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

  constructor(private readonly callbacks: SessionCallbacks) {}

  spawn(opts: SessionSpawnOpts): Session {
    // Auto-name fresh "empty" sessions as 员工一号 / 员工二号 / ... so the user
    // doesn't have to think one up. Only applies when both name and prompt
    // are empty (i.e., the worker is asking for a blank employee to wait
    // for the first task).
    let name = opts.name;
    if (!name && !opts.prompt?.trim()) {
      name = employeeName(this.sessions.size + 1);
    }
    const session = new Session({ ...opts, name }, this.wrapCallbacks());
    this.sessions.set(session.id, session);
    this.currentId = session.id;
    log.info(`spawned session ${session.id} (name=${session.name})`);
    session.start();
    return session;
  }

  /**
   * Scan ~/.claude/projects/<encoded-cwd>/*.jsonl for sessions the SDK
   * could `--resume`. Reads the first user message of each file so we can
   * label it in the picker. Best-effort; on errors returns whatever we got.
   */
  listResumable(cwd?: string): ResumableEntry[] {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return [];
    const encoded = (cwd ?? process.env.HOME ?? '').replace(/\//g, '-');
    // ONLY scan the current cwd's project dir — the SDK's `--resume` looks
    // up the session in cwd's encoded subdir, so showing sessions from other
    // cwds in the picker leads to "No conversation found" failures when the
    // user taps them.
    const primary = path.join(projectsDir, encoded);
    if (!encoded || !fs.existsSync(primary)) return [];
    let files: string[];
    try {
      files = fs.readdirSync(primary).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const out: ResumableEntry[] = [];
    for (const f of files) {
      const full = path.join(primary, f);
      const claudeSessionId = f.replace(/\.jsonl$/, '');
      if (!/^[A-Za-z0-9_-]{8,}$/.test(claudeSessionId)) continue;
      // Skip sessions the daemon already has in memory — those go through
      // the normal "live" sessions list.
      if (this.claudeIdIndex.has(claudeSessionId)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const firstPrompt = extractFirstPrompt(full);
      // Filter out sessions with no readable first user prompt — those are
      // typically empty/corrupted transcripts, not useful to resume.
      if (!firstPrompt || firstPrompt.trim().length < 2) continue;
      out.push({ claudeSessionId, mtimeMs, firstPrompt });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
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
        cb.onComplete?.(s, finalText);
      },
      onFailed: (s, err) => {
        cb.onFailed?.(s, err);
      },
    };
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
  // Defense in depth: refuse anything that doesn't look like a session id.
  // Real values are UUIDs (36 chars, hex + dashes) from the SDK; a malformed
  // id would let `fname` escape projectsDir via "../" segments.
  if (!isPlausibleSessionId(sessionId)) {
    log.warn(`forget: refusing to delete file for suspicious sessionId: ${sessionId}`);
    return;
  }
  const projectsDir = path.resolve(path.join(os.homedir(), '.claude', 'projects'));
  if (!fs.existsSync(projectsDir)) return;
  const fname = `${sessionId}.jsonl`;
  let removed = 0;
  const tryRm = (p: string): void => {
    // Final containment check — never unlink anything that resolves outside projectsDir.
    const resolved = path.resolve(p);
    if (!resolved.startsWith(projectsDir + path.sep)) {
      log.warn(`forget: refusing unlink outside projects dir: ${resolved}`);
      return;
    }
    try {
      fs.unlinkSync(resolved);
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

/**
 * Loose "looks like a session id" test — accepts UUIDs (Claude SDK) and
 * duckling's short base64url ids. Anything with path separators, dots that
 * could be `..`, or unicode is rejected.
 */
function isPlausibleSessionId(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * Sip just the first ~10 KB of a session jsonl and grab the first user
 * message's text. Used to label resumable sessions in the picker so the
 * user can recognise "what was I doing in this session?".
 */
function extractFirstPrompt(jsonlPath: string): string | undefined {
  let chunk: string;
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(10 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    chunk = buf.toString('utf8', 0, n);
  } catch {
    return undefined;
  }
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('{')) continue;
    let obj: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'user' && obj.message?.role === 'user') {
      const content = obj.message.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
            const t = (block as { text?: string }).text;
            if (typeof t === 'string') {
              text = t;
              break;
            }
          }
        }
      }
      text = text.trim().replace(/\s+/g, ' ');
      if (text) return text.length > 80 ? text.slice(0, 77) + '…' : text;
    }
  }
  return undefined;
}

