import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  Max,
} from "class-validator";
import { Type } from "class-transformer";

export const CLEANUP_FREQUENCIES = ["daily", "weekly", "monthly"] as const;

export type CleanupFrequency = (typeof CLEANUP_FREQUENCIES)[number];

export class UpsertCleanupScheduleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(CLEANUP_FREQUENCIES, {
    message: "frequency must be one of: daily, weekly, monthly",
  })
  frequency?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(0)
  @Max(23)
  hour?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(0)
  @Max(59)
  minute?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(0)
  @Max(6)
  day_of_week?: number | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(1)
  @Max(28)
  day_of_month?: number | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  keep_revisions?: number;
}
