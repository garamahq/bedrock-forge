import { IsString, Matches } from "class-validator";

export class MfaCodeDto {
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
