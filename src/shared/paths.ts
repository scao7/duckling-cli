import * as os from 'node:os';
import * as path from 'node:path';

export const HOME = os.homedir();

// Per-device "user daemon" config — what each paired device writes.
export const CONFIG_DIR = path.join(HOME, '.config', 'duckling');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
export const LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');
/** Free-form Telegram messages from the user, waiting to be injected into
 *  the next UserPromptSubmit. Each line is JSON: {ts, fromUsername, text}. */
export const INBOX_FILE = path.join(CONFIG_DIR, 'inbox.jsonl');

export const DEFAULT_SOCKET_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\duckling'
    : path.join(HOME, '.duckling.sock');

/**
 * Default relay URL. Once you've deployed your own Cloudflare Worker, change
 * this to point at it. Self-hosters override via DUCKLING_RELAY_URL.
 */
export const DEFAULT_RELAY_URL = 'https://duckling-relay.codescao7.workers.dev';

export const CLAUDE_SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
