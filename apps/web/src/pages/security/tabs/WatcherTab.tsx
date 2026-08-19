import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Server as ServerIcon,
  Radio,
  CheckCircle2,
  AlertCircle,
  Copy,
  Terminal,
  Shield,
  Download,
  Clock,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import type { ServerSummary } from "../types";

export interface ServerWatcherItem {
  id: number;
  name: string;
  ip_address: string;
  status: string;
  watcher_mode: "agent" | "agentless_polling";
  watcher_status: "online" | "degraded" | "offline";
  last_heartbeat: string;
}

export function WatcherTab({ servers }: { servers: ServerSummary[] }) {
  const [selectedServerForInstall, setSelectedServerForInstall] = useState<ServerSummary | null>(null);

  const { data: watchers = [], isFetching } = useQuery<ServerWatcherItem[]>({
    queryKey: ["security", "watcher", "status"],
    queryFn: () => api.get("/security/watcher/status"),
    refetchInterval: 15_000,
  });

  const { data: scriptData } = useQuery<{ script: string }>({
    queryKey: ["security", "watcher", "script", selectedServerForInstall?.id],
    queryFn: () =>
      selectedServerForInstall
        ? api.get(`/security/watcher/install-script?serverId=${selectedServerForInstall.id}`)
        : Promise.resolve({ script: "" }),
    enabled: !!selectedServerForInstall,
  });

  const copyInstallCommand = (serverId: number) => {
    const cmd = `curl -sSL "${window.location.origin}/api/security/watcher/install-script?serverId=${serverId}" | sudo bash`;
    navigator.clipboard.writeText(cmd);
    toast({
      title: "Command copied to clipboard",
      description: "Paste and run in your remote server terminal as root.",
    });
  };

  return (
    <div className="space-y-4">
      {/* Header Info */}
      <div className="bg-card p-5 rounded-lg border border-border shadow-sm space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Radio className="h-5 w-5 text-emerald-500 animate-pulse" />
            <h3 className="font-semibold text-sm text-foreground">
              Continuous Threat Watcher & Real-Time Security Telemetry
            </h3>
          </div>
          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px]">
            ACTIVE MONITORING
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed max-w-3xl">
          Bedrock Forge monitors your infrastructure continuously using a hybrid approach: an optional lightweight systemd agent for instant detection, paired with automated agentless SSH polling fallback when no permanent agent is running.
        </p>
      </div>

      {/* Servers Watcher Grid */}
      <div className="space-y-3">
        {servers.map((server) => {
          const watcher = watchers.find((w) => w.id === server.id) || {
            id: server.id,
            name: server.name,
            ip_address: server.ip_address,
            watcher_mode: "agentless_polling",
            watcher_status: "online",
            last_heartbeat: new Date().toISOString(),
          };

          return (
            <div
              key={server.id}
              className="bg-card p-4 rounded-lg border border-border shadow-sm flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded bg-muted/60 border border-border/40">
                  <ServerIcon className="h-4 w-4 text-foreground" />
                </div>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-foreground">{server.name}</span>
                    <Badge variant="outline" className="text-[10px] font-mono">
                      {server.ip_address}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Mode: <span className="font-medium text-foreground capitalize">{watcher.watcher_mode.replace("_", " ")}</span></span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Heartbeat: {new Date(watcher.last_heartbeat).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Badge
                  variant="outline"
                  className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px] uppercase font-bold tracking-wider"
                >
                  <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-400" />
                  {watcher.watcher_status}
                </Badge>

                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setSelectedServerForInstall(server)}
                >
                  <Terminal className="h-3 w-3 mr-1 text-primary" />
                  Install Agent
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => copyInstallCommand(server.id)}
                >
                  <Copy className="h-3 w-3 mr-1" />
                  Copy One-Liner
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Install Agent Modal */}
      <Dialog
        open={!!selectedServerForInstall}
        onOpenChange={(isOpen) => {
          if (!isOpen) setSelectedServerForInstall(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              Install Security Watcher Agent
            </DialogTitle>
            <DialogDescription>
              Server: <span className="font-semibold text-foreground">{selectedServerForInstall?.name} ({selectedServerForInstall?.ip_address})</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            <p className="text-muted-foreground leading-relaxed text-[11px]">
              Run the following command on your server over SSH. This configures a lightweight, zero-dependency bash daemon managed by systemd that streams heartbeats and rapid threat telemetry.
            </p>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-foreground">
                <span>One-Liner Command:</span>
                <button
                  type="button"
                  className="text-primary hover:underline flex items-center gap-1"
                  onClick={() => selectedServerForInstall && copyInstallCommand(selectedServerForInstall.id)}
                >
                  <Copy className="h-3 w-3" /> Copy
                </button>
              </div>
              <code className="block bg-zinc-950 text-emerald-400 p-3 rounded text-[11px] font-mono break-all border border-border/60">
                curl -sSL "{window.location.origin}/api/security/watcher/install-script?serverId={selectedServerForInstall?.id}" | sudo bash
              </code>
            </div>

            {scriptData?.script && (
              <div className="space-y-1">
                <span className="text-muted-foreground font-semibold text-[11px]">Daemon Script Preview:</span>
                <pre className="bg-muted/40 p-2.5 rounded text-[10px] font-mono max-h-36 overflow-y-auto border border-border/50 text-foreground leading-relaxed">
                  {scriptData.script}
                </pre>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              size="sm"
              onClick={() => setSelectedServerForInstall(null)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
