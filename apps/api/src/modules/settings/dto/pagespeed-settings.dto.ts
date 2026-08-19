import { IsIn, IsOptional, IsString } from "class-validator";

export class SetPagespeedSettingsDto {
  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsIn(["auto", "local", "pagespeed"])
  provider?: "auto" | "local" | "pagespeed";
}
