/// <reference types="jest" />

const queueAddMock = jest.fn();
const queueCloseMock = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => ({
  ...jest.requireActual("bullmq"),
  Queue: jest.fn().mockImplementation(() => ({
    add: queueAddMock,
    close: queueCloseMock,
  })),
}));

import { PluginScanProcessor } from "./plugin-scan.processor";

function makeProcessor(prisma: any) {
  return new PluginScanProcessor(prisma, {} as any, {} as any) as any;
}

describe("PluginScanProcessor custom plugin reconciliation", () => {
  it("upserts detected monorepo catalog plugins", async () => {
    const prisma = {
      customPlugin: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: BigInt(7),
            slug: "wp-secure-guard",
            repo_url: "git@github.com:satusdev/wp-secure-guard.git",
          },
        ]),
      },
      environmentCustomPlugin: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    const processor = makeProcessor(prisma);

    await processor.reconcileCustomPluginCatalog(BigInt(3), [
      {
        slug: "wp-secure-guard",
        version: "1.0.0",
        managed_by_monorepo: true,
        monorepo_repo_url: "https://github.com/satusdev/wp-secure-guard.git",
        is_mu_plugin: false,
      },
    ]);

    expect(prisma.environmentCustomPlugin.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          environment_id_custom_plugin_id: {
            environment_id: BigInt(3),
            custom_plugin_id: BigInt(7),
          },
        },
        update: { installed_version: "1.0.0" },
      }),
    );
    expect(prisma.environmentCustomPlugin.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes stale custom plugin rows when scan no longer detects them", async () => {
    const prisma = {
      customPlugin: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: BigInt(7),
            slug: "wp-secure-guard",
            repo_url: "git@github.com:satusdev/wp-secure-guard.git",
          },
        ]),
      },
      environmentCustomPlugin: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    const processor = makeProcessor(prisma);

    await processor.reconcileCustomPluginCatalog(BigInt(3), []);

    expect(prisma.environmentCustomPlugin.upsert).not.toHaveBeenCalled();
    expect(prisma.environmentCustomPlugin.deleteMany).toHaveBeenCalledWith({
      where: {
        environment_id: BigInt(3),
        custom_plugin_id: { in: [BigInt(7)] },
      },
    });
  });

  it("allocates pre-flight backup bull_job_id and marks both backup and execution failed when Redis add fails (#43)", async () => {
    queueAddMock.mockReset();
    queueCloseMock.mockReset();
    queueCloseMock.mockResolvedValue(undefined);
    queueAddMock.mockRejectedValueOnce(new Error("Redis timeout"));

    const execCreate = jest.fn().mockResolvedValue({ id: BigInt(50) });
    const execUpdate = jest.fn().mockResolvedValue({});
    const backupCreate = jest.fn().mockResolvedValue({ id: BigInt(60) });
    const backupUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      environment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: BigInt(3),
          google_drive_folder_id: "folder-1",
          server: { id: BigInt(1), ip_address: "192.0.2.3" },
        }),
      },
      jobExecution: {
        create: execCreate,
        update: execUpdate,
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      backup: {
        create: backupCreate,
        update: backupUpdate,
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          jobExecution: { create: execCreate },
          backup: { create: backupCreate },
        }),
      ),
    };
    const processor = new PluginScanProcessor(
      prisma as never,
      { get: jest.fn().mockReturnValue("redis://localhost:6379") } as never,
      {} as never,
    );

    const job = {
      id: "pm-1",
      name: "plugin:manage",
      data: {
        environmentId: 3,
        action: "update",
        plugins: ["akismet"],
        jobExecutionId: 91,
        skipSafetyBackup: false,
      } satisfies Record<string, unknown>,
      updateProgress: jest.fn().mockResolvedValue(undefined),
    };

    await expect(processor.process(job as never)).rejects.toThrow("Redis timeout");

    expect(backupCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          job_execution_id: BigInt(50),
        }),
      }),
    );
    expect(backupUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(60) },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(queueCloseMock).toHaveBeenCalled();
  });
});
