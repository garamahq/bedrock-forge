import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api-client";

vi.mock("./websocket", () => ({ updateSocketToken: vi.fn() }));

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats an empty successful response as null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 200 })),
    );

    await expect(
      api.get<null>("/environments/10/backup-schedule"),
    ).resolves.toBeNull();
  });
});
