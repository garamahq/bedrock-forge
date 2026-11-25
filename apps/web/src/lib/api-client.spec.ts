import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api-client";
import { useAuthStore } from "@/store/auth.store";

vi.mock("./websocket", () => ({ updateSocketToken: vi.fn() }));

describe("api client", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, accessToken: null });
  });

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

  it("preserves the backend rejection message and skips /auth/refresh when /auth/login returns 401 (#102)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message: "MFA code has already been used" }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.post("/auth/login", {
        email: "op@example.test",
        password: "secret",
        code: "123456",
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "MFA code has already been used",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.any(Object),
    );
  });

  it("does not trigger a duplicate /auth/refresh request when /auth/refresh returns 401 (#102)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Invalid or expired refresh token" }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.post("/auth/refresh", {})).rejects.toBeInstanceOf(
      ApiError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.any(Object),
    );
  });

  it("does not refresh or log out when /auth/mfa/disable rejects an invalid MFA code (#102)", async () => {
    useAuthStore.setState({
      user: { id: 1, email: "op@example.test", name: "Op", roles: ["admin"] },
      accessToken: "valid.access.token",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message:
            "Invalid MFA code — please provide your current authenticator code to disable MFA",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.post("/auth/mfa/disable", { code: "000000" }),
    ).rejects.toMatchObject({
      status: 401,
      message:
        "Invalid MFA code — please provide your current authenticator code to disable MFA",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe("valid.access.token");
  });

  it("refreshes once via /auth/refresh and retries a protected request when it receives 401 (#102)", async () => {
    useAuthStore.setState({
      user: { id: 1, email: "op@example.test", name: "Op", roles: ["admin"] },
      accessToken: "expired-server-side-token",
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: "fresh-token",
            user: {
              id: 1,
              email: "op@example.test",
              name: "Op",
              roles: ["admin"],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: ["ok"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.get<{ items: string[] }>("/servers")).resolves.toEqual({
      items: ["ok"],
    });

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/servers",
      "/api/auth/refresh",
      "/api/servers",
    ]);
  });
});
