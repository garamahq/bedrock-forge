import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

const VALID_QUEUES = [
  "backups",
  "plugin-scans",
  "sync",
  "monitors",
  "domains",
  "projects",
  "notifications",
  "reports",
];

const VALID_STATUSES = [
  "queued",
  "active",
  "completed",
  "failed",
  "dead_letter",
  "discarded",
];

export class QueryJobExecutionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  job_id?: number;

  @IsOptional()
  @IsString()
  @IsIn(VALID_QUEUES)
  queue_name?: string;

  @IsOptional()
  @IsString()
  job_type?: string;

  @IsOptional()
  @IsString()
  @IsIn(VALID_STATUSES)
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  environment_id?: number;

  /** Comma-separated list of environment IDs, e.g. "1,2,3" */
  @IsOptional()
  @IsString()
  environment_ids?: string;

  @IsOptional()
  @IsDateString()
  date_from?: string;

  @IsOptional()
  @IsDateString()
  date_to?: string;
}
