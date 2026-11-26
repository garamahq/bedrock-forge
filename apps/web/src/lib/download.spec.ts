import { describe, it, expect, vi, beforeEach } from "vitest";
import { triggerAuthenticatedBackupDownload } from "./download";
import { api } from "./api-client";

vi.mock("./api-client", () => ({
  api: {
    post: vi.fn(),
  },
}));

describe("triggerAuthenticatedBackupDownload (#23)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("requests a single-use ticket via authenticated API client and navigates to ?ticket= without JWT in URL", async () => {
    vi.mocked(api.post).mockResolvedValue({ ticket: "opaque-ticket-abc123" });

    const createdLinks: Array<{ href: string; download: string; clicked: boolean; removed: boolean }> = [];
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        const record = { href: "", download: "", rel: "", clicked: false, removed: false };
        createdLinks.push(record);
        return {
          set href(v: string) {
            record.href = v;
          },
          get href() {
            return record.href;
          },
          set download(v: string) {
            record.download = v;
          },
          set rel(v: string) {
            record.rel = v;
          },
          click: () => {
            record.clicked = true;
          },
          remove: () => {
            record.removed = true;
          },
          style: {},
        } as unknown as HTMLAnchorElement;
      }
      return origCreateElement(tag);
    });
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => node);

    await triggerAuthenticatedBackupDownload(
      "/backups/42/download-ticket",
      "/api/backups/42/download",
    );

    expect(api.post).toHaveBeenCalledWith("/backups/42/download-ticket", {});
    expect(createdLinks).toHaveLength(1);
    expect(createdLinks[0].href).toBe("/api/backups/42/download?ticket=opaque-ticket-abc123");
    expect(createdLinks[0].href).not.toContain("eyJ");
    expect(createdLinks[0].clicked).toBe(true);
    expect(createdLinks[0].removed).toBe(true);
  });

  it("propagates 401 unauthorized error without opening a download URL", async () => {
    vi.mocked(api.post).mockRejectedValue(new Error("Unauthorized"));

    await expect(
      triggerAuthenticatedBackupDownload(
        "/system-backups/7/download-ticket",
        "/api/system-backups/7/download",
      ),
    ).rejects.toThrow("Unauthorized");
  });
});
