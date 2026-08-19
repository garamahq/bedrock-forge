import { IsString, IsIn, IsInt, IsOptional } from "class-validator";

export class PreviewRemediationDto {
  @IsIn(["server", "environment"])
  targetType!: "server" | "environment";

  @IsInt()
  targetId!: number;

  @IsString()
  actionType!: string;

  @IsOptional()
  @IsInt()
  findingId?: number;

  @IsOptional()
  @IsString()
  resource?: string;
}

export class ApplyRemediationDto {
  @IsIn(["server", "environment"])
  targetType!: "server" | "environment";

  @IsInt()
  targetId!: number;

  @IsString()
  actionType!: string;

  @IsOptional()
  @IsInt()
  findingId?: number;

  @IsOptional()
  @IsString()
  resource?: string;
}
