import * as os from 'node:os';
import prompts from 'prompts';
import qrcode from 'qrcode-terminal';
import {
  Config,
  defaultRelayUrl,
  loadConfig,
  saveConfig,
} from '../shared/config';
import { bannerWithTagline } from './banner';
import { DEFAULT_SOCKET_PATH } from '../shared/paths';
import {
  PairNewRequest,
  PairNewResponse,
  PairStatusResponse,
} from '../shared/protocol';
import { runStart } from './start';
import { isDaemonRunning } from './daemon-pid';

const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 10 * 60_000;

export async function runSetup(): Promise<void> {
  // loadConfig throws on a v1 config (Phase 1 leftover). Ignore — we're
  // overwriting it anyway, but we want the prompts to come up either way.
  let existing: Config | null = null;
  try {
    existing = loadConfig();
  } catch {
    existing = null;
  }

  process.stdout.write(bannerWithTagline('Pairing a new device') + '\n');

  const relayUrl = (process.env.DUCKLING_RELAY_URL ?? defaultRelayUrl()).replace(
    /\/$/,
    '',
  );

  // Probe the relay early. A 60s pairing UX where the relay is dead is the
  // most confusing failure mode, so we surface it now with a hint.
  const health = await probeRelay(relayUrl);
  if (!health.ok) {
    throw new Error(
      `Relay at ${relayUrl} is not reachable (${health.reason}).\n` +
        `On the same machine? Run \`duckling relay start\` (after \`duckling relay setup\`).\n` +
        `Different machine? Set DUCKLING_RELAY_URL=<url>.`,
    );
  }
  process.stdout.write(`🔌 Relay: ${relayUrl} · bot: @${health.bot}\n\n`);

  const answers = await prompts(
    [
      {
        type: 'text',
        name: 'deviceName',
        message: 'Name for this device:',
        initial: existing?.deviceName ?? os.hostname().split('.')[0],
        validate: (v: string) => v.trim().length > 0 || 'Required',
      },
    ],
    {
      onCancel: () => {
        process.stdout.write('Cancelled.\n');
        process.exit(1);
      },
    },
  );
  const deviceName = String(answers.deviceName).trim();

  process.stdout.write('🔗 Requesting pairing token... ');
  const pair = await requestPair(relayUrl, { deviceName });
  process.stdout.write('ok\n\n');

  process.stdout.write('Pair this device — two ways, pick whichever works:\n\n');
  process.stdout.write(`  ① Tap this link / scan QR (works if you've never chatted with the bot):\n\n`);
  process.stdout.write(`     ${pair.deepLink}\n\n`);
  await renderQr(pair.deepLink);
  process.stdout.write(
    `\n  ② Already chatted with the bot? Telegram won't re-fire /start.\n` +
      `     Paste this directly into the bot chat:\n\n` +
      `        /start ${pair.pairToken}\n\n`,
  );
  process.stdout.write('⏳ Waiting...  (Ctrl+C to cancel. The token expires in 10 minutes.)\n\n');

  const status = await pollPair(relayUrl, pair.pairToken);
  if (status.status !== 'paired') {
    throw new Error(`Pairing did not complete: ${status.status}`);
  }

  const cfg: Config = {
    version: 2,
    deviceToken: status.deviceToken,
    deviceId: status.deviceId,
    deviceName,
    relayUrl,
    socketPath: existing?.socketPath ?? DEFAULT_SOCKET_PATH,
  };
  saveConfig(cfg);
  process.stdout.write(
    `✅ Paired with ${status.tgUsername ? `@${status.tgUsername}` : `tg:${status.tgUserId}`}\n`,
  );

  if (isDaemonRunning()) {
    process.stdout.write(
      '🔄 Daemon already running — restart it to pick up new credentials:\n   duckling stop && duckling start\n',
    );
  } else {
    process.stdout.write('🚀 Starting daemon...\n');
    await runStart();
  }

  process.stdout.write(
    `\n✅ Paired. Daemon is up.\n\n` +
      `From your phone:\n` +
      `   Chat with @DucklingCli_Bot. Send /new <task> to spawn a session.\n` +
      `   /sessions lists what's running; /help for more.\n`,
  );
}

async function probeRelay(
  relayUrl: string,
): Promise<{ ok: true; bot: string } | { ok: false; reason: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(`${relayUrl}/healthz`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { ok?: boolean; bot?: string };
    if (!body.ok) return { ok: false, reason: 'unhealthy' };
    return { ok: true, bot: body.bot ?? '?' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function requestPair(
  relayUrl: string,
  body: PairNewRequest,
): Promise<PairNewResponse> {
  const res = await fetch(`${relayUrl}/pair/new`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`relay /pair/new failed: HTTP ${res.status}`);
  }
  return (await res.json()) as PairNewResponse;
}

async function pollPair(
  relayUrl: string,
  pairToken: string,
): Promise<PairStatusResponse> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(
      `${relayUrl}/pair/status?token=${encodeURIComponent(pairToken)}`,
    );
    if (!res.ok) continue;
    const status = (await res.json()) as PairStatusResponse;
    if (status.status === 'paired') return status;
    if (status.status === 'expired') {
      throw new Error('pairing link expired before tap (relay may have restarted)');
    }
  }
  throw new Error('pairing timed out (10 minutes)');
}

async function renderQr(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    qrcode.generate(text, { small: true }, (qr: string) => {
      process.stdout.write(qr + '\n');
      resolve();
    });
  });
}
