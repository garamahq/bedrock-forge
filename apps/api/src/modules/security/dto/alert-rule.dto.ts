import {
  IsString,
  IsBoolean,
  IsOptional,
  IsArray,
  IsInt,
  Min,
  Max,
  IsIn,
} from "class-validator";
import type { SecuritySeverity } from "@bedrock-forge/shared";

const SEVERITY_VALUES: SecuritySeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

export class CreateAlertRuleDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(SEVERITY_VALUES)
  min_severity?: "critical" | "high" | "medium" | "low" | "info";

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categories?: string[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  server_ids?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  channel_ids?: number[];

  @IsOptional()
  @IsBoolean()
  create_incident?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  cooldown_minutes?: number;
}

export class UpdateAlertRuleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(SEVERITY_VALUES)
  min_severity?: "critical" | "high" | "medium" | "low" | "info";

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categories?: string[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  server_ids?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  channel_ids?: number[];

  @IsOptional()
  @IsBoolean()
  create_incident?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  cooldown_minutes?: number;
}
