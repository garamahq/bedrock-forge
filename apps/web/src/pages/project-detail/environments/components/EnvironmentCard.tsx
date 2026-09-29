import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Pencil,
  Trash2,
  Server,
  Globe,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Loader2,
  AlertTriangle,
  ScanLine,
  X,
  Plus,
} from "lucide-react";
import { JOB_TYPES, WS_EVENTS } from "@bedrock-forge/shared";
import { useWebSocketEvent, useSubscribeEnvironment } from "@/lib/websocket";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Environment } from "../types";
import { SERVER_STATUS_VARIANT } from "../utils";
import {
  useAllTagsQuery,
  useAddTagMutation,
  useRemoveTagMutation,
  useBackupMutation,
  usePluginScanMutation,
} from "../hooks";
import { DbCredentialsSection } from "./DbCredentialsSection";
import { WpUsersSection } from "./WpUsersSection";

export function EnvironmentCard({
  env,
  projectId,
  onEdit,
  onDelete,
}: {
  env: Environment;
  projectId: number;
  onEdit: (e: Environment) => void;
  onDelete: (e: Environment) => void;
}) {
  const qc = useQueryClient();
  const [showAddTag, setShowAddTag] = useState(false);

  // Subscribe to WS room so real-time progress events reach this card
  useSubscribeEnvironment(env.id);

  const job = env.latestProvisioningJob;
  const isProvisioning =
    !!job && (job.status === "queued" || job.status === "active");
  const isProvisionFailed = !!job && job.status === "failed";
  const operationLabel =
    job?.job_type === JOB_TYPES.ENVIRONMENT_DECOMMISSION ||
    job?.job_type === JOB_TYPES.PROJECT_ARCHIVE
      ? "Decommissioning"
      : "Provisioning";

  // Real-time job events for this environment
  useWebSocketEvent(WS_EVENTS.JOB_PROGRESS, (raw: unknown) => {
    const d = raw as { environmentId?: number; queueName?: string };
    if (d.environmentId === env.id && d.queueName === "projects") {
      qc.invalidateQueries({ queryKey: ["environments", projectId] });
    }
  });
  useWebSocketEvent(WS_EVENTS.JOB_COMPLETED, (raw: unknown) => {
    const d = raw as { environmentId?: number; queueName?: string };
    if (d.environmentId === env.id && d.queueName === "projects") {
      qc.invalidateQueries({ queryKey: ["environments", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      toast({ title: "Environment job completed" });
    }
  });
  useWebSocketEvent(WS_EVENTS.JOB_FAILED, (raw: unknown) => {
    const d = raw as {
      environmentId?: number;
      queueName?: string;
      error?: string;
    };
    if (d.environmentId === env.id && d.queueName === "projects") {
      qc.invalidateQueries({ queryKey: ["environments", projectId] });
      toast({
        title: "Environment job failed",
        description: d.error,
        variant: "destructive",
      });
    }
  });

  // Tags query and mutations
  const { data: allTags = [] } = useAllTagsQuery();
  const addTagMutation = useAddTagMutation(projectId, env.id);
  const removeTagMutation = useRemoveTagMutation(projectId, env.id);

  const currentTagIds = new Set(
    (env.environment_tags ?? []).map((et) => et.tag.id),
  );
  const availableToAdd = allTags.filter((t) => !currentTagIds.has(t.id));

  // Backup and scan mutations
  const backupMutation = useBackupMutation();
  const pluginScanMutation = usePluginScanMutation();

  function triggerBackup() {
    backupMutation.mutate(env.id);
  }

  function triggerScan() {
    pluginScanMutation.mutate(env.id);
  }

  return (
    <Card className="flex flex-col">
      {isProvisioning && (
        <div className="px-4 py-2 bg-blue-50 dark:bg-blue-950/40 border-b flex items-center gap-2 text-sm text-blue-700 dark:text-blue-300 rounded-t-lg">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="flex-1">
            {job.status === "queued"
              ? `${operationLabel} queued…`
              : `${operationLabel} in progress${job.progress ? ` — ${job.progress}%` : "…"}`}
          </span>
        </div>
      )}
      {isProvisionFailed && (
        <div className="px-4 py-2 bg-red-50 dark:bg-red-950/40 border-b flex items-start gap-2 text-sm text-red-700 dark:text-red-300 rounded-t-lg">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="flex-1 line-clamp-2">
            Environment job failed
            {job.last_error ? `: ${job.last_error}` : ""}.
          </span>
          <a href="/activity" className="shrink-0 underline whitespace-nowrap">
            View logs
          </a>
        </div>
      )}
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs font-mono capitalize">
              {env.type}
            </Badge>
            <Badge
              variant={SERVER_STATUS_VARIANT[env.server.status] ?? "secondary"}
              className="text-xs"
            >
              {env.server.status}
            </Badge>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEdit(env)}
              title="Edit environment"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => onDelete(env)}
              title="Delete environment"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 flex-1">
        <div className="flex items-start gap-2 text-sm">
          <Server className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium leading-none">{env.server.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {env.server.ip_address}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <a
            href={env.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline truncate flex items-center gap-1"
          >
            {env.url}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <code className="text-xs bg-muted px-1.5 py-0.5 rounded truncate max-w-full">
            {env.root_path}
          </code>
        </div>

        {env.backup_path && (
          <div className="flex items-center gap-2 text-sm">
            <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded truncate max-w-full">
              {env.backup_path}
            </code>
          </div>
        )}

        <DbCredentialsSection projectId={projectId} envId={env.id} />

        <WpUsersSection projectId={projectId} envId={env.id} />

        {/* Tags */}
        {((env.environment_tags && env.environment_tags.length > 0) ||
          allTags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {(env.environment_tags ?? []).map((et) => (
              <span
                key={et.tag.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border"
                style={
                  et.tag.color
                    ? { borderColor: et.tag.color, color: et.tag.color }
                    : undefined
                }
              >
                {et.tag.name}
                <button
                  type="button"
                  onClick={() => removeTagMutation.mutate(et.tag.id)}
                  className="hover:opacity-70 transition-opacity leading-none"
                  aria-label={`Remove tag ${et.tag.name}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
            {availableToAdd.length > 0 &&
              (showAddTag ? (
                <Select
                  onValueChange={(v) => {
                    addTagMutation.mutate(Number(v));
                    setShowAddTag(false);
                  }}
                >
                  <SelectTrigger className="h-6 text-xs w-32">
                    <SelectValue placeholder="Add tag…" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableToAdd.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAddTag(true)}
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground border border-dashed rounded-full px-2 py-0.5 transition-colors"
                >
                  <Plus className="h-2.5 w-2.5" />
                  Tag
                </button>
              ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 pt-2 mt-auto border-t">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 text-xs h-7"
            disabled={backupMutation.isPending}
            onClick={triggerBackup}
            title="Create a full backup of this environment"
          >
            {backupMutation.isPending ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <HardDrive className="h-3 w-3 mr-1" />
            )}
            Backup
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 text-xs h-7"
            disabled={pluginScanMutation.isPending}
            onClick={triggerScan}
            title="Scan WordPress plugins"
          >
            {pluginScanMutation.isPending ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <ScanLine className="h-3 w-3 mr-1" />
            )}
            Scan
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
