import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { CronExpression } from "@nestjs/schedule";
import { QUEUES } from "@bedrock-forge/shared";
import { MaintenanceService } from "./maintenance.service";
import { MaintenanceRepository } from "./maintenance.repository";
import { CleanupSchedulesRepository } from "../cleanup-schedules/cleanup-schedules.repository";
import { WpActionsService } from "../wp-actions/wp-actions.service";

describe("MaintenanceService cleanup schedules (#76, #105)", () => {
  let service: MaintenanceService;
  let cleanupRepo: {
    findAllEnabled: jest.Mock;
    updateLastRun: jest.Mock;
  };
  let wpActions: {
    enqueueCleanup: jest.Mock;
  };

  beforeEach(async () => {
    cleanupRepo = {
      findAllEnabled: jest.fn().mockResolvedValue([]),
      updateLastRun: jest.fn().mockResolvedValue({}),
    };
    wpActions = {
      enqueueCleanup: jest.fn().mockResolvedValue({}),
    };

    const module = await Test.createTestingModule({
      providers: [
        MaintenanceService,
        { provide: MaintenanceRepository, useValue: {} },
        { provide: CleanupSchedulesRepository, useValue: cleanupRepo },
        { provide: WpActionsService, useValue: wpActions },
        {
          provide: getQueueToken(QUEUES.MONITORS),
          useValue: { getRepeatableJobs: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getQueueToken(QUEUES.BACKUPS),
          useValue: { getRepeatableJobs: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getQueueToken(QUEUES.PLUGIN_UPDATES),
          useValue: { getRepeatableJobs: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = module.get(MaintenanceService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("configures runCleanupSchedules cron to run every minute so non-:00 minutes fire in UTC (#76)", () => {
    const cronMeta = Reflect.getMetadata(
      "SCHEDULE_CRON_OPTIONS",
      MaintenanceService.prototype.runCleanupSchedules,
    ) as { cronTime?: string } | undefined;
    expect(cronMeta?.cronTime).toBe(CronExpression.EVERY_MINUTE);
  });

  it.each([0, 15, 30, 59])(
    "fires daily schedule at UTC minute %i without double-firing (#76)",
    async (minute) => {
      jest.useFakeTimers();

      const schedule = {
        environment_id: BigInt(10),
        enabled: true,
        frequency: "daily",
        hour: 3,
        minute,
        day_of_week: null,
        day_of_month: null,
        keep_revisions: 3,
        last_run_at: null as Date | null,
      };
      cleanupRepo.findAllEnabled.mockImplementation(async () => [schedule]);
      cleanupRepo.updateLastRun.mockImplementation(
        async (_envId: bigint, now: Date) => {
          schedule.last_run_at = now;
        },
      );

      // Tick through all 60 minutes of UTC hour 03
      for (let m = 0; m < 60; m++) {
        jest.setSystemTime(new Date(Date.UTC(2026, 10, 25, 3, m, 0)));
        await service.runCleanupSchedules();
      }

      expect(wpActions.enqueueCleanup).toHaveBeenCalledTimes(1);
      expect(wpActions.enqueueCleanup).toHaveBeenCalledWith(10, false, 3);

      // Re-running on same minute or hour should not duplicate
      jest.setSystemTime(new Date(Date.UTC(2026, 10, 25, 3, minute, 30)));
      await service.runCleanupSchedules();
      expect(wpActions.enqueueCleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("fires weekly and monthly schedules at exact UTC minute without duplicating (#76)", async () => {
    jest.useFakeTimers();

    // 2026-11-25 is Wednesday (UTC day = 3, UTC date = 25)
    const weekly = {
      environment_id: BigInt(21),
      enabled: true,
      frequency: "weekly",
      hour: 4,
      minute: 15,
      day_of_week: 3,
      day_of_month: null,
      keep_revisions: 5,
      last_run_at: null as Date | null,
    };
    const monthly = {
      environment_id: BigInt(22),
      enabled: true,
      frequency: "monthly",
      hour: 4,
      minute: 15,
      day_of_week: null,
      day_of_month: 25,
      keep_revisions: 2,
      last_run_at: null as Date | null,
    };
    cleanupRepo.findAllEnabled.mockResolvedValue([weekly, monthly]);
    cleanupRepo.updateLastRun.mockImplementation(
      async (envId: bigint, now: Date) => {
        if (envId === BigInt(21)) weekly.last_run_at = now;
        if (envId === BigInt(22)) monthly.last_run_at = now;
      },
    );

    jest.setSystemTime(new Date(Date.UTC(2026, 10, 25, 4, 15, 0)));
    await service.runCleanupSchedules();
    expect(wpActions.enqueueCleanup).toHaveBeenCalledTimes(2);

    // Same day next week / next run guard
    jest.setSystemTime(new Date(Date.UTC(2026, 10, 26, 4, 15, 0)));
    await service.runCleanupSchedules();
    expect(wpActions.enqueueCleanup).toHaveBeenCalledTimes(2);
  });

  it("logs diagnostic warning for pre-existing schedules with unsupported frequency (#105)", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2026, 10, 25, 3, 30, 0)));

    const warnSpy = jest.spyOn((service as any).logger, "warn");
    cleanupRepo.findAllEnabled.mockResolvedValue([
      {
        environment_id: BigInt(99),
        enabled: true,
        frequency: "hourly",
        hour: 3,
        minute: 30,
        day_of_week: null,
        day_of_month: null,
        keep_revisions: 3,
        last_run_at: null,
      },
    ]);

    await service.runCleanupSchedules();

    expect(wpActions.enqueueCleanup).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsupported frequency"),
    );
  });
});
