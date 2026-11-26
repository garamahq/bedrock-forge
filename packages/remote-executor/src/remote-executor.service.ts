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

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Invoke an optional sync or async progress callback while binding any thrown
 * error or returned promise rejection to the surrounding transfer lifecycle.
 */
function invokeProgressCallback(
  onProgress: ((bytes: number) => Promise<void> | void) | undefined,
  bytes: number,
  pendingProgress: Set<Promise<void>>,
  onFailure: (err: Error) => void,
): void {
  if (!onProgress) return;
  try {
    const result = onProgress(bytes);
    if (result && typeof (result as PromiseLike<void>).then === "function") {
      const tracked = Promise.resolve(result).catch((err: unknown) => {
        onFailure(toError(err));
      });
      pendingProgress.add(tracked);
      void tracked.finally(() => {
        pendingProgress.delete(tracked);
      });
    }
  } catch (err) {
    onFailure(toError(err));
  }
}

/**
 * Returns true when the SSH server rejects a channel or command request.
 * These failures happen before a command or SFTP stream starts, so the
 * operation is safe to retry once with another connection.
 */
function isRetryableChannelError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message === "Not connected" ||
      err.message.includes("Channel open failure") ||
      err.message.includes("open failed") ||
      err.message === "Unable to exec")
  );
}

export interface ExecuteOptions {
  /**
   * Flat wall-clock timeout (ms). Command is killed after this many ms
   * regardless of output activity. Default: 30 000 ms.
   */
  timeout?: number;
  /**
   * Activity-based idle timeout (ms). The timer resets on every stdout/stderr
   * chunk. If no output arrives for this long the command is considered stalled
   * and is killed. Takes precedence over `timeout` when both are set.
   */
  idleTimeoutMs?: number;
  /**
   * Absolute wall-clock hard cap (ms) used together with `idleTimeoutMs`.
   * When set, the command is killed after `maxTimeoutMs` even if output is
   * still flowing. Prevents unbounded run time for very chatty commands.
   */
  maxTimeoutMs?: number;
  cwd?: string;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  code: number;
  /**
   * True when the SSH channel closed without a numeric exit code (e.g. the
   * process was killed by a signal). The remote state is unknown — retrying
   * the operation blindly may cause data corruption.
   */
  indeterminate?: boolean;
  /**
   * The signal name that terminated the process (e.g. "SIGTERM"), when
   * the channel closed due to a signal rather than a clean exit.
   */
  signal?: string;
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
   *
   * Timeout strategy:
   *   - If `opts.idleTimeoutMs` is set, an activity-based stall timer is used
   *     (resets on every stdout/stderr chunk). `opts.maxTimeoutMs` can be set
   *     alongside it as an absolute hard cap.
   *   - Otherwise `opts.timeout` is used as a flat wall-clock timeout.
   *
   * When the SSH channel closes with a signal (null exit code), the result
   * carries `indeterminate: true` and the `signal` name so callers can
   * distinguish safe retries from dangerous ones.
   */
  async execute(
    command: string,
    opts: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const { idleTimeoutMs, maxTimeoutMs, timeout = 30_000 } = opts;
    return this.withConnection((client) =>
      this.runCommand(client, command, timeout, idleTimeoutMs, maxTimeoutMs),
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
    onProgress?: (bytes: number) => Promise<void> | void,
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
   * @param fileMode    optional POSIX file mode (default 0o644)
   */
  async pushFileFromStream(
    remotePath: string,
    readable: Readable,
    timeoutMs: number = SFTP_STALL_TIMEOUT_MS,
    onProgress?: (bytes: number) => Promise<void> | void,
    fileMode?: number,
  ): Promise<void> {
    return this.withConnection((client) =>
      this.sftpPutFromStream(
        client,
        remotePath,
        readable,
        timeoutMs,
        onProgress,
        fileMode,
      ),
    );
  }

  /**
   * Acquire a connection from the pool, run `fn`, and release it back.
   * If `fn` cannot open a command/SFTP channel on a stale connection, evict
   * it and retry once before any remote operation has started.
   */
  private async withConnection<T>(
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const serverKey = `${this.config.host}:${this.config.port}`;
    const client = await this.pool.getConnection(serverKey, this.config);
    try {
      return await fn(client);
    } catch (err) {
      if (isRetryableChannelError(err)) {
        // The remote operation did not start because the SSH channel/request
        // was rejected. Evict this connection and retry once on another one.
        this.pool.destroyConnection(serverKey, client);
        const fresh = await this.pool.getConnection(serverKey, this.config);
        try {
          return await fn(fresh);
        } catch (retryErr) {
          if (isRetryableChannelError(retryErr)) {
            this.pool.destroyConnection(serverKey, fresh);
          }
          if (
            retryErr instanceof Error &&
            retryErr.message === "Unable to exec"
          ) {
            throw new Error(
              "SSH server rejected the remote command request after one reconnect attempt.",
              { cause: retryErr },
            );
          }
          throw retryErr;
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
    idleTimeoutMs?: number,
    maxTimeoutMs?: number,
  ): Promise<ExecuteResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      // Keep a reference so the timeout handler can close the channel.
      let channelRef: Parameters<Parameters<Client["exec"]>[1]>[1] | null =
        null;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(flatTimer);
          clearTimeout(idleTimer);
          clearTimeout(maxTimer);
          fn();
        }
      };

      // ── Flat / max wall-clock timer ────────────────────────────────────────
      let flatTimer: ReturnType<typeof setTimeout> | undefined;
      let maxTimer: ReturnType<typeof setTimeout> | undefined;

      const killChannel = () => {
        try {
          channelRef?.destroy();
        } catch (_) {
          // ignore
        }
      };

      if (!idleTimeoutMs) {
        // Classic flat timeout
        flatTimer = setTimeout(() => {
          killChannel();
          settle(() =>
            reject(
              new Error(
                `Command timed out after ${timeout}ms: ${command.slice(0, 100)}`,
              ),
            ),
          );
        }, timeout);
      } else {
        // Activity-based idle timeout — reset on every output chunk
        if (maxTimeoutMs) {
          maxTimer = setTimeout(() => {
            killChannel();
            settle(() =>
              reject(
                new Error(
                  `Command exceeded max timeout of ${maxTimeoutMs}ms: ${command.slice(0, 100)}`,
                ),
              ),
            );
          }, maxTimeoutMs);
        }
      }

      // ── Idle timer (activity-based) ────────────────────────────────────────
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const resetIdle = () => {
        if (!idleTimeoutMs) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          killChannel();
          settle(() =>
            reject(
              new Error(
                `Command idle timeout after ${idleTimeoutMs}ms with no output: ${command.slice(0, 100)}`,
              ),
            ),
          );
        }, idleTimeoutMs);
      };

      if (idleTimeoutMs) resetIdle(); // start immediately

      client.exec(command, (err, stream) => {
        if (err) {
          settle(() => reject(err));
          return;
        }
        channelRef = stream;

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
          resetIdle();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
          resetIdle();
        });

        stream.on("close", (code: number | null, receivedSignal?: string) => {
          if (code === null || code === undefined || Boolean(receivedSignal)) {
            // SSH channel closed without a numeric exit code or terminated by a
            // signal — the remote outcome is unknown. Mark indeterminate so
            // callers avoid blind retries on state-mutating scripts.
            const normalizedCode = code !== null && code !== undefined && code !== 0 ? code : 1;
            settle(() =>
              resolve({
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                code: normalizedCode,
                indeterminate: true,
                signal: receivedSignal ?? undefined,
              }),
            );
          } else {
            settle(() =>
              resolve({
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                code,
              }),
            );
          }
        });

        stream.on("error", (err: Error) => {
          settle(() => reject(err));
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
    onProgress?: (bytes: number) => Promise<void> | void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sftpRef: SFTPWrapper | null = null;
      let readStreamRef: SftpReadStream | null = null;
      let writeStreamRef: ReturnType<typeof createWriteStream> | null = null;
      const pendingProgress = new Set<Promise<void>>();
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
        if (settled) {
          try {
            sftp.end();
          } catch (_) {}
          return;
        }
        sftpRef = sftp;

        const readStream = sftp.createReadStream(remotePath);
        readStreamRef = readStream;
        const writeStream = createWriteStream(localPath);
        writeStreamRef = writeStream;
        let totalBytes = 0;

        readStream.on("data", (chunk: Buffer) => {
          if (settled) return;
          totalBytes += chunk.length;
          resetStall(); // transfer is alive — postpone stall deadline
          invokeProgressCallback(onProgress, totalBytes, pendingProgress, (progressErr) => {
            settle(() => reject(progressErr));
          });
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
        // Wait for any in-flight async progress checks before resolving so
        // late progress rejections still fail the transfer cleanly.
        writeStream.on("close", () => {
          void Promise.allSettled([...pendingProgress]).then(() => {
            settle(() => {
              resolve();
            });
          });
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Pipe a Readable stream into a remote SFTP write stream.
   * Streaming from rclone stdout into SSH SFTP — no local temp files.
   * @param onProgress optional sync/async callback with cumulative bytes pushed
   * @param fileMode   optional POSIX file mode (default 0o644). Use 0o600 for
   *                   credential files or sensitive uploads.
   */
  private sftpPutFromStream(
    client: Client,
    remotePath: string,
    readable: Readable,
    timeoutMs: number,
    onProgress?: (bytes: number) => Promise<void> | void,
    fileMode?: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let sftpRef: SFTPWrapper | null = null;
      let writeStreamRef: SftpWriteStream | null = null;
      const pendingProgress = new Set<Promise<void>>();
      let onDataHandler: ((chunk: Buffer) => void) | null = null;

      const onReadableError = (e: Error) => {
        settle(() => {
          reject(e);
        });
      };

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(stallTimer);
          if (onDataHandler) {
            readable.removeListener("data", onDataHandler);
          }
          readable.removeListener("error", onReadableError);
          if (writeStreamRef && typeof readable.unpipe === "function") {
            try {
              readable.unpipe(writeStreamRef);
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

      // Bind readable error listener before async client.sftp() callback so
      // errors emitted before SFTP opens cannot become unhandled.
      readable.on("error", onReadableError);

      client.sftp((err, sftp) => {
        if (err) return settle(() => reject(err));
        if (settled) {
          try {
            sftp.end();
          } catch (_) {}
          return;
        }
        sftpRef = sftp;

        const writeStream = sftp.createWriteStream(remotePath, {
          mode: fileMode ?? 0o644,
        });
        writeStreamRef = writeStream;
        let totalBytes = 0;

        onDataHandler = (chunk: Buffer) => {
          if (settled) return;
          totalBytes += chunk.length;
          resetStall(); // transfer is alive — postpone stall deadline
          invokeProgressCallback(onProgress, totalBytes, pendingProgress, (progressErr) => {
            settle(() => reject(progressErr));
          });
        };

        readable.on("data", onDataHandler);

        writeStream.on("error", (e: Error) => {
          settle(() => {
            reject(e);
          });
        });

        // 'close' fires after all bytes are flushed to the remote fd.
        // Wait for any in-flight async progress checks before resolving so
        // late cancellation/progress errors fail the transfer rather than resolving.
        writeStream.on("close", () => {
          void Promise.allSettled([...pendingProgress]).then(() => {
            settle(() => {
              resolve();
            });
          });
        });

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
