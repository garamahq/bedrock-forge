import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPage } from "./ActivityPage";
import { MonitorDetailPage } from "./MonitorDetailPage";
import { ReportsPage } from "./ReportsPage";
import { renderWithProviders } from "@/test/render-with-providers";

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

describe("operational pages", () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.put.mockReset();
    apiMocks.patch.mockReset();
    apiMocks.delete.mockReset();
  });

  it("shows an activity load error and recovers after retry", async () => {
    let shouldFail = true;
    apiMocks.get.mockImplementation(async (path: string) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("activity service unavailable");
      }
      expect(path).toContain("/job-executions?");
      return { data: [], total: 0 };
    });

    renderWithProviders(<ActivityPage />);

    expect(await screen.findByText("Could not load activity")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("No jobs match these filters"),
    ).toBeVisible();
  });

  it("does not report an empty report channel list after a failed request", async () => {
    let channelsShouldFail = true;
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/reports/channels" && channelsShouldFail) {
        channelsShouldFail = false;
        throw new Error("channel service unavailable");
      }
      if (path === "/reports/channels") return [];
      if (path === "/reports/history") return [];
      if (path === "/reports/config") return null;
      throw new Error(`Unexpected request: ${path}`);
    });

    renderWithProviders(<ReportsPage />);

    expect(
      await screen.findByText("Could not load report channels"),
    ).toBeVisible();
    expect(
      screen.queryByText("No active notification channels."),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    expect(
      await screen.findByText("No active notification channels."),
    ).toBeVisible();
  });

  it("rejects malformed monitor links without sending invalid API requests", () => {
    renderWithProviders(<MonitorDetailPage />);

    expect(screen.getByText("Invalid monitor link")).toBeVisible();
    expect(apiMocks.get).not.toHaveBeenCalled();
  });
});
