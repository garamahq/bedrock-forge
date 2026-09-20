import { IsBoolean, IsIn, IsOptional } from "class-validator";

const SECURE_GUARD_PRESETS = [
  "beginner",
  "balanced",
  "maximum",
  "custom",
] as const;
export type SecureGuardPreset = (typeof SECURE_GUARD_PRESETS)[number];

export class InstallSecureGuardDto {
  @IsOptional()
  @IsIn(SECURE_GUARD_PRESETS)
  preset?: SecureGuardPreset;

  @IsOptional()
  @IsBoolean()
  deployWatchdog?: boolean;
}
