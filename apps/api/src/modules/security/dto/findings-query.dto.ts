import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { MAX_PAGE_SIZE } from "../../../common/pagination";

export class FindingsQueryDto {
  /** Comma-separated severities: critical,high,medium,low,info */
  @IsOptional()
  @IsString()
  severity?: string;

  /** Comma-separated statuses: new,investigating,acknowledged,remediated,resolved,ignored,false_positive */
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  server_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  environment_id?: number;

  @IsOptional()
  @IsString()
  scan_type?: string;

  /** If true, include acknowledged findings; if false (default), exclude them */
  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  acknowledged?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
