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
  inUse: boolean;
  createdAt: Date;
  lastUsedAt: Date;
}

const MAX_POOL_SIZE = 15;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Global SSH connection pool. One instance per process, shared across all
 * RemoteExecutorService calls. Keyed by serverId.
 *
 * Design decisions:
 * - Max 15 concurrent connections per server to avoid overwhelming target hosts
 * - Connections idle for >5 min are proactively closed
 * - getConnection() blocks (polls) if pool is at capacity — callers should
 *   use BullMQ concurrency limits to avoid starvation
 */
export class SshPoolManager extends EventEmitter {
  private pools: Map<string, PooledConnection[]> = new Map();
  private gcInterval: NodeJS.Timeout;

  constructor() {
    super();
    // Garbage-collect idle connections every 60 seconds
    this.gcInterval = setInterval(() => this.gc(), 60_000);
    this.gcInterval.unref(); // Don't prevent process exit
  }

  async getConnection(
    serverKey: string,
    config: SshServerConfig,
  ): Promise<Client> {
    const pool = this.getPool(serverKey);

    // Try to find an idle existing connection
    const idle = pool.find((c) => !c.inUse);
    if (idle) {
      idle.inUse = true;
      idle.lastUsedAt = new Date();
      return idle.client;
    }

    // If below max, create a new connection
    if (pool.length < MAX_POOL_SIZE) {
      const conn = await this.createConnection(serverKey, config);
      return conn;
    }

    // Pool at capacity — wait for a connection to become available
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `SSH pool timeout for server ${serverKey}: pool at capacity (${MAX_POOL_SIZE})`,
          ),
        );
      }, 30_000);

      const check = setInterval(() => {
        const available = this.getPool(serverKey).find((c) => !c.inUse);
        if (available) {
          clearInterval(check);
          clearTimeout(timeout);
          available.inUse = true;
          available.lastUsedAt = new Date();
          resolve(available.client);
        }
      }, 100);
    });
  }

  releaseConnection(serverKey: string, client: Client): void {
    const pool = this.getPool(serverKey);
    const entry = pool.find((c) => c.client === client);
    if (entry) {
      entry.inUse = false;
      entry.lastUsedAt = new Date();
    }
  }

  /**
   * Forcefully remove a connection from the pool and destroy the underlying
   * TCP socket. Called when a channel-open failure signals the connection is
   * dead and must not be reused. A subsequent releaseConnection() call for
   * the same client becomes a no-op because the entry is already gone.
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
    const pool = this.getPool(serverKey);
    pool.forEach((c) => {
      try {
        c.client.end();
      } catch (_) {
        // ignore close errors
      }
    });
    this.pools.delete(serverKey);
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
    for (const serverKey of this.pools.keys()) {
      this.closeServer(serverKey);
    }
  }

  private getPool(serverKey: string): PooledConnection[] {
    if (!this.pools.has(serverKey)) {
      this.pools.set(serverKey, []);
    }
    return this.pools.get(serverKey)!;
  }

  private removeConnection(serverKey: string, client: Client): void {
    const pool = this.pools.get(serverKey);
    if (!pool) return;
    const idx = pool.findIndex((c) => c.client === client);
    if (idx !== -1) pool.splice(idx, 1);
  }

  private createConnection(
    serverKey: string,
    config: SshServerConfig,
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const pool = this.getPool(serverKey);

      const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey: config.privateKey,
        readyTimeout: CONNECTION_TIMEOUT_MS,
        // Send a keepalive packet every 10 s so firewalls / NAT tables don't
        // silently drop the TCP connection during long SFTP transfers.
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          const fingerprint = createHash("sha256").update(key).digest("base64");
          if (config.expectedHostKeyFingerprint) {
            if (config.expectedHostKeyFingerprint === fingerprint) {
              verify(true);
            } else {
              verify(false);
            }
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
          inUse: true,
          createdAt: new Date(),
          lastUsedAt: new Date(),
        };
        pool.push(entry);
        resolve(client);
      });

      client.on("error", (err) => {
        this.removeConnection(serverKey, client);
        reject(
          new Error(
            `SSH connection failed for server ${serverKey}: ${err.message}`,
          ),
        );
      });

      client.on("end", () => {
        // Remove from pool on disconnect
        this.removeConnection(serverKey, client);
      });

      client.on("close", () => {
        // Some SSH disconnects report close without a prior end event.
        this.removeConnection(serverKey, client);
      });

      client.connect(connectConfig);
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

// Singleton — shared across the process
export const sshPoolManager = new SshPoolManager();
