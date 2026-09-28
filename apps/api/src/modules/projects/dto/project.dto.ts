import {
  IsString,
  IsOptional,
  IsInt,
  IsPositive,
  MaxLength,
  IsIn,
  IsBoolean,
  IsObject,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  ValidateIf,
  IsUrl,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { PaginationQueryDto } from "../../../common/dto/pagination-query.dto";

export class ProjectLinkDto {
  @IsString()
  @MaxLength(120)
  label!: string;

  @ValidateIf((link: ProjectLinkDto) => link.isText !== true)
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  url?: string;

  @ValidateIf((link: ProjectLinkDto) => link.isText === true)
  @IsString()
  @MaxLength(4000)
  value?: string;

  @IsOptional()
  @IsBoolean()
  isText?: boolean;
}

export function projectLinksJson(
  links?: ProjectLinkDto[],
): import("@prisma/client").Prisma.InputJsonArray | undefined {
  return links?.map((link) => ({
    label: link.label,
    ...(link.url !== undefined ? { url: link.url } : {}),
    ...(link.value !== undefined ? { value: link.value } : {}),
    ...(link.isText !== undefined ? { isText: link.isText } : {}),
  }));
}

export class CreateProjectDto {
  @IsString() @MaxLength(100) name!: string;
  @IsInt() @IsPositive() client_id!: number;
  @IsOptional() @IsInt() @IsPositive() hosting_package_id?: number;
  @IsOptional() @IsInt() @IsPositive() support_package_id?: number;
  @IsOptional() @IsIn(["active", "inactive", "archived"]) status?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProjectLinkDto)
  links?: ProjectLinkDto[];
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
