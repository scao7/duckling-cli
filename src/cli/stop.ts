import * as fs from 'node:fs';
import { PID_FILE } from '../shared/paths';
import { isPidAlive, readPid } from './daemon-pid';

export async function runStop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    process.stdout.write('Daemon is not running.\n');
    return;
  }

  if (!isPidAlive(pid)) {
    fs.unlinkSync(PID_FILE);
    process.stdout.write(`Daemon (pid ${pid}) was not alive — cleaned up pid file.\n`);
    return;
  }

  process.stdout.write(`Stopping daemon (pid ${pid})...\n`);
  process.kill(pid, 'SIGTERM');

  const stoppedCleanly = await waitForExit(pid, 4000);
  if (!stoppedCleanly) {
    process.stdout.write('Daemon did not exit in time, sending SIGKILL.\n');
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }

  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Daemon's own SIGTERM handler already removed it — fine.
  }
  process.stdout.write('Stopped.\n');
}

async function waitForExit(pid: number, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
