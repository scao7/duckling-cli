# duckling

> **Drive Claude Code from Telegram.** Spawn Claude sessions, watch plans evolve, answer questions with one tap — all from your phone.

[![npm version](https://img.shields.io/npm/v/duckling-cli.svg)](https://www.npmjs.com/package/duckling-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/duckling-cli)](https://www.npmjs.com/package/duckling-cli)

**English** · [中文](README.zh.md)

---

duckling is a tiny daemon that runs the official [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) on your machine and bridges it to Telegram. You send a prompt from your phone → Claude works on your computer → results, plans, and questions stream back into the chat with tap-to-answer buttons.

There's nothing to host. We run one shared bot ([@DucklingCli_Bot](https://t.me/DucklingCli_Bot)) and one Cloudflare Worker relay. You install one npm package, scan a QR code, you're done.

## Why?

Claude Code is great when you're at your desk. The problem starts when you're not:

- 🚇 On the train, watching a long task tick through a TODO list.
- 🛏️ In bed, and Claude paused on `AskUserQuestion` waiting for a one-tap answer.
- 🏃 Out for a run, and you want to kick off a refactor before you forget.

duckling solves exactly this. **It does not replace your terminal.** SSH is still better for typing code. duckling is for ambient access — "is it done yet", "approve this", "kill the bad branch."

## Quick start

There are two ways to use duckling. **Pick one.**

### Path A — Use the shared bot 🦆 (recommended)

You pair with our hosted bot ([@DucklingCli_Bot](https://t.me/DucklingCli_Bot)) and our Cloudflare Worker. **Zero infra setup on your side.**

```bash
npm i -g duckling-cli && duckling setup && duckling start
```

What happens:
1. `npm i -g duckling-cli` installs the CLI globally.
2. `duckling setup` prints a QR + a `https://t.me/DucklingCli_Bot?start=…` link. Scan/click → tap **Start** in Telegram → paired. Config writes to `~/.config/duckling/config.json`.
3. `duckling start` brings up the daemon, which connects to our shared relay.

You did **not** need a Cloudflare account, a Telegram bot, or any deploy step. Inference still runs on your own Claude OAuth locally — the relay only forwards control events, not model traffic.

### Path B — Run your own bot + Worker

If you'd rather not depend on the shared relay (private team bot, paranoid about an intermediary, etc.), you self-host. The CLI is identical; only the maintainer (you) does an extra one-time Cloudflare deploy.

**Maintainer, once:**

```bash
git clone https://github.com/scao7/duckling-cli.git
cd duckling-cli
npm install
# Follow DEPLOY.md — 5 wrangler commands:
#   wrangler login
#   wrangler secret put TELEGRAM_BOT_TOKEN     # from BotFather
#   wrangler secret put TG_WEBHOOK_SECRET      # random string
#   wrangler deploy                            # prints your relay URL
#   curl … setWebhook                          # point Telegram at the worker
```

**Each user (anyone pointed at your fork), once:**

```bash
npm i -g duckling-cli
export DUCKLING_RELAY_URL=https://your-relay.your-subdomain.workers.dev
duckling setup
duckling start
```

`DUCKLING_RELAY_URL` redirects pairing + the daemon's WebSocket to your Worker instead of ours. After pairing, the URL is baked into `~/.config/duckling/config.json` — no need to keep exporting it.

Full recipe + cost calculator (spoiler: **$0** on Cloudflare's free tier for small teams) in **[DEPLOY.md](DEPLOY.md)**.

### Both paths require

- **Node 18.17+**
- **A working `claude` install, logged in.** The Agent SDK uses your existing Claude OAuth — no separate API key, no extra cost. If `claude --version` works on your machine, you're set.

### After setup — talk to the bot

Then chat with [@DucklingCli_Bot](https://t.me/DucklingCli_Bot) (Path A) or your own bot (Path B) on Telegram:

```
You:   /new write a quicksort in src/quicksort.ts
Bot:   🚀 quicksort on macbook · ⚪ starting   [▶ switch to this] [🛑 end]
Bot:   📋 quicksort
       ⬜ Write quicksort.ts
       ⬜ Add a unit test
       ⬜ Run the test
Bot:   quicksort · macbook
       I've written the function. Running the test now…
You:   /sessions
Bot:   Sessions:
       🟢 quicksort · mOw0F3xO ◀
       …
```

## What you can do

### Commands

| Command | What it does |
|---|---|
| `/new <prompt>` | Open a new Claude session |
| `/sessions` | List active and recent sessions |
| `/switch <id\|name>` | Send future free-text chat to this session |
| `/resume <id\|name>` | Continue an old session that ended |
| `/fork <id\|name>` | Branch off from a session into a new line |
| `/kill <id\|name>` | Stop a session (history kept, can `/resume`) |
| `/forget <id\|name>` | Stop **and wipe** — deletes Claude's transcript on disk |
| `/stop` | Interrupt the current generation only |
| `/stats` | Today's session count + spend |
| `/model sonnet\|opus\|haiku` | Default model for new sessions |
| `/verbose on\|off` | Forward routine tool_use events |
| `/help` | Quick command list |

Running a session-targeting command without arguments (e.g. just `/kill`) pops a tappable picker — **no IDs to memorise**.

### From the chat itself

- **Anchor messages** — every session drops a 🚀 message with `[▶ switch] [🛑 end]` buttons. Scroll up, tap to switch.
- **One-tap questions** — when Claude calls `AskUserQuestion`, options become inline buttons. No typing required.
- **Edit-in-place plans** — `TodoWrite` plans render as a single message that updates as items complete.
- **Free-form chat** — anything you type without a leading `/` continues the current session.

## How it works

```
   Your phone                Cloudflare Worker             Your computer
 ┌──────────────┐            ┌───────────────┐           ┌──────────────────┐
 │ Telegram     │◀── Bot ───▶│ duckling-relay│◀── WS ───▶│ duckling daemon  │
 │  @Duckling…  │            │  + DOs        │           │  └ Agent SDK     │
 │              │            │               │           │     └ session 1  │
 │              │            │               │           │     └ session 2  │
 └──────────────┘            └───────────────┘           └──────────────────┘
                                                                  │ OAuth
                                                                  ▼
                                                          ┌──────────────────┐
                                                          │ Claude (your sub)│
                                                          └──────────────────┘
```

- The **daemon** runs the SDK in-process. One `Session` per `/new`. Each Session has its own input stream — turns come from you (TG), responses stream out as discrete events.
- The **relay** is a Cloudflare Worker that fans out per-user Durable Objects. It owns the Telegram webhook, holds your hibernated WebSocket, and renders SDK events into TG messages.
- Anthropic SDK calls **never** touch the relay. Inference goes from your machine straight to Claude using your own OAuth subscription. The relay is a control-plane only.

## Privacy & security

- **Your code never leaves your machine** unless Claude itself decides to read or write it, in which case the file path / preview travels through the relay as part of a tool_use event. Tool *outputs* (e.g. test results, file contents) don't.
- **The relay forwards and forgets.** Durable Object state is limited to pairing tokens, device records, the latest sessions snapshot, and short-lived question contexts. No code, no transcripts.
- **Self-host if you don't trust the shared relay.** The Worker is the whole stack — `npx wrangler deploy` and you own the data plane. See [DEPLOY.md](DEPLOY.md).
- **Auth on the daemon side is a deviceToken**, opaque to you, revocable from the relay. It's the only secret on your machine.

## Self-hosting

The default points at the shared relay we operate. If you'd rather run your own:

```bash
# One-time, as the maintainer of your own bot
git clone https://github.com/scao7/duckling-cli.git
cd duckling-cli
npm install
# follow DEPLOY.md — five commands: wrangler login + secret put + deploy + setWebhook
```

Users of your fork override the default with:

```bash
export DUCKLING_RELAY_URL=https://your-relay.workers.dev
duckling setup
```

Full recipe + cost calculator (spoiler: **$0** on Cloudflare's free tier for small teams) in **[DEPLOY.md](DEPLOY.md)**.

## Architecture

| Layer | What | Code |
|---|---|---|
| CLI | `duckling setup\|start\|stop\|status` | [`src/cli/`](src/cli) |
| Daemon | SDK runner, session manager, WS client | [`src/daemon/`](src/daemon) |
| Worker | TG webhook, pairing, fan-out to UserDO | [`src/worker/`](src/worker) |
| Shared | Wire protocol (`DaemonToRelay` / `RelayToDaemon`) | [`src/shared/protocol.ts`](src/shared/protocol.ts) |

The codebase is small (~1500 LoC of TS) and self-contained — no framework on either side, just `ws` + `commander` + Cloudflare Durable Objects.

See **[CLAUDE.md](CLAUDE.md)** for the design doc: architecture decisions, wire protocol, and why duckling is "just a relay" — no approval gates, no second permission system.

## Development

```bash
git clone https://github.com/scao7/duckling-cli.git
cd duckling-cli
npm install
npm run build        # tsc + worker typecheck

# CLI:
node dist/cli/index.js setup
node dist/cli/index.js start

# Worker (local dev, no TG webhook — useful for /pair/* and /healthz):
npm run worker:dev

# Deploy after changes:
npm run worker:deploy
```

## Roadmap

Things on the table, not yet shipped:

- **Multi-user on a single machine** — currently one daemon per Linux user (separate `~/.config/duckling/`).
- **Reply-to-route** — let TG message-replies target a specific session without `/switch`.
- **Auto-archive** — old sessions linger forever; add a TTL.
- **Diff rendering** — `Edit`/`Write` previews as code blocks (short) or images (long).

PRs welcome. Open an issue first if it's bigger than a quick fix.

## Contributing

When sending a PR:
- Run `npm run build` (must pass — strict TypeScript on both sides).
- If the change touches the wire protocol, update **both** [`src/shared/protocol.ts`](src/shared/protocol.ts) and any handlers in `src/daemon/` and `src/worker/`.

## License

[MIT](LICENSE) — fork freely. The shared bot/relay is a convenience, not a moat.

## Acknowledgements

Built on top of [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript). Inspired by the pattern in [openclaw-claude-code-plugin](https://github.com/openclaw/openclaw-claude-code-plugin) of using the SDK's streaming-input mode for multi-turn.
