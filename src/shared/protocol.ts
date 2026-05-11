/**
 * duckling wire types (SDK era).
 *
 * After the SDK pivot duckling no longer spawns `claude` in a pty. It runs the
 * Claude Agent SDK in-process per session and forwards structured events to
 * Telegram. The wire types reflect SDK semantics — there's no byte stream,
 * just discrete events.
 *
 *   1. Daemon ↔ Relay (Cloudflare Worker) over WebSocket
 *   2. Relay ↔ Telegram via Bot API (in worker/tg-api.ts)
 */

// ---------------------------------------------------------------------------
// Session metadata shared on both sides
// ---------------------------------------------------------------------------

export type SessionStatus = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'killed';

export interface SessionSummary {
  /** Stable opaque ID we assign on launch (short random string). */
  id: string;
  /** Human-friendly name (kebab-case slug of prompt or user-supplied). */
  name: string;
  /** The Claude session id from SDK (`system.init.session_id`) — populated after launch. */
  claudeSessionId?: string;
  /** Latest known status. */
  status: SessionStatus;
  /** First-line preview of the original prompt. */
  promptPreview: string;
  /** Workdir (cwd) when launched. */
  cwd?: string;
  /** Model used. */
  model?: string;
  /** Accumulated cost in USD. */
  costUsd: number;
  /** Epoch ms when launched. */
  startedAt: number;
  /** Epoch ms when finished, if applicable. */
  completedAt?: number;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface QuestionItem {
  question: string;
  header?: string;
  options?: string[];
  multiSelect?: boolean;
}

/** A Claude session on disk that the daemon could `claude --resume` into. */
export interface ResumableEntry {
  /** The Claude SDK session id — file basename in ~/.claude/projects/.../ */
  claudeSessionId: string;
  /** mtime of the jsonl file, used for "X minutes ago" labels. */
  mtimeMs: number;
  /** First user prompt from the transcript, truncated. Empty if unreadable. */
  firstPrompt?: string;
}

// ---------------------------------------------------------------------------
// Daemon → Relay
// ---------------------------------------------------------------------------

export type DaemonToRelay =
  | {
      type: 'hello';
      deviceName: string;
      os: string;
      version: string;
    }
  | {
      // New session started. Emit on launch (after we have the SDK session_id).
      type: 'session_started';
      session: SessionSummary;
    }
  | {
      // Claude said something. Emitted on each `assistant` SDK message with
      // text content. Multi-text-block messages get joined.
      type: 'assistant_text';
      sessionId: string; // duckling-local session id
      text: string;
    }
  | {
      // Claude is invoking a tool. The worker side ignores this for ordinary
      // tools (we never show mid-task progress); TodoWrite and
      // AskUserQuestion get dedicated event types below.
      type: 'tool_use';
      sessionId: string;
      tool: string;
      /** Free-form JSON-serializable input. */
      input: unknown;
      /** SDK tool_use_id, used to correlate AskUserQuestion answer. */
      toolUseId: string;
    }
  | {
      // claude finished the AskUserQuestion tool — for SSH-style answering.
      // Same shape as tool_use but emitted after completion with the answer.
      type: 'tool_result';
      sessionId: string;
      toolUseId: string;
      output: unknown;
    }
  | {
      // Claude has a (potentially edit-in-place) plan. Always emitted on
      // TodoWrite, includes the full todos snapshot.
      type: 'plan_update';
      sessionId: string;
      todos: TodoItem[];
    }
  | {
      // Claude is asking the user a question (AskUserQuestion).
      type: 'question';
      sessionId: string;
      toolUseId: string;
      questions: QuestionItem[];
    }
  | {
      // Session reached the end of a turn or terminated.
      type: 'session_done';
      sessionId: string;
      status: 'completed' | 'failed' | 'killed';
      costUsd: number;
      durationMs: number;
      numTurns: number;
      finalText?: string;
      errorMessage?: string;
    }
  | {
      // The session manager's snapshot of all sessions (sent on demand for
      // /sessions and proactively when state changes).
      type: 'sessions_snapshot';
      sessions: SessionSummary[];
      currentId?: string;
    }
  | {
      // Session was forgotten (after /forget). Worker should delete its
      // anchor message + cached session record.
      type: 'session_forgotten';
      sessionId: string;
    }
  | {
      // Reply to a `request_resumable`. List of Claude sessions on disk
      // (jsonl files in ~/.claude/projects/<cwd>/), newest first.
      type: 'resumable_list';
      resumable: ResumableEntry[];
    }
  | {
      // Out-of-band note for the user (e.g. "no live session — /new first").
      // Rendered as a plain TG message; not tied to a session.
      type: 'notice';
      text: string;
    }
  | { type: 'pong'; id: string };

// ---------------------------------------------------------------------------
// Relay → Daemon
// ---------------------------------------------------------------------------

export type RelayToDaemon =
  | {
      type: 'welcome';
      tgUserId: string;
      deviceId: string;
    }
  | {
      // User chatted free-form text. Without explicit session_id, default to
      // the most-recent session (or new one if none).
      type: 'chat';
      text: string;
      /** Explicit session id to target — if omitted, daemon picks current. */
      sessionId?: string;
      fromUsername?: string;
    }
  | {
      // /new <prompt> — always start a fresh session.
      type: 'new_session';
      prompt: string;
      /** Optional human-readable name (slug). */
      name?: string;
      /** Optional model override. */
      model?: string;
      fromUsername?: string;
    }
  | {
      // /resume <name|id>
      type: 'resume_session';
      idOrName: string;
      /** Fork the resumed session into a new branch instead of continuing. */
      fork?: boolean;
    }
  | {
      // /kill <name|id>
      type: 'kill_session';
      idOrName: string;
    }
  | {
      // /switch <name|id> — pick which session free-text chat goes to. No
      // SDK round-trip; just rewires the daemon's "currentId" pointer.
      type: 'set_current';
      idOrName: string;
    }
  | {
      // /forget <name|id> — full purge: kill if alive, drop the in-memory
      // record, delete the underlying claude conversation jsonl on disk.
      type: 'forget_session';
      idOrName: string;
    }
  | {
      // /stop — interrupt the currently running work in the current session,
      // but keep the session open.
      type: 'stop_current';
    }
  | {
      // Answer to a previously-emitted `question` event. Daemon forwards as
      // a stream message to the SDK session.
      type: 'question_answer';
      sessionId: string;
      toolUseId: string;
      /** One selected option string per question, in original question order. */
      answers: string[];
    }
  | {
      // /sessions — daemon will reply with a `sessions_snapshot` event.
      type: 'list_sessions';
    }
  | {
      // /new (no args) — daemon will reply with a `resumable_list` event so
      // the worker can offer the user a "resume which one, or fresh?" picker.
      type: 'request_resumable';
    }
  | { type: 'ping'; id: string }
  | { type: 'error'; message: string; fatal?: boolean };

// ---------------------------------------------------------------------------
// Pairing API (unchanged)
// ---------------------------------------------------------------------------

export interface PairNewRequest {
  deviceName: string;
}

export interface PairNewResponse {
  pairToken: string;
  deepLink: string;
  expiresAt: number;
}

export type PairStatusResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'paired';
      tgUserId: string;
      tgUsername?: string;
      deviceToken: string;
      deviceId: string;
    };
