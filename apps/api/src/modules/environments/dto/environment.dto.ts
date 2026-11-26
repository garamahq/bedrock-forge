import {
  IsString,
  IsOptional,
  IsInt,
  IsPositive,
  MaxLength,
  IsUrl,
  IsIn,
  ValidateNested,
  IsArray,
  Matches,
  IsNotEmpty,
  IsEmail,
  MinLength,
  ValidateBy,
} from "class-validator";
import { PartialType } from "@nestjs/mapped-types";
import { Type } from "class-transformer";
import { isValidGoogleDriveFolderId } from "@bedrock-forge/shared";

const ENVIRONMENT_TYPES = ["production", "staging", "development"] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

/**
 * Allowlist for remote filesystem paths used in SSH commands.
 * Prevents shell injection via path traversal or shell metacharacters.
 */
const ABSOLUTE_SAFE_PATH_REGEX =
  /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9/_\-.]+$/;
const TABLE_NAME_REGEX = /^[A-Za-z0-9_$]+$/;
const POST_TYPE_REGEX = /^[A-Za-z0-9_-]+$/;

export class UpsertDbCredentialsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: "dbName may only contain alphanumeric characters and underscores",
  })
  dbName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: "dbUser may only contain alphanumeric characters and underscores",
  })
  dbUser!: string;

  @IsString() @IsNotEmpty() @MaxLength(255) dbPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_.-]+$/, {
    message: "dbHost may only contain alphanumeric characters, underscores, dots, and hyphens",
  })
  dbHost!: string;
}

export class CreateEnvironmentDto {
  @IsInt() @IsPositive() server_id!: number;
  /** Environment type: production | staging | development */
  @IsIn(ENVIRONMENT_TYPES) type!: EnvironmentType;
  @IsUrl() @MaxLength(500) url!: string;
  /**
   * Absolute path to the WordPress root on the remote server.
   * Restricted to alphanumeric, `/`, `_`, `-`, `.` to prevent shell injection.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(ABSOLUTE_SAFE_PATH_REGEX, {
    message:
      "root_path must be an absolute path without traversal and may only contain letters, numbers, slashes, underscores, hyphens, and dots",
  })
  root_path!: string;
  /** Persistent remote path on the server for backup storage */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(ABSOLUTE_SAFE_PATH_REGEX, {
    message:
      "backup_path must be an absolute path without traversal and may only contain letters, numbers, slashes, underscores, hyphens, and dots",
  })
  backup_path?: string;
  /** Google Drive folder ID (or folder URL) for backup destination override per environment */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ValidateBy({
    name: "isGoogleDriveFolderId",
    validator: {
      validate: (value: unknown) =>
        value === "" || isValidGoogleDriveFolderId(value),
      defaultMessage: () =>
        "google_drive_folder_id must be a canonical Google Drive folder ID or drive.google.com folder URL",
    },
  })
  google_drive_folder_id?: string;
  /** DB credentials extracted from the server scan — stored encrypted at creation time */
  @IsOptional()
  @ValidateNested()
  @Type(() => UpsertDbCredentialsDto)
  db_credentials?: UpsertDbCredentialsDto;
  /**
   * WP table names on the TARGET that must not be overwritten during a DB push or clone.
   * The dump excludes these tables; all others are fully replaced (DROP TABLE in dump).
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(TABLE_NAME_REGEX, {
    each: true,
    message:
      "protected_tables entries may only contain letters, numbers, underscores, and dollar signs",
  })
  protected_tables?: string[];

  /**
   * SQL queries run on the TARGET immediately after database import to sanitize/filter/protect data.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sql_protection_queries?: string[];

  /**
   * WP custom post types to be preserved on the TARGET during a DB push or clone.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(POST_TYPE_REGEX, {
    each: true,
    message:
      "protected_post_types entries may only contain letters, numbers, underscores, and hyphens",
  })
  protected_post_types?: string[];
}

export class UpdateEnvironmentDto extends PartialType(CreateEnvironmentDto) {}

export class CreateEnvironmentFullDto {
  /** Target server (must have CyberPanel credentials stored) */
  @IsInt()
  @IsPositive()
  server_id!: number;

  /** Domain name to provision in CyberPanel (e.g. "example.com") */
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  @Matches(/^[a-z0-9]([a-z0-9\-\.]*[a-z0-9])?$/, {
    message: "Domain must be a valid hostname",
  })
  domain!: string;

  /** Admin contact email for CyberPanel provisioning */
  @IsEmail()
  admin_email!: string;

  /** Environment type label */
  @IsOptional()
  @IsIn(ENVIRONMENT_TYPES)
  env_type?: EnvironmentType;

  /** PHP version for the CyberPanel website */
  @IsOptional()
  @IsIn(["8.1", "8.2", "8.3"])
  php_version?: "8.1" | "8.2" | "8.3";

  /** If set, clone this environment's DB + files (instead of fresh Bedrock install) */
  @IsOptional()
  @IsInt()
  @IsPositive()
  source_environment_id?: number;

  // ── User-provided DB credentials (optional — auto-generated if omitted) ──

  /** Database name — auto-generated if not provided */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  db_name?: string;

  /** Database username — auto-generated if not provided */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  db_user?: string;

  /** Database password — auto-generated if not provided */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  db_password?: string;

  /** Database host — defaults to localhost */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  db_host?: string;
}

