import { IsIn } from "class-validator";

export class UpdateIncidentStatusDto {
  @IsIn(["open", "investigating", "contained", "resolved", "false_positive"])
  status!: "open" | "investigating" | "contained" | "resolved" | "false_positive";
}
