const queueAddMock = jest.fn();
const queueCloseMock = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => ({
  ...jest.requireActual("bullmq"),
  Queue: jest.fn().mockImplementation(() => ({
    add: queueAddMock,
    close: queueCloseMock,
  })),
}));

import type { Job } from "bullmq";
import { PluginUpdateProcessor } from "./plugin-update.processor";

function makePrisma(overrides: Record<string, unknown> = {}) {
  const execUpdate = jest.fn().mockResolvedValue({});
  const backupUpdate = jest.fn().mockResolvedValue({});
  const execCreate = jest.fn().mockResolvedValue({ id: BigInt(101) });
  const backupCreate = jest.fn().mockResolvedValue({ id: BigInt(202) });

  return {
    pluginUpdateSchedule: {
      findUnique: jest.fn().mockResolvedValue({
        id: BigInt(1),
        enabled: true,
        auto_update_mode: "all",
      }),
    },
    pluginScan: {
      findFirst: jest.fn().mockResolvedValue({
        plugins: { is_bedrock: true, plugins: [] },
      }),
    },
    environment: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: BigInt(10),
        type: "staging",
        root_path: "/home/site/public_html",
        google_drive_folder_id: "folder-1",
        wp_layout: "bedrock",
        server: { id: BigInt(1), ip_address: "192.0.2.10" },
        project: { id: BigInt(2), name: "Site A" },
      }),
    },
    jobExecution: {
      create: execCreate,
      update: execUpdate,
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: BigInt(101), status: "completed" }),
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
    ...overrides,
  };
}

describe("PluginUpdateProcessor pre-flight safety backup (#43)", () => {
  beforeEach(() => {
    queueAddMock.mockReset();
    queueCloseMock.mockReset();
    queueCloseMock.mockResolvedValue(undefined);
  });

  it("pre-allocates bull_job_id, creates backup as pending (not running/temp), and fails both records when Redis add rejects", async () => {
    const prisma = makePrisma();
    queueAddMock.mockRejectedValueOnce(new Error("Redis ECONNREFUSED"));

    const processor = new PluginUpdateProcessor(
      prisma as never,
      { get: jest.fn().mockReturnValue("redis://localhost:6379") } as never,
      {} as never,
      {} as never,
      {} as never,
      { add: jest.fn().mockResolvedValue({}) } as never,
    );

    const job = {
      id: "pu-1",
      name: "plugin:update-scheduled",
      data: { scheduleId: 1, environmentId: 10, jobExecutionId: 99 },
      updateProgress: jest.fn().mockResolvedValue(undefined),
    } as unknown as Job;

    await expect(processor.process(job)).rejects.toThrow("Redis ECONNREFUSED");

    expect(prisma.jobExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bull_job_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          status: "queued",
        }),
      }),
    );
    expect(prisma.backup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending",
          job_execution_id: BigInt(101),
        }),
      }),
    );
    const createdBackupData = prisma.backup.create.mock.calls[0][0].data;
    expect(createdBackupData.file_path).not.toBe("temp");

    expect(prisma.jobExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(101) },
        data: expect.objectContaining({
          status: "failed",
          last_error: expect.stringContaining("Redis ECONNREFUSED"),
        }),
      }),
    );
    expect(prisma.backup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(202) },
        data: expect.objectContaining({
          status: "failed",
          error_message: expect.stringContaining("Redis ECONNREFUSED"),
        }),
      }),
    );
    expect(queueCloseMock).toHaveBeenCalled();
  });
});
