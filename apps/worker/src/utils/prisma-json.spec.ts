import { Prisma } from "@prisma/client";
import { toPrismaJsonValue } from "./prisma-json";

describe("toPrismaJsonValue", () => {
  it("keeps valid falsy JSON values intact", () => {
    expect(toPrismaJsonValue(false)).toBe(false);
    expect(toPrismaJsonValue(0)).toBe(0);
    expect(toPrismaJsonValue("")).toBe("");
    expect(toPrismaJsonValue(null)).toBe(Prisma.JsonNull);
  });

  it("converts nested JSON values and omits undefined object properties", () => {
    expect(
      toPrismaJsonValue({ enabled: false, empty: null, ignored: undefined, values: [0, "x"] }),
    ).toEqual({ enabled: false, empty: null, values: [0, "x"] });
  });

  it("rejects values that cannot be stored as JSON", () => {
    expect(() => toPrismaJsonValue(Number.NaN)).toThrow("JSON numbers must be finite");
    expect(() => toPrismaJsonValue(() => "not JSON")).toThrow("Value is not valid JSON data");
  });
});
