import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { Transform } from "class-transformer";

export class RemotePathQueryDto {
  @IsOptional()
  @IsString()
  path?: string;
}

export class ReadRemoteFileQueryDto extends RemotePathQueryDto {
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  max_bytes?: number;
}

export class TailRemoteFileQueryDto extends RemotePathQueryDto {
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  lines?: number;
}

export class WriteRemoteFileDto {
  @IsString()
  path!: string;

  @IsString()
  content!: string;

  @IsString()
  checksum!: string;

  @IsString()
  confirmation!: string;
}

export class WriteEnvFileDto {
  @IsString()
  content!: string;

  @IsString()
  checksum!: string;

  @IsString()
  confirmation!: string;
}

export class CompareEnvQueryDto {
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  left!: number;

  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  right!: number;
}

export class CreateResourceNoteDto {
  @IsIn(["project", "environment", "server"])
  resource_type!: "project" | "environment" | "server";

  @IsString()
  resource_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body!: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class UpdateResourceNoteDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class CreateEnvTemplateDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  environment_type?: string;

  @IsArray()
  @IsString({ each: true })
  required_keys!: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secret_keys?: string[];

  @IsOptional()
  @IsObject()
  defaults?: Record<string, unknown>;
}

export class TouchRemotePathDto {
  @IsString()
  @MinLength(1)
  path!: string;

  @IsIn(["file", "directory"])
  type!: "file" | "directory";
}

