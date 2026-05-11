import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_RELAY_URL,
  DEFAULT_SOCKET_PATH,
} from './paths';

/**
 * v2 schema: per-device user config, written by `duckling setup` after pairing.
 *
 * The user side never holds the Telegram bot token — that lives in the relay's
 * own config. The deviceToken below is the WebSocket auth credential, opaque
 * to the user, revocable from the relay.
 *
 * No "mode" field. duckling is a pure relay: Claude Code decides what needs
 * user attention; duckling forwards those events to Telegram and routes the
 * answer back. No second permission gate.
 */
export interface Config {
  version: 2;
  deviceToken: string;
  deviceId: string;
  deviceName: string;
  /** Used to build the WS URL: relayUrl with http→ws plus /ws?token=... */
  relayUrl: string;
  socketPath: string;
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function loadConfig(): Config | null {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Config> & { version?: number };
  if (parsed.version !== 2) {
    throw new Error(
      `duckling config at ${CONFIG_FILE} is v${parsed.version ?? '?'} (expected v2). ` +
        `Remove the file and run \`duckling setup\` again to repair.`,
    );
  }
  if (!parsed.deviceToken || !parsed.deviceName || !parsed.relayUrl || !parsed.deviceId) {
    throw new Error(`duckling config at ${CONFIG_FILE} is missing required fields.`);
  }
  return {
    version: 2,
    deviceToken: parsed.deviceToken,
    deviceId: parsed.deviceId,
    deviceName: parsed.deviceName,
    relayUrl: parsed.relayUrl,
    socketPath: parsed.socketPath ?? DEFAULT_SOCKET_PATH,
  };
}

export function loadConfigOrDie(): Config {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error(
      `duckling is not paired. Run \`duckling setup\` first (looked for ${CONFIG_FILE}).`,
    );
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  ensureConfigDir();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

export function configFilePath(): string {
  return CONFIG_FILE;
}

export function configDirPath(): string {
  return path.dirname(CONFIG_FILE);
}

/** Convert a relay base URL (http://host:port) to its WS endpoint. */
export function deriveWsUrl(relayUrl: string, deviceToken: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + '/ws';
  u.searchParams.set('token', deviceToken);
  return u.toString();
}

export function defaultRelayUrl(): string {
  return process.env.DUCKLING_RELAY_URL ?? DEFAULT_RELAY_URL;
}
