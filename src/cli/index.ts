#!/usr/bin/env node
import { Command } from 'commander';
import { runDaemon } from '../daemon';
import { bannerWithTagline } from './banner';
import { runSetup } from './setup';
import { runStart } from './start';
import { runStatus } from './status';
import { runStop } from './stop';
import { runUninstallHooks } from './uninstall-hooks';

// Read version from package.json — single source of truth, can't drift.
// The package.json sits two levels up from dist/cli/index.js, so use a
// resolution that works both in dist (compiled) and src (ts-node).
const pkgVersion = (() => {
  try {
    return require('../../package.json').version as string;
  } catch {
    return '0.0.0';
  }
})();

async function main(): Promise<void> {
  const showBanner =
    process.argv.length <= 2 ||
    process.argv[2] === 'help' ||
    process.argv.includes('--help') ||
    process.argv.includes('-h');
  const isHidden = process.argv[2] === '__daemon';
  if (showBanner && !isHidden) {
    process.stdout.write(bannerWithTagline() + '\n');
  }

  const program = new Command();
  program
    .name('duckling')
    .description('Claude Code over Telegram. Runs the Agent SDK in a daemon; bridges to TG.')
    .version(pkgVersion)
    .showHelpAfterError();

  program
    .command('setup')
    .description('Pair this device with the duckling relay.')
    .action(async () => {
      await runSetup();
    });

  program
    .command('start')
    .description('Start the daemon. Talk to your bot on Telegram to drive Claude.')
    .action(async () => {
      await runStart();
    });

  program
    .command('stop')
    .description('Stop the daemon (kills any running SDK sessions).')
    .action(async () => {
      await runStop();
    });

  program
    .command('status')
    .description('Show daemon status and configuration.')
    .action(async () => {
      await runStatus();
    });

  program
    .command('uninstall-hooks')
    .description('Remove legacy duckling hook entries from ~/.claude/settings.json.')
    .action(() => {
      runUninstallHooks();
    });

  // Hidden daemon entry — `duckling start` spawns this in the background.
  program
    .command('__daemon', { hidden: true })
    .description('Run the daemon in the foreground (internal).')
    .action(async () => {
      await runDaemon();
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  process.stderr.write(`duckling: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
