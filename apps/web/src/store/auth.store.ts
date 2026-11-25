import { create } from "zustand";
import { clearSessionQueryCache } from "@/lib/query-client";

interface User {
  id: number;
  email: string;
  name: string;
  roles: string[];
  mfa_enabled?: boolean;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  setAccessToken: (access: string) => void;
  setUser: (user: User) => void;
  logout: () => void;
}

/** Decode a JWT payload (no signature verification — just read the exp claim). */
export function getTokenExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Returns true if the token is missing or its exp is ≤ now. */
export function isTokenExpired(token: string | null): boolean {
  if (!token) return true;
  const exp = getTokenExp(token);
  if (exp === null) return false; // no exp claim → treat as valid
  return exp * 1000 <= Date.now();
}

// Clean up any legacy persisted tokens from localStorage to be secure.
try {
  window.localStorage.removeItem("auth-storage");
} catch {
  // Ignored in non-browser environments
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  accessToken: null,
  setAccessToken: (accessToken) => set({ accessToken }),
  setUser: (user) => {
    const prevUser = get().user;
    if (prevUser !== null && prevUser.id !== user.id) {
      clearSessionQueryCache();
    }
    set({ user });
  },
  logout: () => {
    set({ user: null, accessToken: null });
    clearSessionQueryCache();
  },
}));
