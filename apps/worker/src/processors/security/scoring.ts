import { randomUUID } from "crypto";
import type {
  SecurityFinding,
  SecurityScanSummary,
  SecuritySeverity,
} from "@bedrock-forge/shared";

/**
 * Assigns a score (0-100) based on finding severities.
 * Critical findings are heavily penalised.
 */
export function calculateScore(findings: SecurityFinding[]): number {
  let score = 100;
  for (const f of findings) {
    switch (f.severity) {
      case "critical":
        score -= 20;
        break;
      case "high":
        score -= 10;
        break;
      case "medium":
        score -= 5;
        break;
      case "low":
        score -= 2;
        break;
    }
  }
  return Math.max(0, score);
}

export function buildSummary(findings: SecurityFinding[]): SecurityScanSummary {
  const s: SecurityScanSummary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of findings) s[f.severity]++;
  return s;
}

export function makeFinding(
  severity: SecuritySeverity,
  category: SecurityFinding["category"],
  title: string,
  description: string,
  opts: Partial<
    Omit<
      SecurityFinding,
      "id" | "severity" | "category" | "title" | "description"
    >
  > = {},
): SecurityFinding {
  return { id: randomUUID(), severity, category, title, description, ...opts };
}
