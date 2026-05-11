# duckling — design doc

> **Drive Claude Code from Telegram.** Run the Claude Agent SDK as a per-user daemon; forward structured events to a Telegram bot; route user replies (text + button taps) back into the SDK.

This document is for contributors and for Claude Code itself when working on this repo. End-user docs live in [README.md](README.md) / [README.zh.md](README.zh.md).

## 1. What it is (and isn't)

**Is:**
- A bridge between the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) and Telegram.
- Multi-session, with anchor messages + inline buttons to switch, kill, forget.
- A shared bot model: one bot + one Cloudflare Worker fan out to many users.

**Isn't:**
- A second permission system. duckling is "just a relay" — Claude Code itself owns trust decisions. We never gate tool calls, never re-prompt, never auto-approve.
- A terminal replacement. SSH is still better for typing code. duckling is for *ambient* access.
- A token broker. Anthropic API calls go from the user's machine straight to Claude via their own OAuth subscription. The relay never sees inference traffic.

## 2. Architecture

```
   Phone                  CF Worker (free tier)            Your computer
 ┌────────┐               ┌─────────────────┐            ┌───────────────────┐
 │Telegram│◀── Bot API ──▶│  duckling-relay │◀── WSS ───▶│ duckling daemon   │
 └────────┘               │  + DirectoryDO  │            │   └ SessionManager│
                          │  + UserDO×N     │            │      └ Session #1 │
                          └─────────────────┘            │      └ Session #2 │
                                                         │           ↓ SDK   │
                                                         │      claude-agent │
                                                         └───────────────────┘
                                                                ↓ OAuth
                                                          Anthropic API
```

Three runtimes:

| Runtime | Code | Lifetime |
|---|---|---|
| CLI | [`src/cli/`](src/cli) | Foreground commands run by the user |
| Daemon | [`src/daemon/`](src/daemon) | Long-lived Node process per device |
| Worker | [`src/worker/`](src/worker) | Stateless edge runtime; state lives in DOs |

Two Durable Objects:

- **DirectoryDO** (singleton, `idFromName('global')`) — mints + validates pairing tokens, deviceToken → tgUserId lookup.
- **UserDO** (per Telegram user, `idFromName(tgUserId)`) — chatId, device records, sessions snapshot, anchor message IDs, pending question contexts, hibernated WebSockets.

## 3. The wire protocol

Defined exactly once, in [`src/shared/protocol.ts`](src/shared/protocol.ts). JSON over WebSocket. Two top-level discriminated unions:

```ts
type DaemonToRelay =
  | { type: 'hello'; deviceName; os; version }
  | { type: 'session_started'; session: SessionSummary }
  | { type: 'assistant_text'; sessionId; text }
  | { type: 'tool_use'; sessionId; tool; input; toolUseId }
  | { type: 'tool_result'; sessionId; toolUseId; output }
  | { type: 'plan_update'; sessionId; todos: TodoItem[] }
  | { type: 'question'; sessionId; toolUseId; questions: QuestionItem[] }
  | { type: 'session_done'; sessionId; status; costUsd; durationMs; numTurns; errorMessage? }
  | { type: 'sessions_snapshot'; sessions; currentId? }
  | { type: 'session_forgotten'; sessionId }
  | { type: 'stats'; totalCostUsdToday; sessionsLaunchedToday; runningCount }
  | { type: 'notice'; text }              // out-of-band TG message
  | { type: 'pong'; id };

type RelayToDaemon =
  | { type: 'welcome'; tgUserId; deviceId }
  | { type: 'chat'; text; sessionId?; fromUsername? }
  | { type: 'new_session'; prompt; name?; model?; fromUsername? }
  | { type: 'resume_session'; idOrName; fork? }
  | { type: 'kill_session'; idOrName }
  | { type: 'forget_session'; idOrName }
  | { type: 'set_current'; idOrName }
  | { type: 'stop_current' }
  | { type: 'question_answer'; sessionId; toolUseId; answers: string[] }
  | { type: 'list_sessions' }
  | { type: 'get_stats' }
  | { type: 'set_verbose'; verbose }
  | { type: 'set_model'; model }
  | { type: 'ping'; id }
  | { type: 'error'; message; fatal? };
```

**Rule of thumb:** if you find yourself adding a new event, ask "could this be a `notice` plus an existing one?" first.

## 4. Daemon design

### 4.1 `SessionManager` — [`src/daemon/session-manager.ts`](src/daemon/session-manager.ts)

Owns `Map<sessionId, Session>`. Tracks:

- `currentId` — which session free-form chat routes to.
- `claudeIdIndex` — claudeSessionId → ducklingSessionId for resume-by-claude-id.
- Daily cost/launch counters for `/stats`.
- `verbose` flag (forward routine `tool_use` events), `defaultModel`.

Methods of note:

- `spawn(opts)` — new Session, becomes current.
- `routeChat(text)` — sends to current session if alive; **returns `null` otherwise** (no implicit spawn; caller must tell user to `/new`).
- `kill(idOrName)` — halt SDK, keep history (so `/resume` works).
- `forget(idOrName)` — kill **and** delete `~/.claude/projects/.../<claudeSessionId>.jsonl`. Emits `session_forgotten`.

### 4.2 `Session` — [`src/daemon/sdk-session.ts`](src/daemon/sdk-session.ts)

Wraps the SDK's `query()` for multi-turn:

```ts
const stream = new MessageStream();        // AsyncIterable<SDKUserMessage>
stream.push(prompt, '');                   // first turn
const q = query({ prompt: stream, options: ... });
for await (const m of q) handleSdkMessage(m);
// later: stream.push(nextPrompt, claudeSessionId)
```

`MessageStream` is a tiny async-iterable queue. Pushing wakes the iterator; `end()` closes it.

SDK message handling:

- `system.init` — capture `session_id`. Fires `onSessionInit` **only on the first init** (the SDK re-emits init at the start of every turn).
- `assistant` content blocks:
  - `text` → `onAssistantText`
  - `tool_use` named `TodoWrite` → `onPlanUpdate`
  - `tool_use` named `AskUserQuestion` → store raw input in `pendingQuestions`, fire `onQuestion`, set status `waiting`
  - any other tool → `onToolUse` (gated by `verbose`)
- `result.success` — keep session alive (status='running'), fire `onComplete`. Per-turn cost/duration roll up via `/stats`; we **don't** emit `session_done` here (it would noise-flood the chat).
- `result.<other>` → `onFailed`, end stream.

`AskUserQuestion` answer shape — important: the SDK expects

```ts
{ questions: [...echo of input...], answers: { [questionText]: chosenLabel } }
```

We keep the original tool_use input in `pendingQuestions` for this purpose. Sending just `{answers: [str]}` causes the model to think the user cancelled.

### 4.3 `daemon/index.ts`

Wires `SessionManager` callbacks to `RelayClient.send(...)`. The daemon never blocks on the relay — if the WS is down, events drop and reappear on next snapshot.

### 4.4 Claude binary resolution

The Agent SDK ships platform-specific subpackages (`-linux-x64`, `-linux-x64-musl`, …) and tries to pick one at runtime. On some setups it picks musl on a glibc system. We override `pathToClaudeCodeExecutable` in `Session.start()` by:

1. `DUCKLING_CLAUDE_BIN` env var if set.
2. Walking up from `require.resolve('@anthropic-ai/claude-agent-sdk')` to find the sibling `claude-agent-sdk-<platform>` package, preferring glibc when `process.report` exposes `glibcVersionRuntime`.
3. Letting the SDK auto-detect as a last resort.

## 5. Worker design

### 5.1 `worker.ts` — routes

| Route | Purpose |
|---|---|
| `GET /healthz` | health probe; lazily registers `setMyCommands` (re-pushes when the catalog hash changes) |
| `POST /pair/new` | mint a pairing token (DirectoryDO) |
| `GET /pair/status` | poll a pairing token |
| `POST /pair/bind` | admin escape hatch (gated by `ADMIN_TOKEN` secret) |
| `POST /tg-webhook` | Telegram updates land here; we parse and dispatch |
| `GET /ws?token=…` | daemon WebSocket upgrade, after `DirectoryDO` auth |

### 5.2 Telegram dispatch

`worker.ts:handleTgWebhook`:

- `/start <token>` → `handleStartCommand` → DirectoryDO bind → UserDO `welcome-paired` → send pairing success
- `/help` → `handleHelpCommand` (hard-coded text)
- `/sessions` or `/list` → UserDO `sessions-list`
- Any other `/<cmd>` → UserDO `inbox-command`
- Free-form text → UserDO `inbox-text`
- `callback_query` → UserDO `inbox-callback`

### 5.3 UserDO — [`src/worker/user-do.ts`](src/worker/user-do.ts)

The heavy file. Three responsibilities:

1. **Hold the daemon WebSocket** (hibernation-friendly via `state.acceptWebSocket()`). On message, decode and dispatch to `handleDaemonMessage`.
2. **Render SDK events to TG.** Per-session record `ses:<id>` tracks `anchorMessageId` and `planMessageId` so we edit-in-place. All messages go out `silent: true` — the chat is already where the user is looking; we don't need pushes.
3. **Route TG → daemon.** Free text becomes `chat`, slash commands route through `parseCommand`, callbacks parse `q:…` (question pick), `s:<id>:<action>` (anchor button / picker selection).

Two stateful objects in storage worth knowing:

- `qctx:<short6>` — context for a pending `AskUserQuestion` (the `questions` input + `toolUseId` + originating `sessionId`). 6-char short id keeps `callback_data` under TG's 64-byte budget.
- `pendingQ` — short id of a multi-question question that wants a text reply (`|`-separated).

### 5.4 Pickers

`showSessionPicker(action)` is the answer to "I don't want to memorise IDs." Bare `/kill`, `/switch`, `/resume`, `/fork`, `/forget` invoke this. It reads the cached `snapshot` and renders one row per session with `callback_data = s:<id>:<action>`. `/resume` and `/fork` include completed sessions; the others only live ones.

## 6. UX rules

### 6.1 Messages should be quiet

Everything goes out with `disable_notification: true`. We assume the user is already in the chat. Per-chat TG settings still handle wake-me-up-from-sleep.

### 6.2 Anchor messages are permanent

Every `/new` drops a 🚀 "anchor" with `[▶ switch] [🛑 end]` buttons. The anchor stays in chat history, so switching back to an old session is just "scroll up, tap." On state change, the anchor's body is edited (status emoji updates, buttons removed when terminated).

### 6.3 Plans edit-in-place

`TodoWrite` triggers `plan_update`. The first one creates a TG message and caches its id; subsequent ones edit that message. If the edit 400s (deleted, too old), we send a fresh one.

### 6.4 `/kill` vs `/forget`

- `/kill` halts the SDK but keeps `~/.claude/projects/.../<id>.jsonl`. The session can be `/resume`d later.
- `/forget` halts **and** rm's the jsonl. The Anchor message is also deleted (or, if older than TG's 48h limit, edited to `🗑 session forgotten`).

### 6.5 Free chat needs a live session

`routeChat` returns `null` when no current session is alive. The daemon then emits a `notice` event: "no live session — `/new <prompt>` to start one." Implicit spawning was confusing.

## 7. Code conventions

- **Strict TypeScript both sides.** No `any` outside SDK message parsing (the SDK's types include lots of cross-version variants we narrow ourselves).
- **No framework.** Daemon: `commander` + `prompts` + `ws` + `qrcode-terminal`. Worker: raw `fetch` handlers + `DurableObject`. Both lean enough to read end-to-end in an afternoon.
- **One source of truth per concern.** All TG rendering is in UserDO; all SDK handling is in `Session`; all wire types in `protocol.ts`. Don't sprinkle.
- **Silent failure for cosmetics.** If editing a plan message 400s, log warn and move on. If `setMyCommands` fails, log warn. Don't let cosmetic failures cascade.
- **No telemetry.** The relay forwards and forgets — DurableObject state never includes user content.

## 8. What the relay stores

| Key prefix | Contents |
|---|---|
| `chatId` | the user's TG chat id (== tgUserId for DMs) |
| `dev:<deviceId>` | DeviceRecord (deviceName, deviceToken, createdAt, lastSeen) |
| `ses:<sessionId>` | SessionRecord (name, deviceName, status, anchorMessageId, planMessageId, claudeSessionId) |
| `snapshot` | most recent `sessions_snapshot` from the daemon |
| `qctx:<short>` | pending AskUserQuestion context (questions echo + toolUseId) |
| `pendingQ` | short id of a multi-question text-reply session |

No code, no transcripts, no tool outputs. If you find yourself wanting to add one, ask first.

## 9. Deploy / publish

- **Worker:** `npm run worker:deploy` (after `wrangler secret put TELEGRAM_BOT_TOKEN`). Full recipe in [DEPLOY.md](DEPLOY.md).
- **npm package:** name is `duckling-cli`. `prepublishOnly` runs `clean + build`, so `npm publish` is enough. `files` field publishes only `dist/`, `README.md`, `LICENSE`.

## 10. Testing strategy

Today: manual end-to-end against the shared relay. Spawn a session, watch the events render, hit each command + button.

Wanted: unit tests around `parseCommand`, `extractQuestions`, `MessageStream`, and a fake `query()` to drive `Session` deterministically. Worker logic is harder to unit-test in isolation but `wrangler dev` against a mock TG endpoint is workable.

## 11. Non-goals

- ❌ Approval gates / auto-approve / paranoid mode. Claude Code owns trust.
- ❌ A web dashboard, a mobile app. Telegram is the UI.
- ❌ Hosting Claude. Inference uses the user's own OAuth, full stop.
- ❌ Storing user code, diffs, or conversation history on the relay.
- ❌ Multi-user *teams* (shared sessions, RBAC). This is a personal tool.

## 12. The pivots that got us here

1. **Hook-based notifier** (original spec) — wrote a daemon that listened on `~/.claude/settings.json` hooks. Worked, but you couldn't drive Claude *from* TG; only watch it.
2. **pty wrapping** — spawned `claude` inside `node-pty`, mirrored the visible viewport via `@xterm/headless`, diffed to TG. Worked, but TUI fragments leaked and we lost structured events.
3. **Agent SDK** (current) — drops pty entirely. The SDK exposes discrete events natively; we forward them. Smaller, cleaner, multi-session out of the box.

If you're tempted to bring hooks back, re-read §1 ("we're just a relay") first.

## 13. Future work

### `duckling attach` — hand a terminal claude session to the bot

Use case: the user is in an SSH terminal running `claude`, decides to step away, wants the bot to pick up that conversation from Telegram.

Sketch:
- New CLI: `duckling attach [<claudeSessionId>] [--pick]`. Default behaviour finds the most-recently-modified `~/.claude/projects/<encoded-cwd>/*.jsonl` for the current `cwd`.
- Add a local IPC channel (the `DEFAULT_SOCKET_PATH = ~/.duckling.sock` slot in [`shared/paths.ts`](src/shared/paths.ts) already exists but is unused). Daemon listens on a Unix socket; CLI sends `{type:'attach', claudeSessionId, name?}`.
- Daemon calls `manager.spawn({ resume: claudeSessionId, … })`. `Session.start()` needs to forward `resume` to the SDK's `query({ options: { resume } })`.
- Naming: `attached-<short-claude-id>` so it's obvious in `/sessions`.
- Safety: refuse to attach if a process is currently writing the jsonl (use `lsof` or a stale-mtime heuristic) — concurrent writers corrupt the transcript.

Don't promote it as a "session takeover" feature — semantically it's "fork from this transcript into a new SDK process". The original SSH `claude` keeps its own state.
