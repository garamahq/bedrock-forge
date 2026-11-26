import { Client, ConnectConfig } from "ssh2";
import { EventEmitter } from "events";
import { createHash } from "crypto";

export interface SshServerConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string; // decrypted PEM key
  expectedHostKeyFingerprint?: string;
  onHostKeyFingerprint?: (fingerprint: string) => Promise<void> | void;
}

interface PooledConnection {
  client: Client;
  serverKey: string;
  identitySignature: string;
  inUse: boolean;
  createdAt: Date;
  lastUsedAt: Date;
}

interface PoolWaiter {
  identitySignature: string;
  tryAcquire: () => boolean;
  cancel: (reason: Error) => void;
}

const MAX_POOL_SIZE = 15;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CONNECTION_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 30_000;

/**
 * Derive an identity-scoped SSH pool key without including raw credentials.
 * Isolates sessions by username, host, port, private-key SHA-256 digest, and trust settings.
 */
export function buildSshPoolKey(config: SshServerConfig): string {
  const keyDigest = createHash("sha256")
    .update(config.privateKey)
    .digest("hex")
    .slice(0, 16);
  const trustPolicy = config.expectedHostKeyFingerprint
    ? `fp:${config.expectedHostKeyFingerprint}`
    : config.onHostKeyFingerprint
      ? "tofu"
      : "unverified";
  return `${config.username}@${config.host}:${config.port}#${keyDigest}#${trustPolicy}`;
}

/**
 * Global SSH connection pool. One instance per process, shared across all
 * RemoteExecutorService calls.
 *
 * - Max 15 concurrent connections (established + in-flight handshakes) per pool key
 * - Connections idle for >5 min are proactively closed
 * - Sessions are matched by account identity & host-key trust policy (#79)
 * - Timed-out waiters stop cleanly without stealing subsequent releases (#77)
 */
export class SshPoolManager extends EventEmitter {
  private pools: Map<string, PooledConnection[]> = new Map();
  private pendingConnects: Map<string, number> = new Map();
  private waiters: Map<string, PoolWaiter[]> = new Map();
  private gcInterval: NodeJS.Timeout;

  constructor() {
    super();
    this.gcInterval = setInterval(() => this.gc(), 60_000);
    this.gcInterval.unref();
  }

  async getConnection(
    serverKey: string,
    config: SshServerConfig,
  ): Promise<Client> {
    const reqIdentity = buildSshPoolKey(config);
    const pool = this.getPool(serverKey);

    const idle = pool.find(
      (c) => !c.inUse && c.identitySignature === reqIdentity,
    );
    if (idle) {
      idle.inUse = true;
      idle.lastUsedAt = new Date();
      return idle.client;
    }

    if (this.totalSlotsUsed(serverKey) < MAX_POOL_SIZE) {
      this.incrementPending(serverKey);
      return this.createConnection(serverKey, config, reqIdentity);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const waiterList = this.getWaiters(serverKey);

      const cleanup = () => {
        clearTimeout(timeout);
        const idx = waiterList.indexOf(waiter);
        if (idx !== -1) {
          waiterList.splice(idx, 1);
        }
        if (waiterList.length === 0) {
          this.waiters.delete(serverKey);
        }
      };

      const waiter: PoolWaiter = {
        identitySignature: reqIdentity,
        cancel: (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
        tryAcquire: () => {
          if (settled) return false;
          const currentPool = this.getPool(serverKey);
          const available = currentPool.find(
            (c) => !c.inUse && c.identitySignature === reqIdentity,
          );
          if (available) {
            settled = true;
            cleanup();
            available.inUse = true;
            available.lastUsedAt = new Date();
            resolve(available.client);
            return true;
          }
          if (this.totalSlotsUsed(serverKey) < MAX_POOL_SIZE) {
            settled = true;
            cleanup();
            this.incrementPending(serverKey);
            this.createConnection(serverKey, config, reqIdentity).then(
              resolve,
              reject,
            );
            return true;
          }
          return false;
        },
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `SSH pool timeout for server ${serverKey}: pool at capacity (${MAX_POOL_SIZE})`,
          ),
        );
      }, WAIT_TIMEOUT_MS);

      waiterList.push(waiter);
    });
  }

  releaseConnection(serverKey: string, client: Client): void {
    const pool = this.getPool(serverKey);
    const entry = pool.find((c) => c.client === client);
    if (entry) {
      entry.inUse = false;
      entry.lastUsedAt = new Date();
      this.notifyWaiters(serverKey);
    }
  }

  /**
   * Forcefully remove a connection from the pool and destroy the underlying
   * TCP socket.
   */
  destroyConnection(serverKey: string, client: Client): void {
    this.removeConnection(serverKey, client);
    try {
      client.destroy();
    } catch (_) {
      // ignore
    }
  }

  closeServer(serverKey: string): void {
    const waiterList = this.waiters.get(serverKey);
    if (waiterList) {
      for (const w of [...waiterList]) {
        w.cancel(new Error(`SSH pool closed for server ${serverKey}`));
      }
      this.waiters.delete(serverKey);
    }

    const pool = this.getPool(serverKey);
    pool.forEach((c) => {
      try {
        c.client.end();
      } catch (_) {
        // ignore close errors
      }
    });
    this.pools.delete(serverKey);
    this.pendingConnects.delete(serverKey);
  }

  getPoolStats(serverKey: string): {
    active: number;
    idle: number;
    total: number;
    maxConnections: number;
  } {
    const pool = this.pools.get(serverKey) ?? [];
    const active = pool.filter((c) => c.inUse).length;
    return {
      active,
      idle: pool.length - active,
      total: pool.length,
      maxConnections: MAX_POOL_SIZE,
    };
  }

  destroy(): void {
    clearInterval(this.gcInterval);
    const keys = new Set<string>([
      ...this.pools.keys(),
      ...this.waiters.keys(),
    ]);
    for (const serverKey of keys) {
      this.closeServer(serverKey);
    }
  }

  private totalSlotsUsed(serverKey: string): number {
    return (
      (this.pools.get(serverKey)?.length ?? 0) +
      (this.pendingConnects.get(serverKey) ?? 0)
    );
  }

  private incrementPending(serverKey: string): void {
    this.pendingConnects.set(
      serverKey,
      (this.pendingConnects.get(serverKey) ?? 0) + 1,
    );
  }

  private decrementPending(serverKey: string): void {
    const current = this.pendingConnects.get(serverKey) ?? 0;
    if (current <= 1) {
      this.pendingConnects.delete(serverKey);
    } else {
      this.pendingConnects.set(serverKey, current - 1);
    }
  }

  private getPool(serverKey: string): PooledConnection[] {
    if (!this.pools.has(serverKey)) {
      this.pools.set(serverKey, []);
    }
    return this.pools.get(serverKey)!;
  }

  private getWaiters(serverKey: string): PoolWaiter[] {
    if (!this.waiters.has(serverKey)) {
      this.waiters.set(serverKey, []);
    }
    return this.waiters.get(serverKey)!;
  }

  private notifyWaiters(serverKey: string): void {
    const waiterList = this.waiters.get(serverKey);
    if (!waiterList || waiterList.length === 0) return;

    for (const waiter of [...waiterList]) {
      if (waiter.tryAcquire()) {
        if (this.totalSlotsUsed(serverKey) >= MAX_POOL_SIZE) {
          const stillIdle = this.getPool(serverKey).some((c) => !c.inUse);
          if (!stillIdle) break;
        }
      }
    }
  }

  private removeConnection(serverKey: string, client: Client): void {
    const pool = this.pools.get(serverKey);
    if (!pool) return;
    const idx = pool.findIndex((c) => c.client === client);
    if (idx !== -1) {
      pool.splice(idx, 1);
      this.notifyWaiters(serverKey);
    }
  }

  private createConnection(
    serverKey: string,
    config: SshServerConfig,
    identitySignature: string,
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const pool = this.getPool(serverKey);
      let pendingReserved = true;

      const releasePending = (notifyOnRelease: boolean) => {
        if (!pendingReserved) return;
        pendingReserved = false;
        this.decrementPending(serverKey);
        if (notifyOnRelease) {
          this.notifyWaiters(serverKey);
        }
      };

      const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey: config.privateKey,
        readyTimeout: CONNECTION_TIMEOUT_MS,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          const fingerprint = createHash("sha256").update(key).digest("base64");
          if (config.expectedHostKeyFingerprint) {
            verify(config.expectedHostKeyFingerprint === fingerprint);
          } else {
            if (config.onHostKeyFingerprint) {
              Promise.resolve(config.onHostKeyFingerprint(fingerprint)).catch(
                () => {},
              );
            }
            verify(true);
          }
        },
      };

      client.on("ready", () => {
        const entry: PooledConnection = {
          client,
          serverKey,
          identitySignature,
          inUse: true,
          createdAt: new Date(),
          lastUsedAt: new Date(),
        };
        pool.push(entry);
        releasePending(false);
        resolve(client);
      });

      client.on("error", (err) => {
        releasePending(false);
        this.removeConnection(serverKey, client);
        this.notifyWaiters(serverKey);
        reject(
          new Error(
            `SSH connection failed for server ${serverKey}: ${err.message}`,
          ),
        );
      });

      client.on("end", () => {
        releasePending(true);
        this.removeConnection(serverKey, client);
      });

      client.on("close", () => {
        releasePending(true);
        this.removeConnection(serverKey, client);
      });

      try {
        client.connect(connectConfig);
      } catch (err) {
        releasePending(true);
        reject(err);
      }
    });
  }

  private gc(): void {
    const now = Date.now();
    for (const [serverKey, pool] of this.pools.entries()) {
      const active = pool.filter((c) => {
        if (c.inUse) return true;
        if (now - c.lastUsedAt.getTime() > IDLE_TIMEOUT_MS) {
          try {
            c.client.end();
          } catch (_) {
            // ignore
          }
          return false;
        }
        return true;
      });
      if (active.length === 0) {
        this.pools.delete(serverKey);
      } else {
        this.pools.set(serverKey, active);
      }
    }
  }
}

export const sshPoolManager = new SshPoolManager();
