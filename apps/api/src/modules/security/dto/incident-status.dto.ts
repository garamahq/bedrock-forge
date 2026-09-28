import { IsIn, IsInt, IsOptional, IsPositive } from "class-validator";
import { Type } from "class-transformer";
import { PaginationQueryDto } from "../../../common/dto/pagination-query.dto";

const INCIDENT_STATUSES = [
  "open",
  "investigating",
  "contained",
  "resolved",
  "false_positive",
] as const;

export class UpdateIncidentStatusDto {
  @IsIn(INCIDENT_STATUSES)
  status!: (typeof INCIDENT_STATUSES)[number];
}

export class SecurityIncidentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(INCIDENT_STATUSES)
  status?: (typeof INCIDENT_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  serverId?: number;
}
