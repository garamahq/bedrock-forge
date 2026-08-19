import { IsInt, IsOptional, IsBoolean } from "class-validator";

export class WatcherHeartbeatDto {
  @IsInt()
  server_id!: number;

  @IsOptional()
  @IsInt()
  pid?: number;

  @IsOptional()
  @IsInt()
  active_connections?: number;

  @IsOptional()
  @IsInt()
  failed_logins_10m?: number;

  @IsOptional()
  @IsBoolean()
  cpu_spike?: boolean;

  @IsOptional()
  @IsBoolean()
  memory_spike?: boolean;
}
