import { Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import type { Request, Response } from "express";
import { parseGdriveFilePath } from "@bedrock-forge/shared";

export interface StreamRcloneDownloadOptions {
  req: Request;
  res: Response;
  filePath: string;
  sizeBytes?: bigint | number | null;
  ensureConfig: () => Promise<{
    configPath: string;
    remoteName: string;
    dbValueSnapshot: string;
  }>;
  syncRefreshedConfig: (snapshot: string) => Promise<void>;
  logger: Logger;
}

/**
 * Provision the current rclone config from PostgreSQL and stream a GDrive archive
 * directly to the HTTP response:
 * - Waits for the first chunk before committing 200 OK headers so immediate rclone failures return HTTP 502.
 * - Sets Content-Length when known and destroys the response mid-stream on error or byte-count mismatch so clients detect truncated downloads.
 * - Terminates the spawned rclone child process if the client disconnects early.
 */
export async function streamRcloneDownloadToResponse(
  opts: StreamRcloneDownloadOptions,
): Promise<void> {
  const { req, res, filePath, sizeBytes, ensureConfig, syncRefreshedConfig, logger } = opts;

  const { folderId, filename } = parseGdriveFilePath(filePath);
  const { configPath, remoteName, dbValueSnapshot } = await ensureConfig();

  const expectedBytes =
    sizeBytes !== null && sizeBytes !== undefined ? Number(sizeBytes) : null;
  const safeFilename = filename.replace(/["|\\\r\n]/g, "_");

  await new Promise<void>((resolve) => {
    const child = spawn(
      "rclone",
      [
        "cat",
        "--config",
        configPath,
        "--drive-root-folder-id",
        folderId,
        `${remoteName}:${filename}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    let headersCommitted = false;
    let bytesSent = 0;
    const stderrChunks: string[] = [];

    const cleanup = () => {
      req.off("close", onClientDisconnect);
      child.stdout.off("data", onStdoutData);
      child.stdout.off("end", onStdoutEnd);
      child.off("error", onChildError);
      child.off("close", onChildClose);
    };

    const commitHeaders = () => {
      if (headersCommitted) return;
      headersCommitted = true;
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFilename}"`,
      );
      res.setHeader("Content-Type", "application/octet-stream");
      if (expectedBytes !== null && Number.isFinite(expectedBytes) && expectedBytes >= 0) {
        res.setHeader("Content-Length", String(expectedBytes));
      }
    };

    const abortDownload = (errMsg: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.error(`rclone download aborted: ${errMsg}`);
      if (!headersCommitted && !res.headersSent) {
        res.status(502).json({
          message: "Failed to stream backup archive from Google Drive",
          error: errMsg,
        });
      } else if (!res.destroyed && !res.writableEnded) {
        res.destroy(new Error(errMsg));
      }
      resolve();
    };

    const onClientDisconnect = () => {
      if (!settled && !res.writableFinished) {
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        resolve();
      }
    };

    const onStdoutData = (chunk: Buffer) => {
      if (settled) return;
      commitHeaders();
      bytesSent += chunk.length;
      if (!res.write(chunk)) {
        child.stdout.pause();
        res.once("drain", () => {
          if (!settled) child.stdout.resume();
        });
      }
    };

    let stdoutEnded = false;
    let exitCode: number | null | undefined;

    const tryComplete = () => {
      if (settled || !stdoutEnded || exitCode === undefined) return;
      const stderrMsg = stderrChunks.join("").trim();
      if (exitCode !== 0) {
        abortDownload(
          stderrMsg || `rclone cat exited with status ${String(exitCode)}`,
        );
        return;
      }
      if (expectedBytes !== null && expectedBytes > 0 && bytesSent !== expectedBytes) {
        abortDownload(
          `Truncated backup stream: expected ${expectedBytes} bytes, received ${bytesSent} bytes`,
        );
        return;
      }

      commitHeaders();
      settled = true;
      cleanup();
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
      void syncRefreshedConfig(dbValueSnapshot).catch(() => undefined);
      resolve();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      tryComplete();
    };

    const onChildError = (err: Error) => {
      abortDownload(err.message);
    };

    const onChildClose = (code: number | null) => {
      exitCode = code;
      // On premature close where stdout hasn't emitted end (e.g. abrupt failure), fail cleanly
      if (code !== 0) {
        abortDownload(
          stderrChunks.join("").trim() || `rclone cat exited with code ${String(code)}`,
        );
        return;
      }
      tryComplete();
    };

    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      if (stderrChunks.length < 20) stderrChunks.push(text);
    });

    req.on("close", onClientDisconnect);
    child.stdout.on("data", onStdoutData);
    child.stdout.on("end", onStdoutEnd);
    child.on("error", onChildError);
    child.on("close", onChildClose);
  });
}
