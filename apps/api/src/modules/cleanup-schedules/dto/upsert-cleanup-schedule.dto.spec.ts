import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpsertCleanupScheduleDto } from "./upsert-cleanup-schedule.dto";

describe("UpsertCleanupScheduleDto (#105)", () => {
  it.each(["daily", "weekly", "monthly"])(
    "accepts supported frequency '%s'",
    async (frequency) => {
      const dto = plainToInstance(UpsertCleanupScheduleDto, {
        enabled: true,
        frequency,
        hour: 3,
        minute: 30,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    },
  );

  it.each(["hourly", "biweekly", "quarterly", ""])(
    "rejects unsupported frequency '%s' with a clear validation message",
    async (frequency) => {
      const dto = plainToInstance(UpsertCleanupScheduleDto, {
        enabled: true,
        frequency,
        hour: 3,
        minute: 0,
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      const freqError = errors.find((e) => e.property === "frequency");
      expect(freqError).toBeDefined();
      expect(Object.values(freqError?.constraints ?? {}).join(" ")).toContain(
        "daily, weekly, monthly",
      );
    },
  );
});
