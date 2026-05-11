import { Config, loadConfig } from '../shared/config';
import { CONFIG_FILE, LOG_FILE } from '../shared/paths';
import { isDaemonRunning, readPid } from './daemon-pid';

export async function runStatus(): Promise<void> {
  let cfg: Config | null = null;
  try {
    cfg = loadConfig();
  } catch (e) {
    process.stdout.write(`Config error: ${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  if (!cfg) {
    process.stdout.write(`No config found at ${CONFIG_FILE}.\nRun \`duckling setup\`.\n`);
    return;
  }

  const pid = readPid();
  const running = isDaemonRunning();
  const tokenPreview = `${cfg.deviceToken.slice(0, 8)}…${cfg.deviceToken.slice(-4)}`;

  process.stdout.write(`Device:       ${cfg.deviceName} (${cfg.deviceId})\n`);
  process.stdout.write(`Device token: ${tokenPreview}\n`);
  process.stdout.write(`Relay URL:    ${cfg.relayUrl}\n`);
  process.stdout.write(`Daemon:       ${running ? `running (pid ${pid})` : 'stopped'}\n`);
  process.stdout.write(`Log:          ${LOG_FILE}\n`);
  process.stdout.write(`Config:       ${CONFIG_FILE}\n`);
}
