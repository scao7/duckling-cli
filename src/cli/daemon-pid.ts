import * as fs from 'node:fs';
import { PID_FILE } from '../shared/paths';

export function readPidFile(pidFile: string): number | null {
  if (!fs.existsSync(pidFile)) return null;
  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isProcessRunning(pidFile: string): boolean {
  const pid = readPidFile(pidFile);
  if (!pid) return false;
  return isPidAlive(pid);
}

export function clearStalePidFile(pidFile: string): void {
  const pid = readPidFile(pidFile);
  if (pid && !isPidAlive(pid)) {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Already gone — fine.
    }
  }
}

// Convenience wrappers for the daemon (the only long-running local process).
export function readPid(): number | null {
  return readPidFile(PID_FILE);
}
export function isDaemonRunning(): boolean {
  return isProcessRunning(PID_FILE);
}
export function clearStalePid(): void {
  clearStalePidFile(PID_FILE);
}
