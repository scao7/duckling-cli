import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOG_FILE } from './paths';

type Level = 'debug' | 'info' | 'warn' | 'error';

let stream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let prefix = '';

/**
 * Pick the log file. Each process calls this once at startup before logging.
 * Subsequent calls are silently ignored so diamond imports can't blow it up.
 */
export function initLog(filePath: string): void {
  if (stream) return;
  logFilePath = filePath;
}

export function setLogPrefix(p: string): void {
  prefix = p;
}

function getStream(): fs.WriteStream {
  if (!stream) {
    const target = logFilePath ?? LOG_FILE;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    stream = fs.createWriteStream(target, { flags: 'a' });
    logFilePath = target;
  }
  return stream;
}

function write(level: Level, args: unknown[]): void {
  const ts = new Date().toISOString();
  const parts = args.map((a) =>
    typeof a === 'string' ? a : safeStringify(a),
  );
  const tag = prefix ? ` ${prefix}` : '';
  const line = `${ts} ${level.toUpperCase()}${tag} ${parts.join(' ')}\n`;
  try {
    getStream().write(line);
  } catch {
    // Logging must never throw.
  }
  if (level === 'error' || level === 'warn' || process.env.DUCKLING_DEBUG) {
    process.stderr.write(line);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};
