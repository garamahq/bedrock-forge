import {
  IsString,
  IsInt,
  IsPositive,
  IsOptional,
  IsIn,
  IsEmail,
  MinLength,
  MaxLength,
  Matches,
} from "class-validator";
import { ArrayMaxSize, IsArray, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { ProjectLinkDto } from "./project.dto";

const PHP_VERSIONS = ["8.1", "8.2", "8.3"] as const;
const ENV_TYPES = ["production", "staging", "development"] as const;

export class CreateProjectFullDto {
  /** Human-readable project name */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  /** Client to attach the project to */
  @IsInt()
  @IsPositive()
  client_id!: number;

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
  @IsIn(ENV_TYPES)
  env_type?: "production" | "staging" | "development";

  /** PHP version for the CyberPanel website */
  @IsOptional()
  @IsIn(PHP_VERSIONS)
  php_version?: "8.1" | "8.2" | "8.3";

  /** Hosting package ID to link to the project */
  @IsOptional()
  @IsInt()
  @IsPositive()
  hosting_package_id?: number;

  /** If set, clone this environment's DB + files (instead of fresh Bedrock install) */
  @IsOptional()
  @IsInt()
  @IsPositive()
  source_environment_id?: number;

  // ── User-provided DB credentials (optional — auto-generated if omitted) ──

  /** Database name — auto-generated as wp_<hex> if not provided */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  db_name?: string;

  /** Database username — auto-generated as u_<hex> if not provided */
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

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProjectLinkDto)
  links?: ProjectLinkDto[];
}
