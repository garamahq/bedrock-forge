import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { integrationsApi } from "./api";
import { toast } from "@/hooks/use-toast";
import { CloudflareDnsRecord } from "./types";

export function useGdriveStatus() {
  return useQuery({
    queryKey: ["gdrive-status"],
    queryFn: integrationsApi.getGdriveStatus,
  });
}

export function useCloudflareStatus() {
  return useQuery({
    queryKey: ["cloudflare-status"],
    queryFn: integrationsApi.getCloudflareStatus,
  });
}

export function useCloudflareDnsRecords(enabled: boolean) {
  return useQuery({
    queryKey: ["cloudflare-dns-records"],
    queryFn: integrationsApi.getDnsRecords,
    enabled,
    retry: false,
  });
}

export function useSaveGdrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: integrationsApi.saveGdrive,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gdrive-status"] });
      toast({ title: "Google Drive token saved" });
    },
    onError: (err: any) =>
      toast({
        title: "Failed to save token",
        description:
          err?.message ??
          'Paste the JSON token printed by rclone authorize "drive".',
        variant: "destructive",
      }),
  });
}

export function useTestGdrive() {
  return useMutation({
    mutationFn: integrationsApi.testGdrive,
    onError: (err: any) => {
      toast({
        title: "Connection test failed",
        description: err?.message ?? "Google Drive connection test failed.",
        variant: "destructive",
      });
    },
  });
}

export function useDeleteGdrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: integrationsApi.deleteGdrive,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gdrive-status"] });
      toast({ title: "Google Drive credentials removed" });
    },
    onError: () =>
      toast({ title: "Failed to remove credentials", variant: "destructive" }),
  });
}

export function useSaveCloudflare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: integrationsApi.saveCloudflare,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cloudflare-status"] });
      toast({ title: "Cloudflare saved" });
    },
    onError: (err: Error) =>
      toast({
        title: "Failed to save Cloudflare",
        description: err.message,
        variant: "destructive",
      }),
  });
}

export function useTestCloudflare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: integrationsApi.testCloudflare,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cloudflare-dns-records"] });
    },
  });
}

export function usePurgeCloudflare() {
  return useMutation({
    mutationFn: integrationsApi.purgeCloudflare,
    onSuccess: () => toast({ title: "Cloudflare cache purge requested" }),
    onError: (err: Error) =>
      toast({
        title: "Failed to purge cache",
        description: err.message,
        variant: "destructive",
      }),
  });
}

export function useToggleDevelopmentMode() {
  return useMutation({
    mutationFn: integrationsApi.toggleDevelopmentMode,
    onSuccess: () => toast({ title: "Development mode updated" }),
    onError: (err: Error) =>
      toast({
        title: "Failed to update development mode",
        description: err.message,
        variant: "destructive",
      }),
  });
}

export function useToggleDnsProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (record: CloudflareDnsRecord) =>
      integrationsApi.updateDnsRecord(record.id, {
        proxied: !record.proxied,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cloudflare-dns-records"] });
    },
    onError: (err: Error) =>
      toast({
        title: "Failed to update DNS record",
        description: err.message,
        variant: "destructive",
      }),
  });
}

export function usePagespeedStatus() {
  return useQuery({
    queryKey: ["pagespeed-status"],
    queryFn: integrationsApi.getPagespeedStatus,
  });
}

export function useSavePagespeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: integrationsApi.savePagespeed,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pagespeed-status"] });
      toast({ title: "PageSpeed & Lighthouse settings saved" });
    },
    onError: (err: any) =>
      toast({
        title: "Failed to save settings",
        description: err?.message ?? "An error occurred.",
        variant: "destructive",
      }),
  });
}

export function useTestPagespeed() {
  return useMutation({
    mutationFn: integrationsApi.testPagespeed,
    onError: (err: any) => {
      toast({
        title: "PageSpeed test failed",
        description: err?.message ?? "Failed to connect to Google PageSpeed API.",
        variant: "destructive",
      });
    },
  });
}

export function useDeletePagespeed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: integrationsApi.deletePagespeed,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pagespeed-status"] });
      toast({ title: "PageSpeed configuration removed" });
    },
    onError: () =>
      toast({ title: "Failed to remove configuration", variant: "destructive" }),
  });
}
