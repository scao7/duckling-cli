import * as fs from 'node:fs';
import { CLAUDE_SETTINGS_FILE } from '../shared/paths';

/**
 * Remove every duckling-installed hook entry from ~/.claude/settings.json.
 *
 * After the pty pivot duckling no longer relies on hooks at all — they were
 * leftovers from the old design. Existing users have stale entries pointing
 * to `duckling hook pretool` (etc.), which fail at runtime since those
 * subcommands were removed. This command strips them cleanly.
 *
 * Heuristic: any hook entry whose command string starts with `duckling hook`
 * is ours. Anything else is left alone.
 */

interface HookCmd {
  type?: string;
  command?: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCmd[];
}
interface ClaudeSettings {
  hooks?: Record<string, HookEntry[] | undefined>;
  [k: string]: unknown;
}

export function runUninstallHooks(): void {
  if (!fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    process.stdout.write(`No ${CLAUDE_SETTINGS_FILE} — nothing to clean.\n`);
    return;
  }
  const raw = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf8').trim();
  if (!raw) {
    process.stdout.write(`${CLAUDE_SETTINGS_FILE} is empty — nothing to clean.\n`);
    return;
  }
  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(raw) as ClaudeSettings;
  } catch (e) {
    throw new Error(
      `Could not parse ${CLAUDE_SETTINGS_FILE}: ${(e as Error).message}. ` +
        `Fix the JSON by hand and re-run.`,
    );
  }

  let removed = 0;
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      const kept: HookEntry[] = [];
      for (const entry of entries) {
        const filteredHooks = (entry.hooks ?? []).filter((h) => {
          if (typeof h.command !== 'string') return true;
          const isDuckling = h.command.trim().startsWith('duckling hook');
          if (isDuckling) removed++;
          return !isDuckling;
        });
        if (filteredHooks.length > 0) {
          kept.push({ ...entry, hooks: filteredHooks });
        }
      }
      settings.hooks[event] = kept.length > 0 ? kept : undefined;
    }
    // Drop empty event keys.
    for (const event of Object.keys(settings.hooks)) {
      if (!settings.hooks[event] || settings.hooks[event]!.length === 0) {
        delete settings.hooks[event];
      }
    }
    // Drop the hooks object itself if it's empty.
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  const tmp = CLAUDE_SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, CLAUDE_SETTINGS_FILE);
  process.stdout.write(
    `Removed ${removed} duckling hook entr${removed === 1 ? 'y' : 'ies'} from ${CLAUDE_SETTINGS_FILE}.\n`,
  );
}
