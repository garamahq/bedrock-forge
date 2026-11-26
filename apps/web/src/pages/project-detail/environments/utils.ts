import { z } from "zod";
import { isValidGoogleDriveFolderId } from "@bedrock-forge/shared";

export const envSchema = z.object({
  type: z.enum(["production", "staging", "development"]),
  server_id: z.coerce
    .number({ invalid_type_error: "Server is required" })
    .positive(),
  url: z.string().url("Must be a valid URL"),
  root_path: z.string().min(1, "Root path is required").max(500),
  backup_path: z.string().max(500).optional().or(z.literal("")),
  google_drive_folder_id: z
    .string()
    .max(500)
    .optional()
    .or(z.literal(""))
    .refine(
      (val) => !val || !val.trim() || isValidGoogleDriveFolderId(val),
      "Must be a valid Google Drive folder ID or drive.google.com folder URL",
    ),
});
export type EnvForm = z.infer<typeof envSchema>;

export const ENV_TYPES = [
  { value: "production", label: "Production" },
  { value: "staging", label: "Staging" },
  { value: "development", label: "Development" },
] as const;

export const TABLE_NAME_REGEX = /^[A-Za-z0-9_$]+$/;
export const POST_TYPE_REGEX = /^[A-Za-z0-9_-]+$/;
export type EnvTypeValue = (typeof ENV_TYPES)[number]["value"];

export const SERVER_STATUS_VARIANT: Record<
  string,
  "success" | "destructive" | "secondary"
> = {
  online: "success",
  offline: "destructive",
  unknown: "secondary",
};

export function parseProtectedPostTypes(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && POST_TYPE_REGEX.test(t)),
    ),
  );
}

export const dbCredsSchema = z.object({
  dbName: z.string().min(1, "Required").max(100),
  dbUser: z.string().min(1, "Required").max(100),
  dbPassword: z.string().min(1, "Required").max(200),
  dbHost: z.string().min(1, "Required").max(255),
});
export type DbCredsForm = z.infer<typeof dbCredsSchema>;
