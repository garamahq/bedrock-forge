import { Logger } from "@nestjs/common";
import { StepTracker } from "./step-tracker";
import { PrismaService } from "../prisma/prisma.service";

describe("StepTracker", () => {
  it("persists numeric job progress for the API", async () => {
    const prisma = {
      jobExecution: { update: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const job = {
      id: "job-1",
      updateProgress: jest.fn().mockResolvedValue(undefined),
    };
    const logger = { warn: jest.fn() } as unknown as Logger;
    const tracker = new StepTracker(prisma, 42n, logger, job);

    await tracker.updateProgress({ value: 55, step: "Database dump uploaded" });

    expect(job.updateProgress).toHaveBeenCalledWith({
      value: 55,
      step: "Database dump uploaded",
    });
    expect(prisma.jobExecution.update).toHaveBeenCalledWith({
      where: { id: 42n },
      data: { progress: 55 },
    });
  });

  it("keeps the job running when progress persistence fails", async () => {
    const prisma = {
      jobExecution: {
        update: jest.fn().mockRejectedValue(new Error("database unavailable")),
      },
    } as unknown as PrismaService;
    const job = {
      id: "job-1",
      updateProgress: jest.fn().mockResolvedValue(undefined),
    };
    const logger = { warn: jest.fn() } as unknown as Logger;
    const tracker = new StepTracker(prisma, 42n, logger, job);

    await expect(tracker.updateProgress(60)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      "[job-1] Progress persistence failed: database unavailable",
    );
  });
});
