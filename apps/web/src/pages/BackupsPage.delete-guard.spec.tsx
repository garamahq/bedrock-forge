import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("Backup deletion guards (#49)", () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
  });

  it("hides delete buttons and disables bulk selection for pending or running backups in BackupsPage", async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/environments") {
        return [
          {
            id: 10,
            type: "production",
            url: "https://example.test",
            google_drive_folder_id: "folderA",
            project: { id: 1, name: "Alpha Site" },
            server: { name: "prod-1" },
          },
        ];
      }
      if (path === "/backups/environment/10?page=1&limit=10") {
        return {
          total: 3,
          items: [
            {
              id: 201,
              type: "full",
              status: "pending",
              size_bytes: null,
              error_message: null,
              created_at: "2026-01-01T00:00:00.000Z",
              environment: { id: 10, project: { id: 1, name: "Alpha Site" } },
              jobExecution: {
                id: 91,
                bull_job_id: "j-91",
                status: "queued",
                progress: 0,
                last_error: null,
                execution_log: null,
              },
            },
            {
              id: 202,
              type: "full",
              status: "running",
              size_bytes: null,
              error_message: null,
              created_at: "2026-01-02T00:00:00.000Z",
              environment: { id: 10, project: { id: 1, name: "Alpha Site" } },
              jobExecution: {
                id: 92,
                bull_job_id: "j-92",
                status: "active",
                progress: 40,
                last_error: null,
                execution_log: null,
              },
            },
            {
              id: 203,
              type: "full",
              status: "completed",
              size_bytes: 2048,
              error_message: null,
              created_at: "2026-01-03T00:00:00.000Z",
              environment: { id: 10, project: { id: 1, name: "Alpha Site" } },
              jobExecution: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/backups?environment_id=10"]}>
          <BackupsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const deleteButtons = await screen.findAllByTitle("Delete");
    expect(deleteButtons).toHaveLength(1);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[1]).toBeDisabled();
    expect(checkboxes[2]).toBeDisabled();
    expect(checkboxes[3]).not.toBeDisabled();
  });

  it("hides delete buttons for pending or running backups in BackupsList", () => {
    const selectedEnv: ProjectEnvironment = {
      id: 10,
      type: "staging",
      url: "https://staging.example.test",
      google_drive_folder_id: "folderA",
      server: { name: "stg-1" },
    };
    const items: EnvBackup[] = [
      {
        id: 1,
        type: "full",
        status: "running",
        size_bytes: null,
        error_message: null,
        created_at: "2026-01-01T00:00:00.000Z",
        completed_at: null,
        jobExecution: null,
      },
      {
        id: 2,
        type: "full",
        status: "completed",
        size_bytes: 1024,
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
        canDelete
        cancelBackupMutation={{ isPending: false, mutate: vi.fn() }}
      />,
    );

    expect(screen.getAllByLabelText("Delete backup")).toHaveLength(1);
  });
});
