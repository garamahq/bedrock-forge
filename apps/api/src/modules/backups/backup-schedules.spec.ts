import { BadRequestException } from "@nestjs/common";
import { JOB_TYPES, QUEUES } from "@bedrock-forge/shared";
import { BackupSchedulesService } from "./backup-schedules.service";
import { SystemBackupScheduleService } from "../system-backups/system-backup-schedule.service";
import { JobExecutionsRepository } from "../job-executions/job-executions.repository";
import { BackupsService } from "./backups.service";

describe("Phase 6B Schedule lifecycle, status guard, and restore validation (#29, #39, #50)", () => {
  it("BackupSchedulesService uses upsertJobScheduler/removeJobScheduler and propagates Redis failures (#29)", async () => {
    const repo = {
      findByEnvironment: jest.fn(),
      upsert: jest.fn().mockResolvedValue({ id: BigInt(5) }),
      delete: jest.fn(),
    };
    const envSvc = { existsById: jest.fn().mockResolvedValue(true) };
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue({ id: "next-job" }),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      getRepeatableJobs: jest.fn().mockResolvedValue([
        // BullMQ v5 returns metadata WITHOUT id field!
        { key: "backup:scheduled:backup-schedule-5:::0 3 * * *", name: JOB_TYPES.BACKUP_SCHEDULED },
      ]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(true),
      add: jest.fn(),
    };

    const svc = new BackupSchedulesService(repo as never, envSvc as never, queue as never);

    await svc.upsert(10, {
      type: "full",
      frequency: "daily",
      hour: 3,
      minute: 0,
      enabled: true,
    });

    expect(queue.removeJobScheduler).toHaveBeenCalledWith("backup-schedule-5");
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "backup-schedule-5",
      { pattern: "0 3 * * *" },
      expect.objectContaining({
        name: JOB_TYPES.BACKUP_SCHEDULED,
        data: { scheduleId: 5, environmentId: 10, type: "full" },
      }),
    );
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith(
      "backup:scheduled:backup-schedule-5:::0 3 * * *",
    );

    // Modifying timing replaces via remove + upsert and disabling removes without re-adding
    await svc.upsert(10, {
      type: "full",
      frequency: "daily",
      hour: 4,
      minute: 15,
      enabled: false,
    });
    expect(queue.removeJobScheduler).toHaveBeenLastCalledWith("backup-schedule-5");
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);

    // Redis failure must not be silently swallowed
    queue.removeJobScheduler.mockRejectedValueOnce(new Error("ECONNREFUSED redis"));
    await expect(
      svc.upsert(10, {
        type: "full",
        frequency: "daily",
        hour: 4,
        minute: 15,
        enabled: true,
      }),
    ).rejects.toThrow("ECONNREFUSED redis");
  });

  it("SystemBackupScheduleService uses upsertJobScheduler/removeJobScheduler and propagates Redis failures (#29)", async () => {
    const repo = {
      findSchedule: jest.fn().mockResolvedValue({ id: BigInt(1) }),
      upsertSchedule: jest.fn().mockResolvedValue({ id: BigInt(1) }),
      deleteSchedule: jest.fn(),
    };
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue({ id: "sys-next" }),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn(),
      add: jest.fn(),
    };

    const svc = new SystemBackupScheduleService(repo as never, queue as never);
    await svc.upsert({
      frequency: "hourly",
      hour: 0,
      minute: 15,
      enabled: true,
    });

    expect(queue.removeJobScheduler).toHaveBeenCalledWith("system-backup-schedule-1");
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "system-backup-schedule-1",
      { pattern: "15 * * * *" },
      expect.objectContaining({
        name: JOB_TYPES.SYSTEM_BACKUP_SCHEDULED,
        data: { scheduleId: 1 },
      }),
    );

    queue.removeJobScheduler.mockRejectedValueOnce(new Error("Redis READONLY"));
    await expect(svc.remove()).rejects.toThrow("Redis READONLY");
  });

  it("JobExecutionsRepository.updateStatusByBullJobId never overwrites terminal status with completed (#39)", async () => {
    const prisma = {
      jobExecution: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const repo = new JobExecutionsRepository(prisma as never);

    await repo.updateStatusByBullJobId("bull-1", QUEUES.BACKUPS, "completed");

    expect(prisma.jobExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bull_job_id: "bull-1",
          queue_name: QUEUES.BACKUPS,
          status: { in: ["queued", "active"] },
        }),
      }),
    );
  });

  it("BackupsService.enqueueRestore rejects incomplete or invalid-path backups and accepts valid legacy & Sync formats (#50)", async () => {
    const repo = {
      findById: jest.fn(),
      findEnvironment: jest.fn().mockResolvedValue({ id: BigInt(1), project_id: BigInt(1) }),
      hasActiveJob: jest.fn().mockResolvedValue(false),
      createJobExecution: jest.fn().mockResolvedValue({ id: BigInt(50) }),
    };
    const queue = { add: jest.fn().mockResolvedValue({ id: "restore-1" }) };
    const svc = new BackupsService(repo as never, queue as never);

    // 1. Failed backup without file_path
    repo.findById.mockResolvedValueOnce({
      id: BigInt(1),
      environment_id: BigInt(1),
      status: "failed",
      file_path: null,
    });
    await expect(svc.enqueueRestore({ backupId: 1 })).rejects.toThrow(BadRequestException);

    // 2. Pending backup
    repo.findById.mockResolvedValueOnce({
      id: BigInt(2),
      environment_id: BigInt(1),
      status: "pending",
      file_path: "gdrive:folder123/site.tar.gz",
    });
    await expect(svc.enqueueRestore({ backupId: 2 })).rejects.toThrow(BadRequestException);

    // 3. Completed backup with placeholder 'temp' / unsupported extension / non-gdrive path
    repo.findById.mockResolvedValueOnce({
      id: BigInt(3),
      environment_id: BigInt(1),
      status: "completed",
      file_path: "temp",
    });
    await expect(svc.enqueueRestore({ backupId: 3 })).rejects.toThrow(BadRequestException);

    repo.findById.mockResolvedValueOnce({
      id: BigInt(4),
      environment_id: BigInt(1),
      status: "completed",
      file_path: "gdrive:folder123/archive.zip",
    });
    await expect(svc.enqueueRestore({ backupId: 4 })).rejects.toThrow(BadRequestException);
    expect(repo.createJobExecution).not.toHaveBeenCalled();

    // 4. Valid Sync safety backup (.sql)
    repo.findById.mockResolvedValueOnce({
      id: BigInt(5),
      environment_id: BigInt(1),
      status: "completed",
      file_path: "gdrive:folder123/sync-safety-2026-11-26.sql",
    });
    await expect(svc.enqueueRestore({ backupId: 5 })).resolves.toEqual({
      jobExecutionId: BigInt(50),
      bullJobId: "restore-1",
    });

    // 5. Valid legacy Drive backup (.tar.gz without size_bytes)
    repo.findById.mockResolvedValueOnce({
      id: BigInt(6),
      environment_id: BigInt(1),
      status: "completed",
      file_path: "gdrive:folder123/legacy_site_2025.tar.gz",
      size_bytes: null,
    });
    await expect(svc.enqueueRestore({ backupId: 6 })).resolves.toEqual({
      jobExecutionId: BigInt(50),
      bullJobId: "restore-1",
    });
  });
});
