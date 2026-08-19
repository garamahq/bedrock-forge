import { IsOptional, IsString, MaxLength } from "class-validator";

export class CreateBaselineDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;
}
