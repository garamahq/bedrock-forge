import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class DeployEnvironmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  commitSha?: string;

  @IsOptional()
  @IsBoolean()
  runComposer?: boolean;

  @IsOptional()
  @IsBoolean()
  updateDb?: boolean;

  @IsOptional()
  @IsBoolean()
  flushCache?: boolean;
}

export class UpdateEnvironmentGitDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  git_remote_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  git_branch?: string;
}
