/**
 * DirectoryDO — singleton Durable Object that holds the two cross-user
 * lookups duckling needs at the routing layer:
 *
 *   1. Pair tokens (short-lived) created by `duckling setup`, claimed when
 *      the user taps the bot's deep link.
 *   2. Device tokens (long-lived) issued on successful pairing, used by
 *      daemons as their WebSocket auth credential.
 *
 * Per-user state (sessions, devices list, pending approvals, WS connections)
 * lives in UserDO instances keyed by Telegram user id.
 */

import type { Env } from './types';

interface PendingPair {
  pairToken: string;
  deviceName: string;
  createdAt: number;
  paired?: {
    tgUserId: string;
    tgUsername?: string;
    deviceToken: string;
    deviceId: string;
  };
}

interface DeviceMapping {
  tgUserId: string;
  deviceId: string;
  deviceName: string;
}

interface UpsertDeviceBody {
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  tgUsername?: string;
}

const PAIR_KEY = (token: string) => `pair:${token}`;
const DEVICE_KEY = (token: string) => `device:${token}`;

export class DirectoryDO implements DurableObject {
  private storage: DurableObjectStorage;
  private pairTtlMs: number;

  constructor(state: DurableObjectState, private readonly env: Env) {
    this.storage = state.storage;
    this.pairTtlMs = parseTtl(env.PAIR_TTL_MS, 10 * 60_000);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/pair/new':
          return this.handleNewPair(request);
        case '/pair/bind':
          return this.handleBindPair(request);
        case '/pair/status':
          return this.handlePairStatus(url);
        case '/auth':
          return this.handleAuthDevice(url);
        default:
          return json(404, { error: 'unknown directory route' });
      }
    } catch (e) {
      console.error('DirectoryDO error', e);
      return json(500, { error: e instanceof Error ? e.message : 'internal' });
    }
  }

  // ---------- pair tokens ----------

  private async handleNewPair(request: Request): Promise<Response> {
    const body = (await request.json()) as { deviceName?: string };
    const deviceName = (body.deviceName ?? '').trim();
    if (!deviceName) return json(400, { error: 'deviceName required' });

    await this.expirePending();
    const pairToken = randomToken(16, 'base32');
    const record: PendingPair = {
      pairToken,
      deviceName,
      createdAt: Date.now(),
    };
    await this.storage.put(PAIR_KEY(pairToken), record);
    return json(200, {
      pairToken,
      expiresAt: record.createdAt + this.pairTtlMs,
    });
  }

  private async handleBindPair(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      pairToken?: string;
      tgUserId?: string;
      tgUsername?: string;
    };
    if (!body.pairToken || !body.tgUserId) {
      return json(400, { error: 'pairToken and tgUserId required' });
    }
    await this.expirePending();
    const pending = (await this.storage.get<PendingPair>(PAIR_KEY(body.pairToken))) ?? null;
    if (!pending) return json(404, { error: 'pair token not found or expired' });
    if (pending.paired) {
      // Idempotent — return the same paired record.
      return json(200, pending);
    }

    const deviceToken = randomToken(32, 'base64url');
    const deviceId = randomToken(8, 'base32');

    pending.paired = {
      tgUserId: String(body.tgUserId),
      tgUsername: body.tgUsername,
      deviceToken,
      deviceId,
    };
    await this.storage.put(PAIR_KEY(body.pairToken), pending);
    const mapping: DeviceMapping = {
      tgUserId: pending.paired.tgUserId,
      deviceId,
      deviceName: pending.deviceName,
    };
    await this.storage.put(DEVICE_KEY(deviceToken), mapping);

    // Tell the user's DO it has a new device (so it can list devices later).
    // Failure here doesn't undo pairing — the device can still authenticate
    // via the Directory lookup. We log and move on.
    try {
      const upsertBody: UpsertDeviceBody = {
        deviceId,
        deviceName: pending.deviceName,
        deviceToken,
        tgUsername: body.tgUsername,
      };
      const userDo = this.env.USER.get(this.env.USER.idFromName(pending.paired.tgUserId));
      await userDo.fetch('https://do/upsert-device', {
        method: 'POST',
        body: JSON.stringify(upsertBody),
      });
    } catch (e) {
      console.warn('UserDO upsert failed:', e instanceof Error ? e.message : e);
    }

    return json(200, pending);
  }

  private async handlePairStatus(url: URL): Promise<Response> {
    const token = url.searchParams.get('token') ?? '';
    if (!token) return json(400, { error: 'token required' });
    await this.expirePending();
    const pending = (await this.storage.get<PendingPair>(PAIR_KEY(token))) ?? null;
    if (!pending) return json(200, { status: 'expired' });
    if (pending.paired) {
      // Single-use: drop the pair token now that the caller has seen the
      // result. Device token is what's persisted long-term.
      await this.storage.delete(PAIR_KEY(token));
      return json(200, {
        status: 'paired',
        tgUserId: pending.paired.tgUserId,
        tgUsername: pending.paired.tgUsername,
        deviceToken: pending.paired.deviceToken,
        deviceId: pending.paired.deviceId,
      });
    }
    return json(200, { status: 'pending' });
  }

  private async handleAuthDevice(url: URL): Promise<Response> {
    const token = url.searchParams.get('token') ?? '';
    if (!token) return json(400, { error: 'token required' });
    const mapping = (await this.storage.get<DeviceMapping>(DEVICE_KEY(token))) ?? null;
    if (!mapping) return json(401, { error: 'unknown device token' });
    return json(200, mapping);
  }

  // ---------- helpers ----------

  private async expirePending(): Promise<void> {
    // List is bounded by the number of active pairings — typically a handful,
    // since each lives 10 minutes max.
    const cutoff = Date.now() - this.pairTtlMs;
    const list = await this.storage.list<PendingPair>({ prefix: 'pair:' });
    const toDelete: string[] = [];
    for (const [key, record] of list) {
      if (!record.paired && record.createdAt < cutoff) toDelete.push(key);
    }
    if (toDelete.length > 0) await this.storage.delete(toDelete);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function parseTtl(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Workers expose Web Crypto's `crypto.getRandomValues`; Node's crypto.randomBytes
 * isn't available. We roll our own base32 / base64url encoder.
 */
function randomToken(bytes: number, encoding: 'base32' | 'base64url'): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  if (encoding === 'base64url') {
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    // btoa is available in Workers.
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
