# duckling

> A lightweight notifier and approval tool for Claude Code. Get pinged on Telegram when Claude needs you. Approve, deny, or check progress from your phone. **For anything richer, SSH into your machine. We don't compete with SSH; we complement it.**

## Status

Phase 4 (local-relay variant): the daemon no longer holds a Telegram bot token — a separate relay process does. Devices pair against the relay via QR/deep link, the way the eventually-deployed Cloudflare Worker will work. See [CLAUDE.md](./CLAUDE.md) for the full design.

## Architecture

```
Claude Code hook ─► duckling daemon ─ws─► duckling relay ─► Telegram
                    (per device)         (one per bot,
                                          holds bot token)
```

The relay is what holds the bot token. The daemon is what every device runs.

## Quick start (single machine, both roles)

You'll need a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone <this repo>
cd duckling
npm install
npm run build
npm link

# One-time, on the box that will run the relay:
duckling relay setup     # asks for bot token, starts the relay
                         # leaves the relay running in the background

# Once per device that wants approvals:
duckling setup           # shows a QR + deep link, waits for you to tap it
```

`duckling setup` will:
1. Talk to the relay at `http://localhost:8787` (or `$DUCKLING_RELAY_URL`).
2. Show a `https://t.me/<bot>?start=<token>` link and the matching QR code.
3. Wait for you to tap it in Telegram. Once you do, your device gets a `deviceToken` and the user daemon starts.

Then in another terminal:

```bash
claude
> Run `ls -la` for me
```

You should get a Telegram message with `[✅ Approve] [❌ Deny]` buttons. Tap Approve and Claude proceeds.

## Lifecycle

```bash
duckling status                # per-device status
duckling stop / start          # the user daemon (per device)

duckling relay status          # the relay
duckling relay stop / start    # the relay
duckling relay logs            # path to the relay log
```

## Files

| Path | What |
|---|---|
| `~/.config/duckling/config.json` | per-device config: deviceToken, deviceId, deviceName, relayUrl, socketPath. **No bot token.** |
| `~/.config/duckling/daemon.pid` | user daemon pid |
| `~/.config/duckling/daemon.log` | user daemon log |
| `~/.duckling.sock` | IPC between hooks and the daemon |
| `~/.config/duckling-relay/config.json` | relay config: bot token, port. Only present on the box running the relay. |
| `~/.config/duckling-relay/state.json` | persisted user/device records on the relay |
| `~/.config/duckling-relay/relay.pid` | relay pid |
| `~/.config/duckling-relay/relay.log` | relay log |
| `~/.claude/settings.json` | hooks merged in by `duckling setup` (not overwritten) |

## Multiple devices

Run `duckling setup` on each device. They all hit the same relay and Telegram user — your phone sees one stream of approvals, tagged `device/project`.

For a device on a different machine, point it at the relay: `DUCKLING_RELAY_URL=http://relay-host:8787 duckling setup`. (The local-relay variant doesn't yet do auth on the HTTP endpoints, so only use this on a trusted LAN.)

## Uninstall

```bash
duckling stop
duckling relay stop
# remove the hook entries from ~/.claude/settings.json (search for `duckling hook`)
rm -rf ~/.config/duckling ~/.config/duckling-relay ~/.duckling.sock
npm unlink -g duckling
```

## License

MIT.
