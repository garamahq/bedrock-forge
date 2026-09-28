import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { useAuthStore } from "@/store/auth.store";
import { accountApi } from "./api";

export function useSshKeyStatus() {
  return useQuery({
    queryKey: ["ssh-key-status"],
    queryFn: accountApi.getSshKeyStatus,
  });
}

export function useSetSshKeyMutation(onSuccessCallback?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: accountApi.setSshKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ssh-key-status"] });
      if (onSuccessCallback) onSuccessCallback();
      toast({ title: "Global SSH key saved" });
    },
    onError: () =>
      toast({ title: "Failed to save SSH key", variant: "destructive" }),
  });
}

export function useDeleteSshKeyMutation(onSuccessCallback?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: accountApi.deleteSshKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ssh-key-status"] });
      if (onSuccessCallback) onSuccessCallback();
      toast({ title: "Global SSH key removed" });
    },
    onError: () =>
      toast({ title: "Failed to remove SSH key", variant: "destructive" }),
  });
}

export function useChangePasswordMutation(onSuccessCallback?: () => void) {
  return useMutation({
    mutationFn: accountApi.changePassword,
    onSuccess: () => {
      if (onSuccessCallback) onSuccessCallback();
      toast({ title: "Password changed successfully" });
    },
    onError: (e) =>
      toast({
        title: "Failed to change password",
        description: e?.message,
        variant: "destructive",
      }),
  });
}

export function useSessionsQuery() {
  return useQuery({
    queryKey: ["auth-sessions"],
    queryFn: accountApi.getSessions,
    refetchOnWindowFocus: true,
  });
}

export function useRevokeSessionMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => accountApi.revokeSession(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth-sessions"] });
      toast({ title: "Session revoked" });
    },
    onError: () =>
      toast({ title: "Failed to revoke session", variant: "destructive" }),
  });
}

export function useRevokeAllSessionsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: accountApi.revokeAllSessions,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["auth-sessions"] });
      toast({ title: "All other sessions revoked" });
    },
    onError: () =>
      toast({ title: "Failed to revoke all sessions", variant: "destructive" }),
  });
}

export function useSetupMfaMutation() {
  return useMutation({
    mutationFn: accountApi.setupMfa,
    onError: (e) =>
      toast({
        title: "Failed to generate MFA setup",
        description: e.message,
        variant: "destructive",
      }),
  });
}

export function useEnableMfaMutation(onSuccessCallback?: () => void) {
  const setUser = useAuthStore((s) => s.setUser);
  const user = useAuthStore((s) => s.user);
  return useMutation({
    mutationFn: accountApi.enableMfa,
    onSuccess: () => {
      if (user) {
        setUser({ ...user, mfa_enabled: true });
      }
      if (onSuccessCallback) onSuccessCallback();
      toast({ title: "Two-factor authentication enabled" });
    },
    onError: (e) =>
      toast({
        title: "Failed to enable 2FA",
        description: e?.message || "Invalid verification code",
        variant: "destructive",
      }),
  });
}

export function useDisableMfaMutation() {
  const setUser = useAuthStore((s) => s.setUser);
  const user = useAuthStore((s) => s.user);
  return useMutation({
    mutationFn: (code: string) => accountApi.disableMfa(code),
    onSuccess: () => {
      if (user) {
        setUser({ ...user, mfa_enabled: false });
      }
      toast({ title: "Two-factor authentication disabled" });
    },
    onError: (e) =>
      toast({
        title: "Failed to disable 2FA",
        description: e.message,
        variant: "destructive",
      }),
  });
}
