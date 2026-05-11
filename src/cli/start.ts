import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureConfigDir, loadConfigOrDie } from '../shared/config';
import { LOG_FILE } from '../shared/paths';
import { clearStalePid, isDaemonRunning, readPid } from './daemon-pid';

export interface StartOpts {
  /** Kept for CLI compatibility; daemon always runs detached now (no attach). */
  detach?: boolean;
}

/**
 * `duckling start` — bring the daemon up if it isn't already.
 *
 * SDK era: there is no local pty to attach to. The daemon runs Claude in-
 * process via the Agent SDK and forwards events to Telegram. Local TUI is
 * the user's own concern — `claude` works as normal on the same machine.
 */
export async function runStart(_opts: StartOpts = {}): Promise<void> {
  loadConfigOrDie();
  clearStalePid();

  if (isDaemonRunning()) {
    process.stdout.write(`Daemon already running (pid ${readPid()}).\n`);
    return;
  }

  await spawnDaemonDetached();
  await waitForPid(3000);
  const pid = readPid();
  if (!pid) {
    process.stdout.write(
      `Daemon launch returned but pid file is missing. Check ${LOG_FILE}.\n`,
    );
    return;
  }
  process.stdout.write(
    `Daemon started (pid ${pid}). Talk to your bot on Telegram to spawn sessions.\n`,
  );
}

async function spawnDaemonDetached(): Promise<void> {
  ensureConfigDir();
  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');
  const cliPath = process.argv[1];
  if (!cliPath || !fs.existsSync(cliPath)) {
    throw new Error(`Cannot locate duckling CLI to spawn (${cliPath}).`);
  }
  // Forward the directory the user ran `duckling start` from so the daemon
  // can use it as the working dir for SDK sessions. This aligns the daemon's
  // cwd with the user's terminal `claude` cwd, so `~/.claude/projects/<cwd>/`
  // shows the same session pool the user has been working in.
  const userCwd = process.cwd();
  const child = spawn(process.execPath, [cliPath, '__daemon'], {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: path.dirname(cliPath),
    env: { ...process.env, DUCKLING_CWD: userCwd },
  });
  child.unref();
  process.stdout.write(`(cwd: ${userCwd})\n`);
}

async function waitForPid(maxMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (readPid()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
