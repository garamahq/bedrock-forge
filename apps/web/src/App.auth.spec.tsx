import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateRoute } from "./App";
import { useAuthStore } from "@/store/auth.store";

const getValidAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(), post: vi.fn() },
  getValidAccessToken: getValidAccessTokenMock,
}));

vi.mock("@/lib/websocket", () => ({ destroySocket: vi.fn() }));

function tokenWithExpiry(exp: number): string {
  return `header.${btoa(JSON.stringify({ exp }))}.signature`;
}

describe("authenticated routes", () => {
  beforeEach(() => {
    getValidAccessTokenMock.mockReset();
    useAuthStore.setState({
      user: {
        id: 1,
        email: "operator@example.test",
        name: "Operator",
        roles: ["admin"],
      },
      accessToken: tokenWithExpiry(Math.floor(Date.now() / 1000) - 1),
    });
  });

  it("refreshes an expired access token before redirecting to login", async () => {
    const freshToken = tokenWithExpiry(Math.floor(Date.now() / 1000) + 3600);
    getValidAccessTokenMock.mockImplementation(async () => {
      useAuthStore.getState().setAccessToken(freshToken);
      return freshToken;
    });

    render(
      <MemoryRouter initialEntries={["/servers"]}>
        <PrivateRoute>
          <div>Protected server page</div>
        </PrivateRoute>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Protected server page")).toBeVisible();
    expect(getValidAccessTokenMock).toHaveBeenCalledTimes(1);
  });
});
