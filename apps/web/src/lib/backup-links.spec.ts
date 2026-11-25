import { describe, expect, it } from "vitest";
import { resolveGdriveFolderUrl } from "./backup-links";

describe("resolveGdriveFolderUrl", () => {
  it("extracts folder A from gdrive file_path even when current fallback folder is B", () => {
    expect(
      resolveGdriveFolderUrl("gdrive:folderA/site-2026-01-01.tar.gz", "folderB"),
    ).toBe("https://drive.google.com/drive/folders/folderA");
  });

  it("extracts folder A from gdrive file_path even when fallback folder is removed", () => {
    expect(
      resolveGdriveFolderUrl("gdrive:folderA/site-2026-01-01.tar.gz", null),
    ).toBe("https://drive.google.com/drive/folders/folderA");
  });

  it("extracts folder B for newer records", () => {
    expect(
      resolveGdriveFolderUrl("gdrive:folderB/site-2026-02-01.tar.gz", "folderB"),
    ).toBe("https://drive.google.com/drive/folders/folderB");
  });

  it("handles legacy gdrive folder-only and full Google Drive URLs", () => {
    expect(resolveGdriveFolderUrl("gdrive:legacyFolderA", "folderB")).toBe(
      "https://drive.google.com/drive/folders/legacyFolderA",
    );
    expect(
      resolveGdriveFolderUrl("gdrive://legacyFolderA/archive.tar.gz", "folderB"),
    ).toBe("https://drive.google.com/drive/folders/legacyFolderA");
    expect(
      resolveGdriveFolderUrl(
        "https://drive.google.com/drive/folders/urlFolderA?usp=sharing",
        "folderB",
      ),
    ).toBe("https://drive.google.com/drive/folders/urlFolderA");
  });

  it("falls back to current folder only when legacy record has no file_path", () => {
    expect(resolveGdriveFolderUrl(null, "folderB")).toBe(
      "https://drive.google.com/drive/folders/folderB",
    );
    expect(resolveGdriveFolderUrl("", "folderB")).toBe(
      "https://drive.google.com/drive/folders/folderB",
    );
    expect(resolveGdriveFolderUrl(null, null)).toBeNull();
  });

  it("returns null for unsupported or malformed destinations without falling back", () => {
    expect(resolveGdriveFolderUrl("/tmp/forge-backups/local.tar.gz", "folderB")).toBeNull();
    expect(resolveGdriveFolderUrl("s3://bucket/backup.tar.gz", "folderB")).toBeNull();
    expect(resolveGdriveFolderUrl("gdrive:", "folderB")).toBeNull();
    expect(resolveGdriveFolderUrl("gdrive:///", "folderB")).toBeNull();
  });
});
