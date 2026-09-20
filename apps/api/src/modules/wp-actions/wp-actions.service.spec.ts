import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import { WpActionsService } from "./wp-actions.service";
import { WpActionsRepository } from "./wp-actions.repository";
import { ServersService } from "../servers/servers.service";
import { JobOrchestratorService } from "../job-executions/job-orchestrator.service";
import { QUEUES, JOB_TYPES } from "@bedrock-forge/shared";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

import { createRemoteExecutor } from "@bedrock-forge/remote-executor";

describe("WpActionsService", () => {
  let service: WpActionsService;
  let repo: { findEnvironment: jest.Mock };
  let serversService: { getServerSshConfig: jest.Mock };
  let jobOrchestrator: { enqueue: jest.Mock };
  let queue: { add: jest.Mock };
  let mockExecutor: { execute: jest.Mock; pushFile: jest.Mock };

  beforeEach(async () => {
    repo = {
      findEnvironment: jest.fn(),
    };
    serversService = {
      getServerSshConfig: jest.fn().mockResolvedValue({
        host: "127.0.0.1",
        port: 22,
        username: "deploy",
      }),
    };
    jobOrchestrator = {
      enqueue: jest.fn().mockResolvedValue({
        jobExecutionId: 101,
        bullJobId: "bull-1",
      }),
    };
    queue = {
      add: jest.fn(),
    };
    mockExecutor = {
      execute: jest.fn().mockResolvedValue({ code: 0, stdout: "Success", stderr: "" }),
      pushFile: jest.fn().mockResolvedValue(undefined),
    };
    (createRemoteExecutor as jest.Mock).mockReturnValue(mockExecutor);

    const module = await Test.createTestingModule({
      providers: [
        WpActionsService,
        { provide: WpActionsRepository, useValue: repo },
        { provide: ServersService, useValue: serversService },
        { provide: JobOrchestratorService, useValue: jobOrchestrator },
        { provide: getQueueToken(QUEUES.WP_ACTIONS), useValue: queue },
      ],
    }).compile();

    service = module.get<WpActionsService>(WpActionsService);
  });

  describe("runCli", () => {
    it("throws NotFoundException if environment not found", async () => {
      repo.findEnvironment.mockResolvedValue(null);
      await expect(service.runCli(999, { command: "cache flush" })).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequestException if environment has no root_path", async () => {
      repo.findEnvironment.mockResolvedValue({ id: BigInt(1), root_path: null });
      await expect(service.runCli(1, { command: "cache flush" })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws BadRequestException if command contains shell chaining or dangerous tokens", async () => {
      repo.findEnvironment.mockResolvedValue({
        id: BigInt(1),
        root_path: "/var/www/site",
        server: { id: 10 },
      });
      mockExecutor.execute.mockResolvedValue({ code: 0, stdout: "bedrock", stderr: "" });

      await expect(service.runCli(1, { command: "cache flush; rm -rf /" })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.runCli(1, { command: "eval-file hack.php" })).rejects.toThrow(
        BadRequestException,
      );
    });

    it("successfully runs clean wp command stripping leading 'wp ' prefix", async () => {
      repo.findEnvironment.mockResolvedValue({
        id: BigInt(1),
        root_path: "/var/www/site",
        server: { id: 10 },
      });
      mockExecutor.execute
        .mockResolvedValueOnce({ code: 0, stdout: "bedrock", stderr: "" }) // resolveWpPathForStatus
        .mockResolvedValueOnce({ code: 0, stdout: "Success: Cache flushed.", stderr: "" }); // wp command

      const result = await service.runCli(1, { command: "wp cache flush" });
      expect(result.command).toBe("wp cache flush");
      expect(result.stdout).toContain("Success: Cache flushed.");
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("runSearchReplace", () => {
    it("constructs and runs safe wp search-replace with dry-run", async () => {
      repo.findEnvironment.mockResolvedValue({
        id: BigInt(1),
        root_path: "/var/www/site",
        server: { id: 10 },
      });
      mockExecutor.execute
        .mockResolvedValueOnce({ code: 0, stdout: "bedrock", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "50 replacements found", stderr: "" });

      const result = await service.runSearchReplace(1, {
        search: "http://old.com",
        replace: "https://new.com",
        dry_run: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("50 replacements found");
    });
  });

  describe("exportDb", () => {
    it("creates backup dir and runs wp db export", async () => {
      repo.findEnvironment.mockResolvedValue({
        id: BigInt(1),
        root_path: "/var/www/site",
        backup_path: "/var/backups",
        server: { id: 10 },
      });
      mockExecutor.execute
        .mockResolvedValueOnce({ code: 0, stdout: "bedrock", stderr: "" }) // resolveWpPath
        .mockResolvedValueOnce({ code: 0, stdout: "Success: Exported to file", stderr: "" }) // wp db export
        .mockResolvedValueOnce({ code: 0, stdout: "1048576", stderr: "" }); // stat size

      const result = await service.exportDb(1);
      expect(result.success).toBe(true);
      expect(result.filename).toMatch(/^db-snapshot-.*\.sql$/);
      expect(result.sizeBytes).toBe(1048576);
    });
  });

  describe("enqueueFix", () => {
    it("enqueues fix action via JobOrchestrator", async () => {
      repo.findEnvironment.mockResolvedValue({
        id: BigInt(1),
        root_path: "/var/www/site",
        server: { id: 10 },
      });

      const res = await service.enqueueFix(1, { action: "clear_cache" });
      expect(res.jobExecutionId).toBe(101);
      expect(jobOrchestrator.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: QUEUES.WP_ACTIONS,
          jobType: JOB_TYPES.WP_FIX_ACTION,
          payload: { environmentId: 1, action: "clear_cache" },
        }),
      );
    });
  });
});
