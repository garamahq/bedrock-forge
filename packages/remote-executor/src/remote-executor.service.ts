import { createWriteStream } from "fs";
import type { Readable } from "stream";
import {
  Client,
  type ReadStream as SftpReadStream,
  type SFTPWrapper,
  type WriteStream as SftpWriteStream,
} from "ssh2";
import {
  sshPoolManager,
  SshServerConfig,
  SshPoolManager,
} from "./ssh-pool.manager.js";

/**
 * Stall timeout for SFTP transfers: if no data chunk arrives for this long,
 * the connection is considered hung and we abort. The timer resets on every
 * data event, so a slow-but-progressing 2 GB transfer is never aborted —
 * only genuinely stalled connections are.
 */
const SFTP_STALL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes with no data = stall

/**
 * Returns true when `err` is an SSH channel-open rejection — a sign that the
 * pooled connection is stale/exhausted and must be evicted, not returned idle.
 */
function isChannelOpenFailure(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("Channel open failure") ||
      err.message.includes("open failed"))
  );
}

export interface ExecuteOptions {
  timeout?: number; // ms, default 30000
  cwd?: string;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RemoteFile {
  content: string | Buffer;
  remotePath: string;
  mode?: number; // octal, default 0o644
}

/**
 * RemoteExecutorService
 *
 * Single access point for all SSH-based remote operations. Uses the global
 * SshPoolManager. Never called directly from controllers — always invoked
 * inside BullMQ job processors.
 *
 * Usage:
 *   const executor = new RemoteExecutorService(serverConfig);
 *   const result = await executor.execute('cat /var/www/html/wp-config.php');
 */
export class RemoteExecutorService {
  constructor(
    private readonly config: SshServerConfig,
    private readonly pool: SshPoolManager = sshPoolManager,
  ) {}

  /**
   * Execute a shell command on the remote server.
   * Returns stdout, stderr, and exit code.
   */
  async execute(
    command: string,
    opts: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const timeout = opts.timeout ?? 30_000;
    return this.withConnection((client) =>
      this.runCommand(client, command, timeout),
    );
  }

  /**
   * Push a file to the remote server via SFTP.
   */
  async pushFile(file: RemoteFile): Promise<void> {
    return this.withConnection((client) => this.sftpPut(client, file));
  }

  /**
   * Pull a file's content from the remote server via SFTP.
   * NOTE: buffers the entire file in memory — only suitable for small files.
   * For large files (backups, etc.) use pullFileToPath() instead.
   */
  async pullFile(remotePath: string): Promise<Buffer> {
    return this.withConnection((client) => this.sftpGet(client, remotePath));
  }

  /**
   * Pull a large file from the remote server via SFTP, streaming directly
   * to disk. Never buffers the entire file in memory.
   *
   * @param onProgress  optional callback invoked with cumulative bytes received
   */
  async pullFileToPath(
    remotePath: string,
    localPath: string,
    timeoutMs: number = SFTP_STALL_TIMEOUT_MS,
    onProgress?: (bytes: number) => void,
  ): Promise<void> {
    return this.withConnection((client) =>
      this.sftpGetToFile(client, remotePath, localPath, timeoutMs, onProgress),
    );
  }

  /**
   * Stream a Readable (e.g. rclone stdout) into a remote file via SFTP.
   * Never buffers the entire stream in memory — zero-copy streaming.
   *
   * @param onProgress  optional callback invoked with cumulative bytes sent
   */
  async pushFileFromStream(
    remotePath: string,
    readable: Readable,
    timeoutMs: number = SFTP_STALL_TIMEOUT_MS,
    onProgress?: (bytes: number) => void,
  ): Promise<void> {
    return this.withConnection((client) =>
      this.sftpPutFromStream(
        client,
        remotePath,
        readable,
        timeoutMs,
        onProgress,
      ),
    );
  }

  /**
   * Acquire a connection from the pool, run `fn`, and release it back.
   * If `fn` throws a channel-open failure (stale/exhausted connection), the
   * connection is evicted from the pool and the call is retried once on a
   * freshly established connection.
   */
  private async withConnection<T>(
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const serverKey = `${this.config.host}:${this.config.port}`;
    const client = await this.pool.getConnection(serverKey, this.config);
    try {
      return await fn(client);
    } catch (err) {
      if (isChannelOpenFailure(err)) {
        // Stale connection — evict and retry once on a fresh one
        this.pool.destroyConnection(serverKey, client);
        const fresh = await this.pool.getConnection(serverKey, this.config);
        try {
          return await fn(fresh);
        } finally {
          this.pool.releaseConnection(serverKey, fresh);
        }
      }
      throw err;
    } finally {
      // No-op if the connection was already destroyed above
      this.pool.releaseConnection(serverKey, client);
    }
  }

  private runCommand(
    client: Client,
    command: string,
    timeout: number,
  ): Promise<ExecuteResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      // Keep a reference so the timeout handler can close the channel.
      let channelRef: Parameters<Parameters<Client["exec"]>[1]>[1] | null =
        null;

      const timer = setTimeout(() => {
        // Destroy the SSH channel so it doesn't hold a MaxSessions slot.
        try {
          channelRef?.destroy();
        } catch (_) {
          // ignore — channel may already be gone
        }
        reject(
          new Error(
            `Command timed out after ${timeout}ms: ${command.slice(0, 100)}`,
          ),
        );
      }, timeout);

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        channelRef = stream;

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: code ?? 0,
          });
        });

        stream.on("error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    });
  }

  private sftpPut(client: Client, file: RemoteFile): Promise<void> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);

        const content =
          typeof file.content === "string"
            ? Buffer.from(file.content, "utf-8")
            : file.content;

        const writeStream = sftp.createWriteStream(file.remotePath, {
          mode: file.mode ?? 0o644,
        });

        writeStream.on("close", () => {
          sftp.end();
          resolve();
        });
        writeStream.on("error", reject);
        writeStream.end(content);
      });
    });
  }

  private sftpGet(
    client: Client,
    remotePath: string,
    timeoutMs: number = SFTP_STALL_TIMEOUT_MS,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sftpRef: SFTPWrapper | null = null;
      let readStreamRef: SftpReadStream | null = null;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(stallTimer);
          if (readStreamRef) {
            try {
              readStreamRef.destroy();
            } catch (_) {}
          }
          if (sftpRef) {
            try {
              sftpRef.end();
            } catch (_) {}
          }
          fn();
        }
      };

      const makeStallError = () =>
        new Error(
          `SFTP pull stalled — no data for ${timeoutMs / 1000}s on ${remotePath}`,
        );

      let stallTimer: ReturnType<typeof setTimeout> = setTimeout(
        () => settle(() => reject(makeStallError())),
        timeoutMs,
      );

      const resetStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(
          () => settle(() => reject(makeStallError())),
          timeoutMs,
        );
      };

      client.sftp((err, sftp) => {
        if (err) return settle(() => reject(err));
        sftpRef = sftp;

        const chunks: Buffer[] = [];
        const readStream = sftp.createReadStream(remotePath);
        readStreamRef = readStream;

        readStream.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          resetStall();
        });
        readStream.on("end", () => {
          settle(() => {
            resolve(Buffer.concat(chunks));
          });
        });
        readStream.on("error", (e: Error) => {
          settle(() => {
            reject(e);
          });
        });
      });
    });
  }

  /**
   * Stream the remote file directly to a local file on disk.
   *
   * Uses an activity-based stall timer (not a flat wall-clock timer) so that
   * large files transfer uninterrupted as long as data keeps flowing. The
   * timer resets on every `data` event. If no bytes arrive for `timeoutMs`
   * (default 5 min) the connection is considered stalled and we abort.
   *
   * This replaces the old flat 45-min timer that caused 916 MB+ backups to
   * time out even while data was actively transferring.
   */
  private sftpGetToFile(
    client: Client,
    remotePath: string,
    localPath: string,
    timeoutMs: number,
    onProgress?: (bytes: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sftpRef: SFTPWrapper | null = null;
      let readStreamRef: SftpReadStream | null = null;
      let writeStreamRef: ReturnType<typeof createWriteStream> | null = null;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(stallTimer);
          if (readStreamRef) {
            try {
              readStreamRef.destroy();
            } catch (_) {}
          }
          if (writeStreamRef) {
            try {
              writeStreamRef.destroy();
            } catch (_) {}
          }
          if (sftpRef) {
            try {
              sftpRef.end();
            } catch (_) {}
          }
          fn();
        }
      };

      const makeStallError = () =>
        new Error(
          `SFTP pull stalled — no data for ${timeoutMs / 1000}s on ${remotePath}`,
        );

      // Activity-based stall timer: resets on every data chunk.
      let stallTimer: ReturnType<typeof setTimeout> = setTimeout(
        () => settle(() => reject(makeStallError())),
        timeoutMs,
      );

      const resetStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(
          () => settle(() => reject(makeStallError())),
          timeoutMs,
        );
      };

      client.sftp((err, sftp) => {
        if (err) return settle(() => reject(err));
        sftpRef = sftp;

        const readStream = sftp.createReadStream(remotePath);
        readStreamRef = readStream;
        const writeStream = createWriteStream(localPath);
        writeStreamRef = writeStream;
        let totalBytes = 0;

        readStream.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          resetStall(); // transfer is alive — postpone stall deadline
          if (onProgress) onProgress(totalBytes);
        });

        readStream.on("error", (e: Error) => {
          settle(() => {
            reject(e);
          });
        });

        writeStream.on("error", (e: Error) => {
          settle(() => {
            reject(e);
          });
        });

        // 'close' fires after all data is flushed and the fd is released.
        // This is the correct completion signal for a file WriteStream.
        writeStream.on("close", () =>
          settle(() => {
            resolve();
          }),
        );

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Pipe a Readable stream into a remote SFTP write stream.
   * Streaming from rclone stdout into SSH SFTP — no local temp files.
   * @param onProgress optional callback with cumulative bytes pushed
   */
  private sftpPutFromStream(
    client: Client,
    remotePath: string,
    readable: Readable,
    timeoutMs: number,
    onProgress?: (bytes: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sftpRef: SFTPWrapper | null = null;
      let writeStreamRef: SftpWriteStream | null = null;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(stallTimer);
          if (writeStreamRef) {
            try {
              writeStreamRef.destroy();
            } catch (_) {}
          }
          if (sftpRef) {
            try {
              sftpRef.end();
            } catch (_) {}
          }
          fn();
        }
      };

      const makeStallError = () =>
        new Error(
          `SFTP push stalled — no data for ${timeoutMs / 1000}s on ${remotePath}`,
        );

      // Activity-based stall timer: resets on every data chunk.
      let stallTimer: ReturnType<typeof setTimeout> = setTimeout(
        () => settle(() => reject(makeStallError())),
        timeoutMs,
      );

      const resetStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(
          () => settle(() => reject(makeStallError())),
          timeoutMs,
        );
      };

      client.sftp((err, sftp) => {
        if (err) return settle(() => reject(err));
        sftpRef = sftp;

        const writeStream = sftp.createWriteStream(remotePath, {
          mode: 0o644,
        });
        writeStreamRef = writeStream;
        let totalBytes = 0;

        readable.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          resetStall(); // transfer is alive — postpone stall deadline
          if (onProgress) onProgress(totalBytes);
        });

        readable.on("error", (e: Error) => {
          settle(() => {
            reject(e);
          });
        });

        writeStream.on("error", (e: Error) => {
          settle(() => {
            reject(e);
          });
        });

        // 'close' fires after all bytes are flushed to the remote fd.
        writeStream.on("close", () =>
          settle(() => {
            resolve();
          }),
        );

        readable.pipe(writeStream);
      });
    });
  }
}

/**
 * Factory function — creates a RemoteExecutorService for a given server config.
 * Used in processors where the server config is pulled from PrismaService.
 */
export function createRemoteExecutor(
  config: SshServerConfig,
): RemoteExecutorService {
  return new RemoteExecutorService(config);
}
