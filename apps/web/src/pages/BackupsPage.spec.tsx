import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupsPage } from "./BackupsPage";
import { BackupsList } from "./project-detail/backups/components/BackupsList";
import type {
  Backup as EnvBackup,
  Environment as ProjectEnvironment,
} from "./project-detail/backups/types";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({ api: apiMocks }));
vi.mock("@/lib/websocket", () => ({
  useWebSocketEvent: () => undefined,
  useSubscribeEnvironment: () => undefined,
}));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: (selector: (s: { user: { roles: string[] } }) => unknown) =>
    selector({ user: { roles: ["admin"] } }),
}));

function renderBackupsPage(initialUrl = "/backups?environment_id=10") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <BackupsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Backup Center & project BackupsList Drive links (#42)", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiMocks.get.mockReset();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it("opens each Backup Center record's own gdrive folder even after environment folder changes or is cleared", async () => {
    let currentEnvFolder: string | null = "folderB";
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/environments") {
        return [
          {
            id: 10,
            type: "production",
            url: "https://example.test",
            google_drive_folder_id: currentEnvFolder,
            project: { id: 1, name: "Alpha Site" },
            server: { name: "prod-1" },
          },
        ];
      }
      if (path === "/backups/environment/10?page=1&limit=10") {
        return {
          total: 2,
          items: [
            {
              id: 101,
              type: "full",
              status: "completed",
              file_path: "gdrive:folderA/alpha-old.tar.gz",
              size_bytes: 1024,
              error_message: null,
              created_at: "2026-01-01T00:00:00.000Z",
              environment: { id: 10, project: { id: 1, name: "Alpha Site" } },
              jobExecution: null,
            },
            {
              id: 102,
              type: "full",
              status: "completed",
              file_path: "gdrive:folderB/alpha-new.tar.gz",
              size_bytes: 2048,
              error_message: null,
              created_at: "2026-01-02T00:00:00.000Z",
              environment: { id: 10, project: { id: 1, name: "Alpha Site" } },
              jobExecution: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    const first = renderBackupsPage();
    const buttons = await screen.findAllByTitle("Open Drive");
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

    first.unmount();
    currentEnvFolder = null;
    renderBackupsPage();

    const buttonsAfterClear = await screen.findAllByTitle("Open Drive");
    expect(buttonsAfterClear).toHaveLength(2);
    await userEvent.click(buttonsAfterClear[0]);
    await waitFor(() =>
      expect(openSpy).toHaveBeenLastCalledWith(
        "https://drive.google.com/drive/folders/folderA",
        "_blank",
        "noopener",
      ),
    );
  });

  it("opens each project BackupsList item's recorded Drive folder independently of selectedEnv.google_drive_folder_id", async () => {
    const selectedEnv: ProjectEnvironment = {
      id: 10,
      type: "staging",
      url: "https://staging.example.test",
      google_drive_folder_id: "folderB",
      server: { name: "stg-1" },
    };
    const items: (EnvBackup & { file_path?: string | null })[] = [
      {
        id: 1,
        type: "full",
        status: "completed",
        file_path: "gdrive:folderA/stg-old.tar.gz",
        size_bytes: 1024,
        error_message: null,
        created_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
        jobExecution: null,
      },
      {
        id: 2,
        type: "db_only",
        status: "completed",
        file_path: "gdrive:folderB/stg-new.sql.gz",
        size_bytes: 512,
        error_message: null,
        created_at: "2026-01-02T00:00:00.000Z",
        completed_at: "2026-01-02T00:01:00.000Z",
        jobExecution: null,
      },
    ];

    render(
      <BackupsList
        data={{ items, total: 2 }}
        isLoading={false}
        selectedEnv={selectedEnv}
        onRestoreClick={vi.fn()}
        onDeleteClick={vi.fn()}
        canDelete={false}
        cancelBackupMutation={{ isPending: false, mutate: vi.fn() }}
      />,
    );

    const buttons = screen.getAllByTitle("Open in Google Drive");
    await userEvent.click(buttons[0]);
    await userEvent.click(buttons[1]);

    expect(openSpy).toHaveBeenNthCalledWith(
      1,
      "https://drive.google.com/drive/folders/folderA",
      "_blank",
      "noopener",
    );
    expect(openSpy).toHaveBeenNthCalledWith(
      2,
      "https://drive.google.com/drive/folders/folderB",
      "_blank",
      "noopener",
    );
  });
});
