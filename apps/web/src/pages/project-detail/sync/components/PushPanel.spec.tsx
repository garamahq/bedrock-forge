import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PushPanel } from "./PushPanel";
import type { Environment } from "../types";
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
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => undefined;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
});

async function selectSourceTargetAndFilesScope(
  sourceLabel: RegExp,
  targetLabel: RegExp,
) {
  await userEvent.click(screen.getByRole("button", { name: /Files only/i }));

  const triggers = screen.getAllByRole("combobox");
  await userEvent.click(triggers[0]);
  await userEvent.click(await screen.findByRole("option", { name: sourceLabel }));

  await userEvent.click(triggers[1]);
  await userEvent.click(await screen.findByRole("option", { name: targetLabel }));
}

describe("PushPanel files-only confirmation (#89)", () => {
  beforeEach(() => {
    apiMocks.post.mockReset();
  });

  it("describes site root overwrite, deletions, and exclusions for a traditional site", async () => {
    const traditionalEnvs: Environment[] = [
      {
        id: 1,
        type: "staging",
        url: "https://staging.classic-wp.test",
        google_drive_folder_id: "g1",
        server: { name: "classic-staging-vps" },
      },
      {
        id: 2,
        type: "production",
        url: "https://classic-wp.test",
        google_drive_folder_id: "g2",
        server: { name: "classic-prod-vps" },
      },
    ];

    renderWithProviders(
      <PushPanel projectId={10} environments={traditionalEnvs} />,
    );

    expect(
      screen.getByText(/Full site via rsync — excludes \.env, wp-config\.php, \.htaccess/i),
    ).toBeVisible();

    await selectSourceTargetAndFilesScope(
      /staging.*classic-staging-vps/i,
      /production.*classic-prod-vps/i,
    );

    const submitButton = screen.getByRole("button", {
      name: /Start Sync/i,
    });
    await userEvent.click(submitButton);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/site root/i);
    expect(dialog).toHaveTextContent(/deleted/i);
    expect(dialog).toHaveTextContent(/\.env.*wp-config\.php.*\.htaccess/i);
    expect(dialog).not.toHaveTextContent(/wp-content/i);
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it("describes site root overwrite, deletions, and exclusions for a Bedrock site", async () => {
    const bedrockEnvs: Environment[] = [
      {
        id: 11,
        type: "development",
        url: "https://dev.bedrock-app.test",
        google_drive_folder_id: "b1",
        server: { name: "bedrock-dev-vps" },
      },
      {
        id: 12,
        type: "staging",
        url: "https://staging.bedrock-app.test",
        google_drive_folder_id: "b2",
        server: { name: "bedrock-stg-vps" },
      },
    ];

    renderWithProviders(
      <PushPanel projectId={20} environments={bedrockEnvs} />,
    );

    await selectSourceTargetAndFilesScope(
      /development.*bedrock-dev-vps/i,
      /staging.*bedrock-stg-vps/i,
    );

    const submitButton = screen.getByRole("button", {
      name: /Start Sync/i,
    });
    await userEvent.click(submitButton);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/site root/i);
    expect(dialog).toHaveTextContent(/deleted/i);
    expect(dialog).toHaveTextContent(/\.env.*wp-config\.php.*\.htaccess/i);
    expect(dialog).not.toHaveTextContent(/wp-content/i);
    expect(apiMocks.post).not.toHaveBeenCalled();
  });
});
