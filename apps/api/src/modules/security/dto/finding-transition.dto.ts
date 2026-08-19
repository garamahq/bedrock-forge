import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export enum FindingStatusEnum {
  NEW = "new",
  INVESTIGATING = "investigating",
  ACKNOWLEDGED = "acknowledged",
  REMEDIATED = "remediated",
  RESOLVED = "resolved",
  IGNORED = "ignored",
  FALSE_POSITIVE = "false_positive",
}

export class FindingTransitionDto {
  @IsEnum(FindingStatusEnum)
  @IsNotEmpty()
  status!: FindingStatusEnum;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
