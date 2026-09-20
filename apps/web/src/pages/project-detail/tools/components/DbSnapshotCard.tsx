import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Database,
  Camera,
  Loader2,
  Download,
  CheckCircle2,
  HardDrive,
  Clock,
  FileCheck,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

interface DbSnapshotResponse {
  success: boolean;
  filename: string;
  path: string;
  sizeBytes: number;
  durationMs: number;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function DbSnapshotCard({
  selectedEnvId,
}: {
  selectedEnvId: number | null;
}) {
  const [snapshot, setSnapshot] = useState<DbSnapshotResponse | null>(null);

  const snapshotMutation = useMutation({
    mutationFn: () => {
      if (!selectedEnvId) throw new Error("No environment selected");
      return api.post<DbSnapshotResponse>(
        `/environments/${selectedEnvId}/wp-actions/db-export`,
        {},
      );
    },
    onSuccess: (data) => {
      setSnapshot(data);
      toast({
        title: "📸 Snapshot Created",
        description: `Exported ${data.filename} (${formatBytes(data.sizeBytes)}) in ${(data.durationMs / 1000).toFixed(1)}s`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Snapshot Failed",
        description: err?.message || "Failed to create database export",
        variant: "destructive",
      });
    },
  });

  const handleDownload = async () => {
    if (!selectedEnvId || !snapshot) return;
    try {
      const res = await api.get<{
        filename: string;
        content: string;
        encoding: string;
      }>(
        `/environments/${selectedEnvId}/files/download?path=${encodeURIComponent(snapshot.path)}`,
      );
      const binary = atob(res.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "application/sql" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = snapshot.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({
        title: "Download Failed",
        description: err?.message || "Could not retrieve snapshot file",
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="border border-border/60 shadow-sm overflow-hidden">
      <CardHeader className="pb-3 border-b border-border/30 bg-muted/20">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <Database className="h-4 w-4 text-primary" />
              Instant DB Snapshot
            </CardTitle>
            <CardDescription className="text-xs">
              Take an immediate timestamped SQL dump via WP-CLI before risky migrations or updates
            </CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() => snapshotMutation.mutate()}
            disabled={!selectedEnvId || snapshotMutation.isPending}
            className="h-8 text-xs gap-1.5 self-start sm:self-auto"
          >
            {snapshotMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
            <span>Take Snapshot</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-4">
        {snapshot ? (
          <div className="rounded-lg border border-border/50 bg-muted/30 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                <span className="font-mono text-xs font-semibold text-foreground truncate max-w-xs">
                  {snapshot.filename}
                </span>
                <Badge variant="outline" className="text-[10px] font-mono border-border/60">
                  {formatBytes(snapshot.sizeBytes)}
                </Badge>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {(snapshot.durationMs / 1000).toFixed(1)}s
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDownload}
                  className="h-7 text-xs gap-1 px-2.5"
                >
                  <Download className="h-3 w-3" />
                  <span>Download SQL</span>
                </Button>
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 font-mono">
              <HardDrive className="h-3 w-3 shrink-0 opacity-70" />
              <span className="truncate">{snapshot.path}</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between text-xs text-muted-foreground py-1">
            <span>No snapshot taken during this session.</span>
            <span className="text-[11px] opacity-70">Saved to server's .forge-backups/db-snapshots/</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
