import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function toPrismaJsonChild(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BadRequestException("JSON numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPrismaJsonChild(item));
  }
  if (isRecord(value)) {
    const json: { [key: string]: Prisma.InputJsonValue | null } = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) json[key] = toPrismaJsonChild(item);
    }
    return json;
  }
  throw new BadRequestException("Value is not valid JSON data");
}

export function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) {
    throw new BadRequestException("Job payload must not be null or undefined");
  }
  const converted = toPrismaJsonChild(value);
  if (converted === null) {
    throw new BadRequestException("Job payload must not be null");
  }
  return converted;
}

export function toJobPayloadRecord(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BadRequestException("Job payload must be a JSON object");
  }
  return value;
}
