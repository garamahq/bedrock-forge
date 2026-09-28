import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Globe,
  ExternalLink,
  Shield,
  Zap,
  Lock,
  GitBranch,
  Copy,
  Check,
  Loader2,
  HardDrive,
  Power,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface Environment {
  id: number;
  type: string;
  url?: string;
  root_path?: string;
  backup_path?: string;
  git_remote_url?: string | null;
  git_branch?: string | null;
  git_current_commit?: string | null;
  server: {
    id?: number;
    name: string;
    ip_address?: string;
  };
}

interface EnvironmentQuickBarProps {
  environments: Environment[];
  selectedEnvId: number | null;
  onSelectEnv: (envId: number) => void;
  githubRepo?: string | null;
}

export function EnvironmentQuickBar({
  environments,
  selectedEnvId,
  onSelectEnv,
  githubRepo,
}: EnvironmentQuickBarProps) {
  const queryClient = useQueryClient();
  const [copiedPath, setCopiedPath] = useState(false);

  const currentEnv = environments.find((e) => e.id === selectedEnvId) || environments[0];

  // Fetch live maintenance mode status
  const { data: maintStatus, isFetching: isMaintFetching } = useQuery<{
    success: boolean;
    enabled: boolean;
    output?: string;
  }>({
    queryKey: ["wp-maintenance-status", currentEnv?.id],
    queryFn: () => api.get(`/environments/${currentEnv?.id}/wp-actions/maintenance-status`),
    enabled: !!currentEnv?.id,
    staleTime: 30_000,
  });

  // Fast Flush Cache mutation
  const flushCacheMutation = useMutation({
    mutationFn: async () => {
      if (!currentEnv?.id) return;
      return api.post(`/environments/${currentEnv.id}/wp-actions/cli`, {
        command: "cache flush",
      });
    },
    onSuccess: () => {
      toast({
        title: "⚡ Cache Flushed",
        description: `Object and rewrite cache cleared on ${currentEnv?.type || "environment"}.`,
      });
    },
    onError: (err) => {
      toast({
        title: "Cache Flush Failed",
        description: err?.message || "Failed to flush WordPress cache",
        variant: "destructive",
      });
    },
  });

  // Toggle Maintenance Mode mutation
  const toggleMaintMutation = useMutation({
    mutationFn: async (enable: boolean) => {
      if (!currentEnv?.id) return;
      return api.post(`/environments/${currentEnv.id}/wp-actions/maintenance-mode`, {
        enabled: enable,
      });
    },
    onSuccess: (_, enable) => {
      toast({
        title: enable ? "Maintenance Mode Activated" : "Maintenance Mode Deactivated",
        description: `Job queued for ${currentEnv?.type}.`,
      });
      void queryClient.invalidateQueries({
        queryKey: ["wp-maintenance-status", currentEnv?.id],
      });
    },
    onError: (err) => {
      toast({
        title: "Maintenance Toggle Failed",
        description: err?.message || "Failed to update maintenance mode",
        variant: "destructive",
      });
    },
  });

  if (!environments.length || !currentEnv) {
    return null;
  }

  const wpAdminUrl = currentEnv.url
    ? `${currentEnv.url.replace(/\/+$/, "")}/wp/wp-admin/`
    : null;

  const handleCopyPath = () => {
    if (currentEnv.root_path) {
      void navigator.clipboard.writeText(currentEnv.root_path);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    }
  };

  const isMaintActive = maintStatus?.enabled ?? false;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="w-full rounded-xl border border-border/50 bg-card/60 backdrop-blur-md p-3 sm:p-4 shadow-sm space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-wrap">
          {/* Left: Environment Switcher + Info */}
          <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80 shrink-0 hidden md:inline">
              Active Environment:
            </span>
            <Select
              value={String(currentEnv.id)}
              onValueChange={(val) => onSelectEnv(Number(val))}
            >
              <SelectTrigger className="h-8 w-full sm:w-48 md:w-52 text-xs font-medium bg-background border-border/60">
                <SelectValue placeholder="Select environment" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)} className="text-xs">
                    <span className="capitalize font-semibold">{e.type}</span>
                    <span className="text-muted-foreground ml-1.5 text-[11px]">
                      ({e.server?.name || "Server"})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Type badge */}
            <Badge
              variant={
                currentEnv.type === "production"
                  ? "destructive"
                  : currentEnv.type === "staging"
                  ? "warning"
                  : "secondary"
              }
              className="text-[11px] capitalize px-2 py-0.5"
            >
              {currentEnv.type}
            </Badge>

            {/* Git Branch badge if configured */}
            {currentEnv.git_branch && (
              <Badge
                variant="outline"
                className="text-[11px] font-mono gap-1 text-muted-foreground border-border/60"
              >
                <GitBranch className="h-3 w-3 text-primary/70" />
                <span className="truncate max-w-[90px] sm:max-w-[140px]">{currentEnv.git_branch}</span>
                {currentEnv.git_current_commit && (
                  <span className="opacity-60 text-[10px]">
                    @{currentEnv.git_current_commit.substring(0, 7)}
                  </span>
                )}
              </Badge>
            )}

            {/* Maintenance Mode Live Status */}
            {isMaintActive && (
              <Badge variant="warning" className="text-[11px] gap-1 animate-pulse">
                <Lock className="h-3 w-3" />
                <span className="hidden xs:inline">Maintenance </span>Mode On
              </Badge>
            )}
          </div>

          {/* Right: Instant Developer Quick Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap w-full sm:w-auto justify-start sm:justify-end">
            {/* Direct Visit Site */}
            {currentEnv.url && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1 px-2 sm:px-2.5"
                asChild
              >
                <a href={currentEnv.url} target="_blank" rel="noopener noreferrer">
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>Site</span>
                  <ExternalLink className="h-2.5 w-2.5 opacity-60 hidden xs:inline" />
                </a>
              </Button>
            )}

            {/* WP Admin Direct Link */}
            {wpAdminUrl && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1 px-2 sm:px-2.5"
                asChild
              >
                <a href={wpAdminUrl} target="_blank" rel="noopener noreferrer">
                  <Lock className="h-3.5 w-3.5 text-amber-500/80" />
                  <span>Admin</span>
                  <ExternalLink className="h-2.5 w-2.5 opacity-60 hidden xs:inline" />
                </a>
              </Button>
            )}

            {/* 1-Click Flush Cache */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1 px-2 sm:px-2.5 hover:border-primary/50"
                  onClick={() => flushCacheMutation.mutate()}
                  disabled={flushCacheMutation.isPending}
                >
                  {flushCacheMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  ) : (
                    <Zap className="h-3.5 w-3.5 text-amber-400 fill-amber-400/20" />
                  )}
                  <span>Flush<span className="hidden xs:inline"> Cache</span></span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Run wp cache flush instantly on this environment
              </TooltipContent>
            </Tooltip>

            {/* Toggle Maintenance Mode */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={isMaintActive ? "default" : "outline"}
                  size="sm"
                  className={`h-8 text-xs gap-1 px-2 sm:px-2.5 ${
                    isMaintActive ? "bg-amber-600 hover:bg-amber-700 text-white" : ""
                  }`}
                  onClick={() => toggleMaintMutation.mutate(!isMaintActive)}
                  disabled={toggleMaintMutation.isPending || isMaintFetching}
                >
                  {toggleMaintMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Power className="h-3.5 w-3.5" />
                  )}
                  <span>{isMaintActive ? "Disable" : "Maint"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isMaintActive
                  ? "Turn off WordPress maintenance mode"
                  : "Put environment into WordPress maintenance mode"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Bottom bar: Root path & server specs */}
        <div className="flex items-center justify-between text-xs text-muted-foreground/80 border-t border-border/30 pt-2 flex-wrap gap-2">
          <div className="flex items-center gap-2 min-w-0 max-w-full">
            <HardDrive className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <span className="shrink-0 font-medium">Path:</span>
            <code
              className="font-mono text-[11px] bg-muted/60 px-1.5 py-0.5 rounded truncate max-w-[170px] xs:max-w-[240px] sm:max-w-md cursor-pointer hover:bg-muted"
              title="Click to copy path"
              onClick={handleCopyPath}
            >
              {currentEnv.root_path || "Not configured"}
            </code>
            <button
              type="button"
              onClick={handleCopyPath}
              className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
              title="Copy root path"
            >
              {copiedPath ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-3 text-[11px]">
            <span>Server: <strong className="font-medium text-foreground">{currentEnv.server?.name || "Server"}</strong></span>
            {currentEnv.server?.ip_address && (
              <span className="font-mono opacity-70">({currentEnv.server.ip_address})</span>
            )}
            {githubRepo && (
              <a
                href={
                  githubRepo.startsWith("http")
                    ? githubRepo
                    : `https://github.com/${githubRepo}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary flex items-center gap-1 transition-colors"
              >
                <span>GitHub Repo</span>
                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
              </a>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
