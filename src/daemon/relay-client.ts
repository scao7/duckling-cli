import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { log } from '../shared/logger';
import { DaemonToRelay, RelayToDaemon } from '../shared/protocol';

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 25_000;

/**
 * Wraps the WebSocket between a daemon and its relay.
 *
 * - Reconnects with exponential backoff when the link drops.
 * - Buffers nothing on the daemon side: pending approvals are tracked by the
 *   higher-level handler and time out at the hook layer if the link is down.
 *   That keeps memory tied to actual hook lifetime, not relay flakiness.
 */
export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopRequested = false;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly url: string) {
    super();
  }

  start(): void {
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'daemon stopping');
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: DaemonToRelay): boolean {
    if (!this.isOpen()) return false;
    try {
      this.ws!.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      log.warn('relay send failed:', e instanceof Error ? e.message : e);
      return false;
    }
  }

  private connect(): void {
    if (this.stopRequested) return;
    log.info('connecting to relay');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      log.info('relay connected');
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      this.startPing();
      this.emit('open');
    });

    ws.on('message', (data) => {
      let msg: RelayToDaemon;
      try {
        msg = JSON.parse(data.toString()) as RelayToDaemon;
      } catch (e) {
        log.warn('bad relay message:', e instanceof Error ? e.message : e);
        return;
      }
      this.emit('message', msg);
    });

    ws.on('close', (code) => {
      this.stopPing();
      this.ws = null;
      log.info(`relay closed (code ${code})`);
      this.emit('close');
      if (!this.stopRequested) this.scheduleReconnect();
    });

    ws.on('error', (e) => {
      log.warn('relay socket error:', e instanceof Error ? e.message : e);
      // Don't reconnect here — 'close' will fire too, and that's where we do it.
    });

    ws.on('unexpected-response', (_req, res) => {
      // 401 is the typical reason — token revoked or relay restarted with no
      // memory of us. Surface this distinctly so the user knows to re-pair.
      if (res.statusCode === 401) {
        log.error(
          'relay rejected our deviceToken (401). This device may need to be paired again with `duckling setup`.',
        );
        this.stopRequested = true;
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopRequested) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    log.info(`reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.isOpen()) return;
      try {
        this.ws!.ping();
      } catch (e) {
        log.warn('ping failed:', e instanceof Error ? e.message : e);
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
