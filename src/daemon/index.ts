import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deriveWsUrl, loadConfigOrDie } from '../shared/config';
import { log, setLogPrefix } from '../shared/logger';
import { PID_FILE } from '../shared/paths';
import { RelayToDaemon } from '../shared/protocol';
import { RelayClient } from './relay-client';
import { SessionManager } from './session-manager';

const pkgVersion = (): string => {
  try {
    return require('../../package.json').version as string;
  } catch {
    return '0.0.0';
  }
};

/**
 * duckling daemon — Claude Agent SDK orchestrator + Telegram bridge.
 *
 *   1. Holds a stable WS connection to the Cloudflare Worker relay.
 *   2. Spawns / resumes Claude Agent SDK sessions on demand.
 *   3. Forwards structured SDK events (assistant text, plan updates, questions)
 *      to the relay, which renders them as Telegram messages.
 *   4. Routes user messages and button replies back into the right session.
 *
 * No pty, no attach socket, no terminal emulator. The SDK gives us discrete
 * messages; we forward them. Local TUI is users' own concern (`screen`, etc.).
 */

export async function runDaemon(): Promise<void> {
  setLogPrefix('[daemon]');
  const cfg = loadConfigOrDie();
  writePidFile();

  const wsUrl = deriveWsUrl(cfg.relayUrl, cfg.deviceToken);
  const relay = new RelayClient(wsUrl);
  let welcomed = false;

  const manager = new SessionManager({
    onSessionInit: (s) => {
      log.info(`session ${s.id} init (claude=${s.claudeSessionId ?? '?'})`);
      relay.send({ type: 'session_started', session: s.summary() });
      broadcastSnapshot();
    },
    onAssistantText: (s, text) => {
      if (!text.trim()) return;
      relay.send({ type: 'assistant_text', sessionId: s.id, text });
    },
    onToolUse: (s, tool, input, toolUseId) => {
      relay.send({ type: 'tool_use', sessionId: s.id, tool, input, toolUseId });
    },
    onToolResult: (s, toolUseId, output) => {
      relay.send({ type: 'tool_result', sessionId: s.id, toolUseId, output });
    },
    onPlanUpdate: (s, todos) => {
      relay.send({ type: 'plan_update', sessionId: s.id, todos });
    },
    onQuestion: (s, toolUseId, questions) => {
      relay.send({ type: 'question', sessionId: s.id, toolUseId, questions });
      broadcastSnapshot();
    },
    onComplete: (s, _finalText) => {
      // Each successful `result` marks the end of a turn. We only push a
      // summary footer when the turn actually did work — invoked a tool,
      // produced a plan, or asked a question. Pure conversational replies
      // (Claude says "OK" with no side effect) get NO footer so the chat
      // stays quiet for chit-chat.
      if (s.currentTurnDidWork) {
        relay.send({
          type: 'session_done',
          sessionId: s.id,
          status: 'completed',
          costUsd: s.costUsd,
          durationMs: Date.now() - s.startedAt,
          numTurns: s.numTurns,
        });
      }
      broadcastSnapshot();
      log.info(
        `session ${s.id} task ended (cost=$${s.costUsd.toFixed(4)}, turns=${s.numTurns}, didWork=${s.currentTurnDidWork})`,
      );
    },
    onFailed: (s, error) => {
      relay.send({
        type: 'session_done',
        sessionId: s.id,
        status: s.status === 'killed' ? 'killed' : 'failed',
        costUsd: s.costUsd,
        durationMs: Date.now() - s.startedAt,
        numTurns: s.numTurns,
        errorMessage: error,
      });
      broadcastSnapshot();
    },
  });

  function broadcastSnapshot(): void {
    if (!welcomed) return;
    relay.send({
      type: 'sessions_snapshot',
      sessions: manager.list(),
      currentId: manager.currentSessionId(),
    });
  }

  relay.on('open', () => {
    relay.send({
      type: 'hello',
      deviceName: cfg.deviceName,
      os: `${process.platform}-${os.release()}`,
      version: pkgVersion(),
    });
  });

  relay.on('message', (msg: RelayToDaemon) => {
    switch (msg.type) {
      case 'welcome':
        welcomed = true;
        log.info(`welcome from relay (tgUserId=${msg.tgUserId})`);
        broadcastSnapshot();
        return;
      case 'new_session': {
        log.info(
          `new_session from ${msg.fromUsername ? '@' + msg.fromUsername : 'tg'}: ${preview(msg.prompt)}`,
        );
        try {
          manager.spawn({
            prompt: msg.prompt,
            name: msg.name,
            model: msg.model,
            cwd: process.env.HOME ?? process.cwd(),
          });
        } catch (e) {
          log.error('spawn failed:', e instanceof Error ? e.message : e);
        }
        return;
      }
      case 'resume_session': {
        const existing = manager.resolve(msg.idOrName);
        if (existing && existing.claudeSessionId) {
          manager.spawn({
            prompt: '(resumed)',
            resumeClaudeSessionId: existing.claudeSessionId,
            forkSession: msg.fork === true,
            name: existing.name,
            cwd: existing.cwd,
            model: existing.model,
          });
        } else if (/^[A-Za-z0-9_-]{8,64}$/.test(msg.idOrName)) {
          // No record matches — treat the argument as a raw Claude session id
          // (covers cross-daemon resume). Strict regex guards against path
          // characters slipping into the SDK's resume option.
          manager.spawn({
            prompt: '(resumed)',
            resumeClaudeSessionId: msg.idOrName,
            forkSession: msg.fork === true,
          });
        } else {
          log.warn(`resume: nothing matches ${msg.idOrName} and id is malformed`);
          relay.send({
            type: 'notice',
            text: `没找到 session <code>${msg.idOrName.replace(/[&<>]/g, '?')}</code>。试试 <code>/sessions</code> 看看有哪些。`,
          });
        }
        return;
      }
      case 'chat': {
        try {
          const routed = manager.routeChat(msg.text, msg.sessionId);
          if (msg.fromUsername) log.info(`chat from @${msg.fromUsername}: ${preview(msg.text)}`);
          else log.info(`chat: ${preview(msg.text)}`);
          if (!routed) {
            relay.send({
              type: 'notice',
              text:
                '没有正在跑的 session。用 <code>/new &lt;你的需求&gt;</code> 开一个；或 <code>/sessions</code> 看看历史。',
            });
          }
        } catch (e) {
          log.warn('routeChat failed:', e instanceof Error ? e.message : e);
        }
        return;
      }
      case 'kill_session': {
        const s = manager.kill(msg.idOrName);
        if (!s) log.warn(`kill: no session matches ${msg.idOrName}`);
        return;
      }
      case 'set_current': {
        const s = manager.resolve(msg.idOrName);
        if (!s) {
          log.warn(`set_current: no session matches ${msg.idOrName}`);
          return;
        }
        manager.setCurrent(s.id);
        log.info(`current session → ${s.id} (${s.name})`);
        broadcastSnapshot();
        return;
      }
      case 'forget_session': {
        const forgottenId = manager.forget(msg.idOrName);
        if (!forgottenId) {
          log.warn(`forget: no session matches ${msg.idOrName}`);
          return;
        }
        log.info(`forgot session ${forgottenId}`);
        relay.send({ type: 'session_forgotten', sessionId: forgottenId });
        broadcastSnapshot();
        return;
      }
      case 'stop_current':
        void manager.stopCurrent();
        return;
      case 'question_answer': {
        const s = manager.resolve(msg.sessionId);
        if (!s) {
          log.warn(`question_answer: no session ${msg.sessionId}`);
          return;
        }
        s.answerQuestion(msg.toolUseId, msg.answers);
        return;
      }
      case 'list_sessions':
        broadcastSnapshot();
        return;
      case 'ping':
        relay.send({ type: 'pong', id: msg.id });
        return;
      case 'error':
        log.error('relay error:', msg.message);
        return;
    }
  });
  relay.start();

  // -------- lifecycle --------
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down:', reason);
    const hardExit = setTimeout(() => {
      log.error('shutdown hung — force-exiting');
      process.exit(1);
    }, 3000);
    hardExit.unref();
    try {
      manager.killAll();
    } catch (e) {
      log.warn('killAll failed:', e);
    }
    try {
      await relay.stop();
    } catch (e) {
      log.warn('relay stop failed:', e);
    }
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (e) => log.error('uncaughtException:', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e));
}

function writePidFile(): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone.
  }
}

function preview(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? clean.slice(0, 77) + '…' : clean;
}

if (require.main === module) {
  runDaemon().catch((e) => {
    log.error('fatal:', e);
    process.exit(1);
  });
}
