import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/store/auth.store";
import { Header } from "./Header";

const apiGetMock = vi.hoisted(() => vi.fn());
const apiPostMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-client", () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
  },
}));

vi.mock("@/lib/websocket", () => ({
  getSocket: () => ({
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
  }),
}));

vi.mock("./Sidebar", () => ({
  SidebarInner: () => null,
}));

vi.mock("@/components/ActionCenter", () => ({
  ActionCenter: () => null,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Header notification session isolation (#103)", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    useAuthStore.setState({ user: null, accessToken: null });
  });

  it("does not display previous user's unread count or late in-flight response after switching accounts (#103)", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: false },
      },
    });

    const user1Deferred = createDeferred<{ count: number }>();
    const user2Deferred = createDeferred<{ count: number }>();

    apiGetMock.mockImplementation((path: string) => {
      if (path === "/notifications/inbox/unread-count") {
        const currentUserId = useAuthStore.getState().user?.id;
        return currentUserId === 1 ? user1Deferred.promise : user2Deferred.promise;
      }
      return Promise.resolve({ data: [] });
    });

    useAuthStore.setState({
      user: { id: 1, email: "user1@example.test", name: "User One", roles: ["admin"] },
      accessToken: "token-1",
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Header />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // User 1 receives 7 unread notifications first
    await act(async () => {
      user1Deferred.resolve({ count: 7 });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Notifications, 7 unread" }),
      ).toBeInTheDocument();
    });

    // Switch to User 2 whose unread request is still loading (and fails or returns 0 later)
    await act(async () => {
      useAuthStore.getState().logout();
      useAuthStore.getState().setUser({
        id: 2,
        email: "user2@example.test",
        name: "User Two",
        roles: ["admin"],
      });
      useAuthStore.getState().setAccessToken("token-2");
    });

    // Immediately while User 2 is loading, User 1's badge MUST NOT remain visible
    expect(
      screen.queryByRole("button", { name: "Notifications, 7 unread" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();

    // Even if User 2 request fails or resolves to 2, never leak User 1's count
    await act(async () => {
      user2Deferred.resolve({ count: 2 });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Notifications, 2 unread" }),
      ).toBeInTheDocument();
    });
  });

  it("drops an in-flight previous user unread response if account switches before it resolves (#103)", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: false },
      },
    });

    const user1InFlight = createDeferred<{ count: number }>();
    const user2Pending = createDeferred<{ count: number }>();

    apiGetMock.mockImplementation((path: string) => {
      if (path === "/notifications/inbox/unread-count") {
        const uid = useAuthStore.getState().user?.id;
        return uid === 1 ? user1InFlight.promise : user2Pending.promise;
      }
      return Promise.resolve({ data: [] });
    });

    useAuthStore.setState({
      user: { id: 1, email: "user1@example.test", name: "User One", roles: ["admin"] },
      accessToken: "token-1",
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Header />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Switch to User 2 BEFORE User 1's request resolves
    await act(async () => {
      useAuthStore.getState().setUser({
        id: 2,
        email: "user2@example.test",
        name: "User Two",
        roles: ["admin"],
      });
      useAuthStore.getState().setAccessToken("token-2");
    });

    // Late resolution for User 1 must NOT populate User 2's bell badge
    await act(async () => {
      user1InFlight.resolve({ count: 9 });
    });

    expect(
      screen.queryByRole("button", { name: "Notifications, 9 unread" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
  });
});
