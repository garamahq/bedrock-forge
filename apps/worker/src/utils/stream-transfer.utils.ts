import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RemoteExecutorService } from "@bedrock-forge/remote-executor";
import { shellQuote } from "./processor-utils";

export interface StreamDumpTransferOptions {
  sourceExecutor: Pick<RemoteExecutorService, "pullFileToPath" | "execute">;
  targetExecutor: Pick<RemoteExecutorService, "pushFileFromStream" | "execute">;
  sourceRemotePath: string;
  targetRemotePath?: string;
  sourceLabel: string;
  targetLabel: string;
  localDirectoryPrefix?: string;
  onProgress?: (percentOffset: number, step: string) => Promise<void>;
}

async function cleanupRemoteTempFile(
  executor: Pick<RemoteExecutorService, "execute">,
  remotePath: string,
): Promise<void> {
  await executor.execute(`rm -f ${shellQuote(remotePath)}`).catch(() => {});
}

/**
 * Stream a database dump between two remote hosts using bounded worker disk staging
 * (`0o700` temp directory, `0o600` temp dump) instead of buffering the entire dump in memory.
 */
export async function streamDatabaseDumpBetweenServers(
  options: StreamDumpTransferOptions,
): Promise<{ bytesTransferred: number }> {
  const {
    sourceExecutor,
    targetExecutor,
    sourceRemotePath,
    targetRemotePath = sourceRemotePath,
    sourceLabel,
    targetLabel,
    localDirectoryPrefix = "bf-db-transfer-",
    onProgress,
  } = options;

  const localDumpDir = await mkdtemp(join(tmpdir(), localDirectoryPrefix));
  const localDumpPath = join(localDumpDir, basename(sourceRemotePath));
  let targetDumpUploaded = false;

  try {
    await onProgress?.(0, "Downloading database dump from source server");

    try {
      await sourceExecutor.pullFileToPath(sourceRemotePath, localDumpPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Database dump download from source server (${sourceLabel}) failed: ${message}`,
      );
    } finally {
      await cleanupRemoteTempFile(sourceExecutor, sourceRemotePath);
    }

    await chmod(localDumpPath, 0o600);
    const dumpSize = (await stat(localDumpPath)).size;

    await onProgress?.(5, "Uploading database dump to target server");

    try {
      await targetExecutor.pushFileFromStream(
        targetRemotePath,
        createReadStream(localDumpPath),
      );
      targetDumpUploaded = true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Database dump upload to target server (${targetLabel}) failed: ${message}`,
      );
    }

    return { bytesTransferred: dumpSize };
  } finally {
    await rm(localDumpDir, { recursive: true, force: true }).catch(() => {});
    if (!targetDumpUploaded) {
      await cleanupRemoteTempFile(targetExecutor, targetRemotePath);
    }
  }
}
