import {
  IsString,
  IsOptional,
  IsInt,
  IsPositive,
  MaxLength,
  IsIn,
  IsBoolean,
  IsObject,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { PaginationQueryDto } from "../../../common/dto/pagination-query.dto";

export class CreateProjectDto {
  @IsString() @MaxLength(100) name!: string;
  @IsInt() @IsPositive() client_id!: number;
  @IsOptional() @IsInt() @IsPositive() hosting_package_id?: number;
  @IsOptional() @IsInt() @IsPositive() support_package_id?: number;
  @IsOptional() @IsIn(["active", "inactive", "archived"]) status?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() links?: any;
  @IsOptional() @IsString() github_repo?: string;
}

export class UpdateProjectDto extends PartialType(CreateProjectDto) {}

export class QueryProjectsDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  client_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  server_id?: number;

  @IsOptional()
  @IsString()
  status?: string;
}

export class ArchiveProjectDto {
  @IsOptional()
  @IsBoolean()
  createBackup?: boolean;

  @IsOptional()
  @IsBoolean()
  deleteFromCyberpanel?: boolean;
}

export class RestoreProjectArchiveDto {
  @IsOptional()
  @IsObject()
  environmentBackups?: Record<string, number>;
}

