import { Prisma } from "@prisma/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPrismaJsonChild(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
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
  throw new TypeError("Value is not valid JSON data");
}

/** Convert untrusted JSON-shaped data to the input form Prisma accepts. */
export function toPrismaJsonValue(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) return Prisma.JsonNull;
  const converted = toPrismaJsonChild(value);
  return converted === null ? Prisma.JsonNull : converted;
}
