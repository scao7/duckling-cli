# duckling

> A lightweight notifier and approval tool for Claude Code. Get pinged on Telegram when Claude needs you. Approve, deny, or check progress from your phone. **For anything richer, SSH into your machine. We don't compete with SSH; we complement it.**

## 0. What this tool is (and isn't)

**Is:**
- A bridge between Claude Code's hook system and Telegram
- A way to know "what's Claude doing right now" and "did it finish" from your phone
- A remote approve/deny mechanism for Claude Code's tool calls
- A relay for Claude's questions (`AskUserQuestion`) so you can answer them from your phone

**Isn't:**
- A chat client. Claude's conversation stays on your machine. If you want to talk to Claude, SSH in.
- A mobile IDE. No code editing, no diff fixing, no "ask Claude to redo it differently" from the phone (well, except via approve/deny + AskUserQuestion).
- A remote launcher. Sessions are started on your machine with `claude`. We attach to them; we don't spawn them.

This minimalism is the whole point. Resist scope creep.

## 1. User experience target

```bash
$ npm install -g duckling
$ duckling setup

🔗 Open this on your phone:
   https://t.me/DucklingBot?start=abc123xyz

⏳ Waiting for confirmation...
✅ Linked to @yourname
✅ Hooks installed in ~/.claude/settings.json
✅ Daemon started (device: macbook-pro)
```

Then the user opens Claude Code as usual. From their phone they see:

- A **plan message** that updates as Claude ticks off TODOs
- An **approval prompt** when Claude wants to run a tool, with `[✅] [❌]` buttons
- A **question prompt** when Claude calls `AskUserQuestion`, with options or free-text reply
- A **completion summary** when the session ends, showing which TODOs got done

That's it. Five message types. No streaming, no chat, no commands beyond a handful.

## 2. Architecture

```
┌──────────────────────┐    ┌──────────────────────┐
│ Computer A           │    │ Computer B           │
│  Claude Code CLI     │    │  Claude Code CLI     │
│   ↓ hook             │    │   ↓ hook             │
│  duckling daemon ───┼─ws─┤                      │
└──────────────────────┘    └──────────┬───────────┘
                                       │
                                       ↓ ws
                            ┌──────────────────────┐
                            │ Cloudflare Worker    │
                            │ + Durable Objects    │
                            │ (the relay)          │
                            └──────────┬───────────┘
                                       │ Bot API
                                       ↓
                            ┌──────────────────────┐
                            │ Telegram (one shared │
                            │ bot for all users)   │
                            └──────────────────────┘
```

**Key design decisions:**

- **One shared Telegram bot** owned by the project. Users never touch BotFather.
- **Cloudflare Worker relay** with Durable Objects per user. Free tier handles ~1000 users at our message volumes.
- **Hybrid session UX (Forum/DM)**: see section 6.
- **Hooks-based integration** with Claude Code. No patching, no fork.
- **No streaming**. No conversation forwarding. No remote shell. By design.

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Daemon | Node.js + TypeScript | Matches Claude Code ecosystem, easy npm distribution |
| CLI | `commander` + `prompts` + `qrcode-terminal` | Standard, small, ergonomic |
| Relay | Cloudflare Workers + Durable Objects | Free tier covers our scale; native WebSocket hibernation |
| IPC (hook ↔ daemon) | Unix domain socket (Windows: named pipe) | Fast, no port conflicts |
| Storage | None on user side; DO state on relay | Stateless daemon = trivial restarts |
| Wire format | JSON over WebSocket | Debug-friendly |

**Do not** add: a database, Redis, a queue, a frontend framework, an ORM. None are needed.

## 4. Repository layout

```
duckling/
├── package.json                # bin: duckling
├── tsconfig.json
├── README.md
├── CLAUDE.md                   # this file
├── LICENSE                     # MIT
│
├── src/
│   ├── cli/
│   │   ├── index.ts            # entry: duckling <subcommand>
│   │   ├── setup.ts            # interactive pairing flow
│   │   ├── start.ts            # start daemon
│   │   ├── stop.ts             # stop daemon
│   │   ├── status.ts           # show connection + sessions
│   │   └── hook.ts             # invoked by Claude Code hooks
│   │
│   ├── daemon/
│   │   ├── index.ts            # daemon main
│   │   ├── ipc-server.ts       # listens on unix socket
│   │   ├── relay-client.ts     # WebSocket to Cloudflare Worker
│   │   ├── session-manager.ts  # tracks active Claude Code sessions
│   │   ├── auto-approve.ts     # local trust rules (see §7)
│   │   └── hooks-installer.ts  # writes ~/.claude/settings.json
│   │
│   ├── shared/
│   │   ├── protocol.ts         # message types
│   │   ├── config.ts           # ~/.config/duckling/config.json I/O
│   │   └── logger.ts
│   │
│   └── relay/                  # Cloudflare Worker
│       ├── worker.ts           # entry, routes /tg-webhook and /ws
│       ├── user-do.ts          # Durable Object per user
│       ├── session-anchor.ts   # SessionAnchor abstraction (see §6)
│       ├── tg-client.ts        # Telegram Bot API wrapper
│       └── wrangler.toml
│
└── test/
    ├── fixtures/
    └── e2e.spec.ts
```

## 5. Build order (do these in order, do not skip ahead)

### Phase 1: Single user, single device, one approval flow

**Goal:** prove the loop works end-to-end with one device sending one approval to Telegram.

1. **Hardcoded relay first.** Skip Cloudflare Worker for now. Spin up a tiny Node.js relay locally on `localhost:8787` that just forwards between WebSocket and the Telegram Bot API.
2. **Daemon:** connects to the local relay, listens on `~/.duckling.sock`.
3. **Hook handler:** `duckling hook pretool` reads stdin (JSON describing the tool call), forwards to daemon over the socket, blocks waiting for response.
4. **Telegram side:** daemon forwards approval request as a TG message with `inline_keyboard` `[✅ Approve] [❌ Deny]`. User taps a button, callback comes back, daemon writes exit code (0 = approve, 2 = deny).
5. **Setup CLI:** asks for a TG bot token and chat ID directly (no QR yet). Writes config to `~/.config/duckling/config.json`. Edits `~/.claude/settings.json` to add hook entries.

**Done when:** running `claude` on your laptop, asking it to run a `Bash` command, and seeing a Telegram message you can tap "Approve" on, after which Claude Code proceeds.

### Phase 2: Multi-session UX + TODO sync + AskUserQuestion

This is the product-defining phase. Three additions:

**2A. Multi-session UX (section 6)**
- Implement `SessionAnchor` interface with both `ForumAnchor` and `DmAnchor`.
- User picks mode at setup (default: DM, with one-shot upgrade nudge at 3 sessions).
- Each session has a state emoji (🟢/🟡/🔴/⚪) prefixed in topic title or anchor message.

**2B. TODO sync (section 8)**
- Hook `PostToolUse` matcher `TodoWrite`. Forward the `todos` array to relay.
- Relay maintains `planMessageId` per session. First TODO update sends a new "Plan" message; subsequent updates **edit** that same message.
- On `Stop`, the final state of the plan IS the summary. No need for a separate summary generator.

**2C. AskUserQuestion reverse channel**
- Hook `Notification` event (or detect `AskUserQuestion` tool via `PreToolUse`).
- Block the hook, send a TG message with the question and answer options as inline keyboard.
- User taps an option (or types a free-text reply); daemon writes the answer back to hook stdout.

**Done when:**
- Three concurrent sessions on two devices show three distinct presences in TG (topics or threads).
- A session that calls `TodoWrite` shows a single "Plan" message that updates in place.
- Claude calling `AskUserQuestion` produces a TG message you can answer from the phone, and Claude resumes with that answer.

### Phase 3: Cloudflare Worker relay

**Goal:** replace local relay with deployed Worker so this works across networks and devices.

1. `relay/worker.ts` routes:
   - `POST /tg-webhook` — Telegram webhook
   - `GET /ws?token=...` — daemon WebSocket connection
   - `GET /pair?token=...` — Telegram deep link landing
2. `relay/user-do.ts` — Durable Object per user, keyed by Telegram user ID. State: `{ tgUserId, mode, forumGroupId?, devices, sessions, pendingApprovals, autoApproveRules }`.
3. **WebSocket hibernation** via `state.acceptWebSocket()`.
4. Webhook URL registered with `setWebhook` once at deploy time.

**Done when:** Worker is deployed, daemon connects to `wss://...workers.dev/ws`, existing flows still work.

### Phase 4: Real pairing flow + multi-device

**Goal:** user runs `duckling setup`, gets a QR/link, taps it in Telegram, paired in <60s with no Telegram developer knowledge.

1. **Pairing tokens:** CLI calls `POST /pair/new`, gets `{ token, deepLink }`.
2. **CLI displays:** clickable URL + QR code via `qrcode-terminal`.
3. **User taps link:** Telegram opens the bot, sends `/start <token>`. Worker matches, binds `tgUserId` to a user record DO.
4. **CLI polls** `GET /pair/status?token=...`. On success, gets `{ tgUserId, deviceToken }` and saves locally.
5. **First-time mode selection:** bot DMs the Forum-vs-DM choice (section 6.2). Subsequent devices for the same user attach to existing mode.
6. **Daemon connects** with `deviceToken` (signed JWT including `tgUserId` and device ID).
7. **Second device:** new pairing token, same TG user → recognized, no duplicate group/topic.

**Done when:** fresh user goes from `npm install` to working remote approval in under 60 seconds.

### Phase 5: Auto-approve & night mode (section 7)

**Goal:** let users skip routine approvals, especially while sleeping.

1. **Per-tool trust rules:** "Always allow `npm test`" button on approval messages persists a rule. Future matching calls auto-approve silently.
2. **Project-scoped rules:** "Always in this project" persists more broadly.
3. **Night mode** (`/night on` in TG, or auto-schedule): all non-high-risk tools auto-approve. High-risk operations still ping you (loudly).
4. **Risk classification:** see §7.
5. **Audit log:** every auto-approval is logged locally and posted to TG as a low-priority muted message ("✓ auto: npm test"). User can review what got auto-approved.

**Done when:** user can leave Claude running overnight on a routine task and wake up to a completed plan, with a clear log of every auto-approved step.

### Phase 6: Polish

- `/sessions` command for global summary across devices.
- `/kill <session>` to interrupt a session from TG.
- Diff rendering: short diffs in code blocks, long diffs as images.
- Reconnection: daemon auto-reconnects with exponential backoff. Worker buffers messages while a device is offline (TTL: 1 hour).
- Auto-archive: ended sessions archive after 30 days.

## 6. Multi-session UX spec

### 6.1 Two modes

| | Forum mode | DM mode |
|---|---|---|
| Container | Private supergroup with Topics enabled | 1:1 chat with the bot |
| Session unit | One Topic per session | One reply-thread per session |
| Setup cost | ~30s (create group, add bot, enable Topics) | 0s |
| Best for | 2+ concurrent sessions | 1–2 sessions |
| Glanceability | ★★★ | ★★ |

Both modes ship in Phase 2. Default: **DM**. Bot nudges to upgrade at 3 concurrent sessions, once and only once.

### 6.2 Mode selection at setup

After pairing, if user has no mode yet, bot DMs:

```
✅ You're paired! One quick choice:

How should I show your Claude Code sessions?

🗂  Forum group (recommended for 2+ sessions)
    Each session gets its own thread. Best for multi-project use.
    Setup: ~30 seconds.

💬  Single chat (zero setup)  ← default
    All sessions in this chat, threaded by reply.
    Best for quick start.

You can switch later with /mode.
```

Buttons: `[🗂 Forum]` `[💬 Single chat]` `[🤔 Decide later]`.

- 🗂 Forum → walkthrough (6.3)
- 💬 / 🤔 → mode = `dm`. The "Decide later" path shows the upgrade nudge later.

### 6.3 Forum-mode walkthrough

Step-by-step, each waits for verifiable action:

```
Step 1/4: Create a private group called "Duckling"
  → New Group → name it → add @DucklingBot
  [I've done this →]
```

Bot detects via `my_chat_member` updates.

```
Step 2/4: Make me an admin
  Permissions: "Manage Topics" + "Pin Messages"
  [I've done this →]
```

```
Step 3/4: Enable Topics
  Group settings → toggle "Topics" on
  [I've done this →]
```

```
Step 4/4: Send /init in the General topic
  ⏳ Waiting...
```

Bot verifies admin + Topics, replies with success. Failures show a clear "what went wrong + how to fix" message.

### 6.4 The `SessionAnchor` abstraction

The rest of the codebase **never** branches on mode. Everything goes through:

```typescript
// src/relay/session-anchor.ts

interface SessionAnchor {
  open(meta: { device: string; project: string; cwd: string }): Promise<void>;
  send(text: string, opts?: { keyboard?: InlineKeyboard; silent?: boolean }): Promise<MessageId>;
  edit(messageId: MessageId, text: string, opts?: { keyboard?: InlineKeyboard }): Promise<void>;
  setState(state: 'active' | 'idle' | 'waiting' | 'ended'): Promise<void>;
  close(reason: 'completed' | 'killed' | 'crashed'): Promise<void>;
}

class ForumAnchor implements SessionAnchor { /* uses topics */ }
class DmAnchor implements SessionAnchor    { /* uses reply threading */ }
```

If you find yourself writing `if (mode === ...)` outside this file, refactor.

### 6.5 Visual conventions

**Session naming:** `device/project` where:
- `device` = user-set device name
- `project` = `path.basename(cwd)`
- Disambiguate collisions with a 4-char hash: `macbook/api-a3f9`

**State emojis:**
- 🟢 active — Claude is working
- 🟡 idle — no activity in 5 min
- 🔴 waiting — pending approval/question
- ⚪ ended — session closed

In Forum mode, prefix is in the topic name. In DM mode, prefix is in the anchor message. Either way, it updates in place via `setState`.

**Notification levels:**
- `silent: true` (no sound): TODO updates, status changes, auto-approve audit log.
- `silent: false` (default sound): approval requests, AskUserQuestion.
- `silent: false` + leading `🚨`: high-risk operations (see §7.2).

**Approval message template:**

    🔧 macbook/myapp wants to run:

    ```bash
    npm test
    ```

    📂 ~/projects/myapp · 🕐 just now

    [✅ Approve] [❌ Deny] [📋 Always allow `npm test`]

For `Edit`/`Write`, show unified diff in a code fence. >30 lines → image.

### 6.6 The `/sessions` command

Returns global cross-device summary:

```
Your sessions:

🟢 macbook / myapp     · active 2s ago
🔴 macbook / blog      · waiting (1 approval pending)  ← tap
🟡 server / api        · idle 23m
⚪ macbook / scripts   · ended 5m ago

[Refresh] [Clean up ended]
```

Tapping a session jumps to its topic or anchor message.

### 6.7 The "third session" upgrade nudge

DM mode only, fires once when user opens a 3rd concurrent session:

```
👋 You've got 3 sessions running here — it might get busy.

Switch to a Forum group? Each session gets its own thread,
unread badges show what needs attention, your DM stays clean.

[🗂 Switch to Forum] [📌 No thanks, don't ask again]
```

Respect "don't ask again" forever.

## 7. Auto-approve & night mode

This is what lets users sleep through long-running tasks. Done wrong, it's a security disaster. Done right, it's the killer feature.

### 7.1 Trust rules (per-user, stored in DO)

Three scopes, in order of specificity:

| Scope | Example | UI to set |
|---|---|---|
| Exact command | `npm test` | "Always allow `npm test`" button on approval |
| Tool + project | All `Bash` in `~/projects/myapp` | `/trust` command in TG |
| Tool globally | All `Read` everywhere | `/trust` command (use sparingly) |

Rules are **per-user**, stored in their Durable Object. Synced to all devices.

When a `PreToolUse` hook fires:
1. Daemon asks relay "is this auto-approvable for this user?"
2. Relay checks rules in order: exact → project → global
3. If matched, daemon returns approve immediately, sends a **silent audit message** to TG: `✓ auto: npm test [revoke]`
4. User can tap [revoke] to remove the rule

### 7.2 Risk classification

These are **never** auto-approved, even with explicit rules. They always alert the user with `🚨` prefix and loud notification:

- `Bash` containing: `rm -rf`, `sudo`, `curl ... | sh`, `wget ... | sh`, `mkfs`, `dd`, `chmod -R`, force-push (`git push -f` or `--force`)
- `Bash` involving credentials/secrets: anything touching `~/.ssh/`, `~/.aws/`, `~/.config/gcloud/`
- `Write` or `Edit` to: `~/.ssh/*`, `~/.aws/*`, `/etc/*`, `~/.bashrc`, `~/.zshrc`, anything starting with `.env`
- Any tool when the user is in **paranoid mode** (`/paranoid on`) — disables ALL auto-approve

The classification list is hardcoded in the daemon. Users can extend (add more risky patterns) but cannot weaken (remove built-in protections).

### 7.3 Night mode

Two ways to enter:

**Manual:** `/night on` and `/night off` in TG.

**Scheduled:** `/night schedule 23:00-07:00` — auto-toggles based on user's timezone.

In night mode:
- All non-high-risk tools auto-approve silently.
- High-risk operations still ping with full alert (loudest sound, persistent notification on iOS/Android).
- A summary message every 30 minutes: `🌙 night mode: 12 auto-approved, 0 pending`.
- On exit: full report of what happened.

### 7.4 Audit log

Every auto-approval logged locally to `~/.config/duckling/audit.log` and posted to TG as a silent message. Format:

```
✓ 03:42 macbook/myapp · Bash `npm test` (rule: exact-command)
✓ 03:43 macbook/myapp · Edit src/api.ts (rule: project-tool)
🚨 03:51 macbook/myapp · Bash `rm -rf node_modules` — REQUIRES APPROVAL
```

Critical: even auto-approved actions are visible. The user can scroll back and see exactly what happened.

### 7.5 Default state

**All auto-approve is OFF by default.** The user has to opt in explicitly. We never assume trust.

## 8. Hook configuration

CLI writes to `~/.claude/settings.json` during setup. **Merge with existing hooks rather than overwrite.**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|Bash|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "duckling hook pretool" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "TodoWrite",
        "hooks": [
          { "type": "command", "command": "duckling hook todo" }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          { "type": "command", "command": "duckling hook notification" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "duckling hook stop" }
        ]
      }
    ]
  }
}
```

**Hook semantics:**

- `PreToolUse` → blocks until user (or auto-approve rule) responds. Exit `0` = approve, `2` = block.
- `PostToolUse` matcher `TodoWrite` → reads `tool_input.todos` from stdin, forwards to daemon (non-blocking).
- `Notification` → blocks if it's an `AskUserQuestion`-style prompt; non-blocking otherwise.
- `Stop` → sends final session state (last TODO list snapshot) to TG, then daemon marks session ended. Non-blocking.

Stdin format follows Claude Code's hook spec — see https://docs.claude.com/en/docs/claude-code/hooks.

## 9. Wire protocol (daemon ↔ relay)

JSON over WebSocket. Every message has `type` and `id`.

```typescript
// Daemon → Relay
type DaemonToRelay =
  | { type: 'hello'; id: string; deviceToken: string; deviceName: string; os: string }
  | { type: 'session_start'; id: string; sessionId: string; cwd: string; project: string }
  | { type: 'session_end'; id: string; sessionId: string; reason: string }
  | { type: 'session_state'; id: string; sessionId: string; state: 'active'|'idle'|'waiting' }
  | { type: 'approval_request'; id: string; sessionId: string; tool: string; input: any; preview: string; risk: 'normal'|'high' }
  | { type: 'todo_update'; id: string; sessionId: string; todos: TodoItem[] }
  | { type: 'question'; id: string; sessionId: string; prompt: string; options?: string[] }
  | { type: 'auto_approved'; id: string; sessionId: string; tool: string; rule: string }
  | { type: 'pong'; id: string };

// Relay → Daemon
type RelayToDaemon =
  | { type: 'welcome'; id: string; userId: string; mode: 'forum'|'dm'; autoApproveRules: Rule[] }
  | { type: 'approval_response'; id: string; requestId: string; decision: 'approve'|'deny'|'always'; note?: string }
  | { type: 'question_response'; id: string; questionId: string; answer: string }
  | { type: 'rules_updated'; id: string; autoApproveRules: Rule[] }
  | { type: 'mode_changed'; id: string; mode: 'forum'|'dm' }
  | { type: 'kill_session'; id: string; sessionId: string }
  | { type: 'ping'; id: string };

interface TodoItem { content: string; status: 'pending'|'in_progress'|'completed' }
interface Rule { scope: 'exact'|'project'|'global'; tool: string; pattern?: string; project?: string }
```

Keep this stable across versions; it's the contract.

## 10. Configuration files

`~/.config/duckling/config.json`:

```json
{
  "deviceToken": "eyJhbGc...",
  "deviceName": "macbook-pro",
  "relayUrl": "wss://duckling-relay.your-domain.workers.dev/ws",
  "socketPath": "/Users/you/.duckling.sock",
  "version": 1
}
```

The `deviceToken` is the only secret on the user's machine. Revocable via `/devices` in TG.

## 11. Coding conventions

- **Strict TypeScript** (`"strict": true`). No `any` outside protocol parsing.
- **Minimal deps**: `ws`, `commander`, `prompts`, `qrcode-terminal`. That's it on daemon side.
- **No frameworks** in the Worker either — raw `fetch` handler, `DurableObject`, that's it.
- **Logs** to `~/.config/duckling/daemon.log`. Stdout reserved for CLI output.
- **Tagged errors**: `{ code: 'RELAY_DISCONNECTED', cause: ... }`.
- **No telemetry.** Open-source projects earn trust by not phoning home.
- **Mode-agnostic core:** only `session-anchor.ts` knows about Forum vs DM.

## 12. Testing strategy

- **Unit**: protocol round-trip, hook stdin parsing, settings.json merge, auto-approve rule matching, risk classifier, `SessionAnchor` implementations (with mocked TG client).
- **Integration**: mock relay (Node `ws` server), real daemon, simulated hook calls.
- **E2E manual**: real bot, deployed Worker, real `claude` invocation. Test both Forum and DM modes, plus auto-approve and night mode. Document in `test/manual-e2e.md`.

## 13. Open questions

- **Bot rate limits:** TG limits 30 msg/sec to a single chat. Per-chat throttling in the Worker, batch where possible.
- **Webhook vs long polling:** webhook for the Worker. Register once at deploy.
- **iOS notifications:** TG handles them well. Document recommended notification settings for the bot's chat.
- **China access:** Telegram + Cloudflare both need a working network. Document it; future Feishu adapter is community fork territory.
- **Forum bot permissions:** confirm `Manage Topics` + `Pin Messages` is sufficient. If `Pin` causes friction, drop pinning UX and require only `Manage Topics`.

## 14. Non-goals (do not build these)

- ❌ A mobile app. Telegram is the mobile app.
- ❌ A web dashboard. Telegram is the dashboard.
- ❌ Forwarding Claude's full conversation. **Use SSH for that.**
- ❌ Two-way conversation in Telegram (free-form chat with Claude). **Use SSH for that.**
- ❌ Starting new sessions remotely. **Use SSH for that.**
- ❌ Streaming output (token-level updates). Bandwidth, cost, battery, distraction — all bad.
- ❌ Hosting Claude Code itself or any model calls. We are a notification/control plane only. The user's Claude Code subscription/API key never touches our relay.
- ❌ Storing user code, diffs, or conversation history beyond what's in flight. The relay forwards and forgets.
- ❌ Multi-user team features (shared sessions, RBAC). This is a personal tool.
- ❌ Other IM platforms in v1. Architect cleanly so adapters can be added later, but ship Telegram first.

## 15. First-PR acceptance criteria

A reviewer should be able to:

1. `git clone` the repo
2. `npm install && npm run build`
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (Phase 1 manual mode)
4. `npm link && duckling setup`
5. Run `claude` in another terminal, ask it to "run `ls -la`"
6. See a Telegram message with an Approve button
7. Tap Approve
8. See `claude` proceed and output the result

If those steps work end-to-end on macOS and Linux, Phase 1 is merged. Phases 2–5 are follow-up PRs.

## 16. Privacy & security

This section is verbatim what the README should tell users.

**What we can see (the relay operator):**
- The fact that you have Claude Code sessions running, on which device names, in which directory names (basenames only).
- Tool call previews (the command being run, the diff being applied) — these flow through the relay as part of approval requests.
- Your TG user ID and the messages you send/receive in the bot chat.

**What we cannot see:**
- Your full source code. We only see what's in approval previews.
- Tool outputs (npm install logs, test results, etc.). These stay on your machine.
- Claude's conversation with you. Conversation transcript never leaves your machine.
- Anything from sessions where you don't trigger an approval/question/TODO event.

**What we never store:**
- Anything beyond ephemeral routing state. The relay forwards messages and forgets. Durable Object state is limited to: pairing tokens, user mode, auto-approve rules, current session metadata. No content.

**Self-hosting:**
- The Worker is open source. If you don't trust the shared relay, deploy your own with `wrangler deploy`. Same code, your domain, your control. Setup is one command + your own bot token.

## 17. License

MIT. Encourage forks. The shared bot/relay is a convenience, not a moat. Building something better on top of this code is the goal.

---

**Start with Phase 1. Do not architect Phases 3+ prematurely.** Get one button click on a phone to release one Claude Code hook, then iterate.

**Phase 2 is the product.** TODO sync + multi-session + AskUserQuestion. That's the MVP. Everything else is polish.
