import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupHistoryList } from "./BackupHistoryList";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({ api: apiMocks }));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));

function makeBackup(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "completed",
    file_path: `gdrive:folderA/system-${id}.sql.gz`,
    size_bytes: "2048",
    error_message: null,
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:01:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    jobExecution: null,
    ...overrides,
  };
}

describe("BackupHistoryList (#42, #56)", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.put.mockReset();
    apiMocks.patch.mockReset();
    apiMocks.delete.mockReset();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it("paginates across 21 backups so earlier items on page 2 are reachable", async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/settings/system-backup-folder") {
        return { folder_id: "folderB" };
      }
      if (path === "/system-backups?page=1&limit=20") {
        return {
          items: Array.from({ length: 20 }, (_, i) => makeBackup(i + 1)),
          total: 21,
          page: 1,
          limit: 20,
        };
      }
      if (path === "/system-backups?page=2&limit=20") {
        return {
          items: [
            makeBackup(21, { file_path: "gdrive:folderA/oldest-21.sql.gz" }),
          ],
          total: 21,
          page: 2,
          limit: 20,
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    renderWithProviders(<BackupHistoryList />);

    expect(await screen.findByText("system-1.sql.gz")).toBeVisible();
    expect(screen.getByText("Page 1 of 2")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("oldest-21.sql.gz")).toBeVisible();
    expect(screen.getByText("Page 2 of 2")).toBeVisible();
    expect(apiMocks.get).toHaveBeenCalledWith(
      "/system-backups?page=2&limit=20",
    );
  });

  it("renders a retryable error state on fetch failure instead of the empty list message", async () => {
    let fail = true;
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/settings/system-backup-folder") {
        return { folder_id: "folderB" };
      }
      if (path.startsWith("/system-backups")) {
        if (fail) {
          fail = false;
          throw new Error("database unavailable");
        }
        return { items: [], total: 0, page: 1, limit: 20 };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    renderWithProviders(<BackupHistoryList />);

    expect(
      await screen.findByText("Could not load system backups"),
    ).toBeVisible();
    expect(
      screen.queryByText(/No backups yet/i),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No backups yet/i)).toBeVisible();
  });

  it("opens each backup's recorded Drive folder even after changing or removing the setting", async () => {
    let configuredFolder: string | null = "folderB";
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/settings/system-backup-folder") {
        return { folder_id: configuredFolder };
      }
      if (path.startsWith("/system-backups")) {
        return {
          items: [
            makeBackup(1, { file_path: "gdrive:folderA/old.sql.gz" }),
            makeBackup(2, { file_path: "gdrive:folderB/new.sql.gz" }),
          ],
          total: 2,
          page: 1,
          limit: 20,
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    const firstRender = renderWithProviders(<BackupHistoryList />);

    const buttons = await screen.findAllByTitle("Open Google Drive folder");
    expect(buttons).toHaveLength(2);

    await userEvent.click(buttons[0]);
    expect(openSpy).toHaveBeenNthCalledWith(
      1,
      "https://drive.google.com/drive/folders/folderA",
      "_blank",
      "noopener",
    );

    await userEvent.click(buttons[1]);
    expect(openSpy).toHaveBeenNthCalledWith(
      2,
      "https://drive.google.com/drive/folders/folderB",
      "_blank",
      "noopener",
    );

    firstRender.unmount();
    configuredFolder = null;
    renderWithProviders(<BackupHistoryList />);

    const buttonsAfterRemove = await screen.findAllByTitle(
      "Open Google Drive folder",
    );
    expect(buttonsAfterRemove).toHaveLength(2);
    await userEvent.click(buttonsAfterRemove[0]);
    await waitFor(() =>
      expect(openSpy).toHaveBeenLastCalledWith(
        "https://drive.google.com/drive/folders/folderA",
        "_blank",
        "noopener",
      ),
    );
  });
});
