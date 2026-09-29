import { isTokenExpired, useAuthStore } from "@/store/auth.store";
import { updateSocketToken } from "./websocket";

const BASE = "/api";

export type ApiErrorDetails =
  | Record<string, unknown>
  | unknown[]
  | string
  | null;

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code?: string;
  readonly details?: ApiErrorDetails;

  constructor(params: {
    message: string;
    status: number;
    statusText: string;
    code?: string;
    details?: ApiErrorDetails;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.code = params.code;
    this.details = params.details;
  }
}

async function parseErrorResponse(res: Response): Promise<{
  message: string;
  code?: string;
  details?: ApiErrorDetails;
}> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await res.json().catch(() => null);
    if (payload && typeof payload === "object") {
      const body = payload as Record<string, unknown>;
      const rawMessage = body.message;
      const message = Array.isArray(rawMessage)
        ? rawMessage.join(", ")
        : typeof rawMessage === "string"
          ? rawMessage
          : res.statusText || "API error";
      return {
        message,
        code: typeof body.code === "string" ? body.code : undefined,
        details:
          body.details !== undefined
            ? (body.details as ApiErrorDetails)
            : (payload as ApiErrorDetails),
      };
    }
  }

  const text = await res.text().catch(() => "");
  return {
    message: text.trim() || res.statusText || "API error",
    details: text.trim() || null,
  };
}

// Mutex: ensures only one token refresh is in-flight at a time.
// Concurrent 401s await the same promise instead of each triggering their own
// refresh (which would invalidate the rotation chain).
let _refreshPromise: Promise<string | null> | null = null;

async function refreshTokens(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    const { setAccessToken, setUser, logout } = useAuthStore.getState();
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) {
        logout();
        return null;
      }
      const data = await res.json();
      setAccessToken(data.accessToken);
      if (data.user) setUser(data.user);
      updateSocketToken(data.accessToken as string);
      return data.accessToken as string;
    } catch {
      logout();
      return null;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

export async function getValidAccessToken(): Promise<string | null> {
  let { accessToken } = useAuthStore.getState();
  if (accessToken !== null && isTokenExpired(accessToken)) {
    accessToken = await refreshTokens();
  }
  return accessToken;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let { accessToken } = useAuthStore.getState();

  // Pre-flight: if we have an access token that is already expired, attempt a
  // silent refresh before the first network call to avoid an unnecessary 401
  // round-trip. Skip this entirely when there is no token at all (e.g. the
  // /auth/login request made by a logged-out user).
  if (accessToken !== null && isTokenExpired(accessToken)) {
    const newToken = await refreshTokens();
    if (!newToken) {
      throw new ApiError({
        message: "Unauthorized",
        status: 401,
        statusText: "Unauthorized",
        code: "AUTH_REFRESH_FAILED",
      });
    }
    accessToken = newToken;
  }

  const doFetch = (token: string | null) =>
    fetch(`${BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  let res = await doFetch(accessToken);

  if (res.status === 401) {
    const newToken = await refreshTokens();
    if (!newToken) {
      throw new ApiError({
        message: "Unauthorized",
        status: 401,
        statusText: "Unauthorized",
        code: "AUTH_REFRESH_FAILED",
      });
    }
    res = await doFetch(newToken);
  }

  if (!res.ok) {
    const err = await parseErrorResponse(res);
    throw new ApiError({
      message: err.message,
      status: res.status,
      statusText: res.statusText,
      code: err.code,
      details: err.details,
    });
  }

  if (res.status === 204) return undefined as T;
  const body = await res.text();
  if (body.trim() === "") return null as T;
  return JSON.parse(body) as T;
}

// Convenience helpers
export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, {
      method: "DELETE",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  patch: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
};
