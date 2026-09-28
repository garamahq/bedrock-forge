import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Globe,
  Package,
  Shield,
  User2,
  Pencil,
  ExternalLink,
  FileText,
  History,
  Puzzle,
  RefreshCw,
  Undo2,
  Wrench,
  GitCompare,
  Palette,
  Cpu,
  FileCog,
  ListChecks,
  Archive,
  RotateCcw,
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  Plus,
  Trash2,
  GitBranch,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useBillingSettings } from "@/hooks/useBillingSettings";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { EnvironmentsTab } from "./project-detail/EnvironmentsTab";
import { BackupsTab } from "./project-detail/BackupsTab";
import { PluginsTab } from "./project-detail/PluginsTab";
import { SyncTab } from "./project-detail/SyncTab";
import { RestoreTab } from "./project-detail/RestoreTab";
import { ToolsTab } from "./project-detail/ToolsTab";
import { DriftTab } from "./project-detail/DriftTab";
import { ThemesTab } from "./project-detail/ThemesTab";
import { WpCoreTab } from "./project-detail/WpCoreTab";
import { RemoteOpsTab } from "./project-detail/RemoteOpsTab";
import { SecurityTab } from "./project-detail/SecurityTab";
import { GitDeployTab } from "./project-detail/GitDeployTab";
import { EnvironmentQuickBar } from "./project-detail/EnvironmentQuickBar";
import { ProjectFormDialog } from "./ProjectsPage";
import { ResourceActivityFeed } from "@/components/ResourceActivityFeed";
import {
  ArchiveDialog,
  RestoreDialog,
} from "@/components/ProjectArchiveDialogs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWebSocketEvent, useSubscribeEnvironment } from "@/lib/websocket";
import { toast } from "@/hooks/use-toast";
import { ExecutionLogPanel } from "@/components/ui/execution-log-panel";

interface Server {
  id: number;
  name: string;
  ip_address: string;
  status: string;
}

interface Environment {
  id: number;
  type: string;
  url?: string;
  root_path?: string;
  backup_path?: string;
  google_drive_folder_id: string | null;
  git_remote_url?: string | null;
  git_branch?: string | null;
  git_current_commit?: string | null;
  git_last_deployed_at?: string | null;
  has_deploy_webhook_token?: boolean;
  server: Server;
}

type ProjectLink =
  | { label: string; url: string; isText?: false; value?: never }
  | { label: string; value: string; isText: true; url?: never };

const VALID_PROJECT_TABS = [
  "environments",
  "deploy",
  "backups",
  "plugins",
  "sync",
  "restore",
  "tools",
  "drift",
  "themes",
  "files-config",
  "wp-core",
  "security",
  "activity",
];

interface Project {
  id: number;
  name: string;
  status: "active" | "inactive" | "archived";
  client: { id: number; name: string };
  hosting_package: { id: number; name: string; price_monthly: number } | null;
  support_package: { id: number; name: string; price_monthly: number } | null;
  environments: Environment[];
  created_at: string;
  notes?: string | null;
  links?: ProjectLink[] | null;
  github_repo?: string | null;
}

function ProjectHeader({
  project,
  onEdit,
  onArchive,
  onRestore,
}: {
  project: Project;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const navigate = useNavigate();

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return (
          <Badge
            variant="success"
            className="font-semibold shadow-sm text-xs px-2.5 py-1 capitalize"
          >
            Active
          </Badge>
        );
      case "inactive":
        return (
          <Badge
            variant="warning"
            className="font-semibold shadow-sm text-xs px-2.5 py-1 capitalize"
          >
            Inactive
          </Badge>
        );
      case "archived":
        return (
          <Badge
            variant="secondary"
            className="font-semibold shadow-sm text-xs px-2.5 py-1 capitalize bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
          >
            Archived
          </Badge>
        );
      default:
        return (
          <Badge
            variant="outline"
            className="font-semibold text-xs px-2.5 py-1 capitalize"
          >
            {status}
          </Badge>
        );
    }
  };

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-1 text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => navigate("/projects")}
      >
        <ArrowLeft className="h-4 w-4 mr-1.5" />
        All Projects
      </Button>

      <div className="flex flex-wrap items-start gap-4 justify-between border-b pb-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/75 bg-clip-text text-transparent break-words">
              {project.name}
            </h1>
            {getStatusBadge(project.status)}
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-sm mt-2">
            <div className="flex items-center justify-center h-5 w-5 rounded-full bg-muted/80 text-muted-foreground">
              <User2 className="h-3 w-3" />
            </div>
            <span className="font-medium">{project.client.name}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="shadow-sm hover:bg-accent/50 transition-colors"
            onClick={onEdit}
          >
            <Pencil className="h-4 w-4 mr-1.5" />
            Edit Project Details
          </Button>

          {project.status === "archived" ? (
            <Button
              variant="default"
              size="sm"
              className="shadow-sm bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white border-0 transition-all duration-200 hover:shadow-md"
              onClick={onRestore}
            >
              <RotateCcw className="h-4 w-4 mr-1.5" />
              Restore Archive
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="shadow-sm text-destructive hover:text-destructive border-destructive/20 hover:border-destructive/40 hover:bg-destructive/5 transition-colors"
              onClick={onArchive}
            >
              <Archive className="h-4 w-4 mr-1.5" />
              Archive Project
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="space-y-4 border-b pb-4">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-10 w-80" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-2">
        <Skeleton className="h-[76px] rounded-xl" />
        <Skeleton className="h-[76px] rounded-xl" />
        <Skeleton className="h-[76px] rounded-xl" />
      </div>
    </div>
  );
}

export function ProjectDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const { formatMoney } = useBillingSettings();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesText, setNotesText] = useState("");

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [editingLinkIndex, setEditingLinkIndex] = useState<number | null>(null);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkType, setLinkType] = useState<"link" | "text">("link");
  const [linkValue, setLinkValue] = useState("");

  const updateProjectMutation = useMutation({
    mutationFn: (data: Partial<Project>) =>
      api.put(`/projects/${projectId}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err) => {
      toast({
        title: "Failed to update project",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const [activeJobExecutionId, setActiveJobExecutionId] = useState<
    number | null
  >(null);
  const [activeBullJobId, setActiveBullJobId] = useState<string | null>(null);
  const [activeJobType, setActiveJobType] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<number | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobStep, setJobStep] = useState<string | null>(null);

  const archiveMutation = useMutation({
    mutationFn: (options: {
      createBackup: boolean;
      deleteFromCyberpanel: boolean;
    }) =>
      api.post<{ projectId: number; jobExecutionId: number; jobId: string }>(
        `/projects/${projectId}/archive`,
        options,
      ),
    onSuccess: (result) => {
      setArchiveOpen(false);
      if (result) {
        setActiveJobExecutionId(result.jobExecutionId);
        setActiveBullJobId(result.jobId);
        setActiveJobType("project:archive");
        setJobProgress(0);
        setJobStatus("active");
        setJobStep("Queueing archival task...");
        toast({
          title: "Archival process initiated",
          description:
            "Project status changed to archived and deprovisioning task started.",
        });
      }
    },
    onError: (err) => {
      toast({
        title: "Archival failed to start",
        description: err.message || "An unexpected error occurred",
        variant: "destructive",
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (environmentBackups: Record<string, number>) =>
      api.post<{ projectId: number; jobExecutionId: number; jobId: string }>(
        `/projects/${projectId}/restore-archive`,
        { environmentBackups },
      ),
    onSuccess: (result) => {
      setRestoreOpen(false);
      if (result) {
        setActiveJobExecutionId(result.jobExecutionId);
        setActiveBullJobId(result.jobId);
        setActiveJobType("project:restore");
        setJobProgress(0);
        setJobStatus("active");
        setJobStep("Queueing restoration task...");
        toast({
          title: "Restoration process initiated",
          description:
            "Project status changed to active and reprovisioning task started.",
        });
      }
    },
    onError: (err) => {
      toast({
        title: "Restoration failed to start",
        description: err.message || "An unexpected error occurred",
        variant: "destructive",
      });
    },
  });

  useWebSocketEvent("job:progress", (raw: unknown) => {
    const event = raw as {
      queueName: string;
      jobId: string;
      progress: number;
      step?: string;
    };
    if (event.queueName === "projects" && event.jobId === activeBullJobId) {
      setJobProgress(event.progress);
      if (event.step) setJobStep(event.step);
    }
  });

  useWebSocketEvent("job:completed", (raw: unknown) => {
    const event = raw as {
      queueName: string;
      jobId: string;
    };
    if (event.queueName === "projects" && event.jobId === activeBullJobId) {
      setJobProgress(100);
      setJobStatus("completed");
      setJobStep("Task completed successfully.");
      toast({ title: "Project action succeeded" });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      setTimeout(() => {
        setActiveJobExecutionId(null);
        setActiveBullJobId(null);
        setJobProgress(null);
        setJobStep(null);
        setJobStatus(null);
      }, 4000);
    }
  });

  useWebSocketEvent("job:failed", (raw: unknown) => {
    const event = raw as {
      queueName: string;
      jobId: string;
      error?: string;
    };
    if (event.queueName === "projects" && event.jobId === activeBullJobId) {
      setJobStatus("failed");
      setJobProgress(null);
      setJobStep(event.error || "An error occurred during execution.");
      toast({
        title: "Project action failed",
        description: event.error ?? "An unexpected error occurred",
        variant: "destructive",
      });
    }
  });

  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const currentTab =
    requestedTab && VALID_PROJECT_TABS.includes(requestedTab)
      ? requestedTab
      : "environments";
  const [activatedTabs, setActivatedTabs] = useState<Set<string>>(
    new Set([currentTab]),
  );

  useEffect(() => {
    if (requestedTab && !VALID_PROJECT_TABS.includes(requestedTab)) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("tab", "environments");
          return next;
        },
        { replace: true },
      );
    }
  }, [requestedTab, setSearchParams]);

  useEffect(() => {
    setActivatedTabs((prev) => {
      if (prev.has(currentTab)) return prev;
      const next = new Set(prev);
      next.add(currentTab);
      return next;
    });
  }, [currentTab]);

  const {
    data: project,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["project", projectId],
    enabled: !!projectId,
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
  });

  useEffect(() => {
    if (project) {
      setNotesText(project.notes ?? "");
    }
  }, [project?.notes]);

  const { data: clients = [] } = useQuery({
    queryKey: ["clients-list"],
    queryFn: () =>
      api
        .get<{ items: { id: number; name: string }[] }>("/clients?limit=100")
        .then((r) => r.items),
  });

  const { data: hostingPkgs = [] } = useQuery({
    queryKey: ["packages-hosting"],
    queryFn: () =>
      api.get<{ id: number; name: string; price_monthly: number }[]>(
        "/packages/hosting",
      ),
  });

  const { data: supportPkgs = [] } = useQuery({
    queryKey: ["packages-support"],
    queryFn: () =>
      api.get<{ id: number; name: string; price_monthly: number }[]>(
        "/packages/support",
      ),
  });

  if (isLoading) {
    return (
      <div className="container mx-auto py-8 px-4 max-w-full space-y-6">
        <HeaderSkeleton />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (isError || !project) {
    return (
      <div className="container mx-auto py-16 px-4 text-center text-muted-foreground">
        <p className="text-lg font-medium">Project not found</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Go Back
        </Button>
      </div>
    );
  }

  const environments = project.environments ?? [];
  const envParam = searchParams.get("env");
  const initialEnvId = envParam ? Number(envParam) : null;
  const currentEnvId =
    environments.find((e) => e.id === initialEnvId)?.id ??
    environments.find((e) => e.type === "production")?.id ??
    environments[0]?.id ??
    null;

  return (
    <div className="container mx-auto py-8 px-4 max-w-full space-y-6">
      <ProjectHeader
        project={project}
        onEdit={() => setEditOpen(true)}
        onArchive={() => setArchiveOpen(true)}
        onRestore={() => setRestoreOpen(true)}
      />

      {activeJobExecutionId && (
        <div className="border rounded-xl p-5 space-y-3 bg-card shadow-sm backdrop-blur-sm border-primary/20">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 text-sm font-semibold">
              {jobStatus === "failed" ? (
                <XCircle className="h-5 w-5 text-destructive animate-pulse" />
              ) : jobStatus === "completed" ? (
                <CheckCircle2 className="h-5 w-5 text-green-500 animate-bounce" />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              )}
              <span className="capitalize">
                {activeJobType === "project:archive"
                  ? "Archiving Project"
                  : "Restoring Project"}
              </span>
            </div>
            {jobStatus === "failed" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setActiveJobExecutionId(null);
                  setActiveBullJobId(null);
                  setJobProgress(null);
                  setJobStep(null);
                  setJobStatus(null);
                }}
              >
                Dismiss
              </Button>
            )}
          </div>

          <div className="space-y-1">
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  jobStatus === "failed"
                    ? "bg-destructive"
                    : jobStatus === "completed"
                      ? "bg-green-500"
                      : "bg-primary"
                }`}
                style={{ width: `${jobProgress ?? 0}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground mt-1">
              <span>{jobStep || "Initializing..."}</span>
              <span className="font-semibold">{jobProgress ?? 0}%</span>
            </div>
          </div>

          {activeJobExecutionId && (
            <div className="mt-4 border-t pt-4">
              <ExecutionLogPanel
                jobExecutionId={activeJobExecutionId}
                isActive={jobStatus !== "completed" && jobStatus !== "failed"}
              />
            </div>
          )}
        </div>
      )}

      {/* Top Details, Notes & Links Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
        {/* Info Column */}
        <div className="flex flex-col gap-4">
          {project.hosting_package && (
            <div className="flex items-center gap-3.5 rounded-xl border bg-card/45 hover:bg-card/85 transition-all duration-200 shadow-sm p-4 backdrop-blur-sm group flex-1">
              <div className="p-2.5 rounded-xl bg-info/10 text-info border border-info/20 group-hover:scale-105 transition-transform duration-200">
                <Package className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground font-medium">
                  Hosting Package
                </p>
                <p className="text-sm font-semibold tracking-tight mt-0.5 truncate">
                  {project.hosting_package.name}
                </p>
                <p className="text-xs text-muted-foreground/80 mt-0.5">
                  {formatMoney(project.hosting_package.price_monthly)}/mo
                </p>
              </div>
            </div>
          )}
          {project.support_package && (
            <div className="flex items-center gap-3.5 rounded-xl border bg-card/45 hover:bg-card/85 transition-all duration-200 shadow-sm p-4 backdrop-blur-sm group flex-1">
              <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900 group-hover:scale-105 transition-transform duration-200">
                <Shield className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground font-medium">
                  Support Package
                </p>
                <p className="text-sm font-semibold tracking-tight mt-0.5 truncate">
                  {project.support_package.name}
                </p>
                <p className="text-xs text-muted-foreground/80 mt-0.5">
                  {formatMoney(project.support_package.price_monthly)}/mo
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3.5 rounded-xl border bg-card/45 hover:bg-card/85 transition-all duration-200 shadow-sm p-4 backdrop-blur-sm group flex-1">
            <div className="p-2.5 rounded-xl bg-purple-50 text-purple-600 dark:bg-purple-950/30 dark:text-purple-400 border border-purple-100 dark:border-purple-900 group-hover:scale-105 transition-transform duration-200">
              <Globe className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground font-medium">
                Environments
              </p>
              <p className="text-sm font-semibold tracking-tight mt-0.5">
                {project.environments.length}{" "}
                {project.environments.length === 1
                  ? "Environment"
                  : "Environments"}
              </p>
              <p className="text-xs text-muted-foreground/80 mt-0.5 truncate">
                {project.environments.map((e) => e.type).join(", ") ||
                  "None configured"}
              </p>
            </div>
          </div>
        </div>

        {/* Project Notes Column */}
        <div className="flex w-full">
          <Card className="border border-border/40 rounded-xl shadow-sm backdrop-blur-sm bg-card overflow-hidden w-full flex flex-col h-full">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 border-b border-border/20 px-5 py-4 shrink-0">
              <CardTitle className="text-sm font-semibold tracking-tight">
                Project Notes
              </CardTitle>
              {!isEditingNotes && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-muted"
                  aria-label="Edit project notes"
                  onClick={() => setIsEditingNotes(true)}
                >
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-5 flex-1 overflow-y-auto min-h-[160px]">
              {isEditingNotes ? (
                <div className="space-y-3 h-full flex flex-col">
                  <Textarea
                    placeholder="Record non-sensitive project context, handoff notes, or operational instructions..."
                    value={notesText}
                    onChange={(e) => setNotesText(e.target.value)}
                    className="flex-1 min-h-[100px] resize-none text-sm bg-muted/30 focus-visible:ring-primary/30"
                  />
                  <p className="text-xs text-warning-foreground bg-warning/10 border border-warning/20 rounded-md px-3 py-2">
                    Do not store passwords, API keys, tokens, SSH keys, or other
                    secrets here. Use the relevant server, integration, or
                    environment credential settings.
                  </p>
                  <div className="flex items-center justify-end gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => {
                        setIsEditingNotes(false);
                        setNotesText(project.notes ?? "");
                      }}
                      disabled={updateProjectMutation.isPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 text-xs gap-1.5"
                      onClick={() => {
                        updateProjectMutation.mutate(
                          { notes: notesText },
                          { onSuccess: () => setIsEditingNotes(false) },
                        );
                      }}
                      disabled={updateProjectMutation.isPending}
                    >
                      {updateProjectMutation.isPending && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm leading-relaxed text-foreground h-full flex flex-col">
                  {project.notes ? (
                    <div className="whitespace-pre-wrap select-text">
                      {project.notes}
                    </div>
                  ) : (
                    <p className="text-muted-foreground italic text-xs">
                      No project notes recorded yet. Click the edit icon to add
                      handoff notes, non-sensitive configuration context, or
                      operational instructions.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Quick Links Column */}
        <div className="flex w-full">
          <Card className="border border-border/40 rounded-xl shadow-sm backdrop-blur-sm bg-card overflow-hidden w-full flex flex-col h-full">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3 border-b border-border/20 px-5 py-4 shrink-0">
              <CardTitle className="text-sm font-semibold tracking-tight">
                Quick Links & Custom Info
              </CardTitle>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-muted"
                aria-label="Add project reference"
                onClick={() => {
                  setEditingLinkIndex(null);
                  setLinkLabel("");
                  setLinkUrl("");
                  setLinkValue("");
                  setLinkType("link");
                  setLinkDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4 text-muted-foreground" />
              </Button>
            </CardHeader>
            <CardContent className="p-5 flex-1 overflow-y-auto min-h-[160px]">
              {!project.links || project.links.length === 0 ? (
                <p className="text-muted-foreground italic text-xs">
                  No quick links or custom info added yet. Click the plus icon
                  to add documentation links or non-sensitive reference info.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {project.links.map((link, idx) => (
                    <div
                      key={idx}
                      className="group flex items-center justify-between p-2.5 rounded-lg border border-border/20 bg-muted/10 hover:bg-muted/30 transition-all animate-in fade-in-50 duration-200"
                    >
                      {link.isText ? (
                        <div className="flex items-start gap-2.5 text-sm text-foreground font-medium min-w-0 flex-1 mr-2">
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <span className="text-xs text-muted-foreground/70 block font-normal tracking-wide uppercase text-[10px] mb-0.5">
                              {link.label}
                            </span>
                            <span className="break-all whitespace-pre-wrap select-text text-xs leading-relaxed font-mono bg-muted/40 px-1.5 py-0.5 rounded border border-border/10 inline-block w-full">
                              {link.value}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-sm text-foreground hover:text-primary hover:underline font-medium min-w-0 flex-1 mr-2"
                        >
                          <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="truncate">{link.label}</span>
                          <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-60" />
                        </a>
                      )}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:bg-muted rounded-md"
                          onClick={() => {
                            setEditingLinkIndex(idx);
                            setLinkLabel(link.label);
                            setLinkUrl(link.url ?? "");
                            setLinkValue(link.value ?? "");
                            setLinkType(link.isText ? "text" : "link");
                            setLinkDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:bg-destructive/10 rounded-md"
                          onClick={() => {
                            if (
                              confirm(
                                `Are you sure you want to delete "${link.label}"?`,
                              )
                            ) {
                              const updated = (project.links ?? []).filter(
                                (_, i) => i !== idx,
                              );
                              updateProjectMutation.mutate({ links: updated });
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Unified Environment Quick Command Bar */}
      {environments.length > 0 && (
        <EnvironmentQuickBar
          environments={environments}
          selectedEnvId={currentEnvId}
          onSelectEnv={(envId) => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set("env", String(envId));
              return next;
            });
          }}
          githubRepo={project.github_repo}
        />
      )}

      {/* Tabs Container - takes full width now */}
      <div className="w-full">
        <Tabs
          value={currentTab}
          className="space-y-6 w-full"
          onValueChange={(v) => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.set("tab", v);
              return next;
            });
          }}
        >
          <TabsList
            aria-label="Project pages"
            className="flex flex-wrap overflow-visible whitespace-normal h-auto gap-1 bg-muted/60 p-1.5 border border-border/40 rounded-xl shadow-sm backdrop-blur-sm max-w-full justify-start"
          >
            <TabsTrigger
              value="environments"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <Globe className="h-3.5 w-3.5 opacity-70" />
              Environments
              {environments.length > 0 && (
                <span className="ml-1 text-xs opacity-60 bg-muted px-1.5 py-0.5 rounded-full font-semibold border border-border/30">
                  {environments.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="deploy"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <GitBranch className="h-3.5 w-3.5 opacity-70" />
              Git & Deploy
            </TabsTrigger>
            <TabsTrigger
              value="backups"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <History className="h-3.5 w-3.5 opacity-70" />
              Backups
            </TabsTrigger>
            <TabsTrigger
              value="plugins"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <Puzzle className="h-3.5 w-3.5 opacity-70" />
              Plugins
            </TabsTrigger>
            <TabsTrigger
              value="sync"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <RefreshCw className="h-3.5 w-3.5 opacity-70" />
              Sync
            </TabsTrigger>
            <TabsTrigger
              value="restore"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <Undo2 className="h-3.5 w-3.5 opacity-70" />
              Restore
            </TabsTrigger>
            <TabsTrigger
              value="tools"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <Wrench className="h-3.5 w-3.5 opacity-70" />
              Tools
            </TabsTrigger>
            <TabsTrigger
              value="drift"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <GitCompare className="h-3.5 w-3.5 opacity-70" />
              Drift
            </TabsTrigger>
            <TabsTrigger
              value="themes"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <Palette className="h-3.5 w-3.5 opacity-70" />
              Themes
            </TabsTrigger>
            <TabsTrigger
              value="files-config"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <FileCog className="h-3.5 w-3.5 opacity-70" />
              Files & Config
            </TabsTrigger>
            <TabsTrigger
              value="wp-core"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <Cpu className="h-3.5 w-3.5 opacity-70" />
              WP Core
            </TabsTrigger>
            <TabsTrigger
              value="security"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <Shield className="h-3.5 w-3.5 opacity-70" />
              Security
            </TabsTrigger>
            <TabsTrigger
              value="activity"
              className="gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm shrink-0"
            >
              <ListChecks className="h-3.5 w-3.5 opacity-70" />
              Activity
            </TabsTrigger>
          </TabsList>

          <TabsContent value="environments">
            {activatedTabs.has("environments") && (
              <EnvironmentsTab projectId={projectId} />
            )}
          </TabsContent>

          <TabsContent value="deploy">
            {activatedTabs.has("deploy") && (
              <GitDeployTab
                projectId={projectId}
                environments={environments}
                defaultRepo={project?.github_repo}
              />
            )}
          </TabsContent>

          <TabsContent value="backups">
            {activatedTabs.has("backups") && (
              <BackupsTab projectId={projectId} environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="plugins">
            {activatedTabs.has("plugins") && (
              <PluginsTab projectId={projectId} environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="sync">
            {activatedTabs.has("sync") && (
              <SyncTab projectId={projectId} environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="restore">
            {activatedTabs.has("restore") && (
              <RestoreTab projectId={projectId} environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="tools">
            {activatedTabs.has("tools") && (
              <ToolsTab environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="drift">
            {activatedTabs.has("drift") && (
              <DriftTab projectId={projectId} environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="themes">
            {activatedTabs.has("themes") && (
              <ThemesTab projectId={projectId} environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="wp-core">
            {activatedTabs.has("wp-core") && (
              <WpCoreTab environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="files-config">
            {activatedTabs.has("files-config") && (
              <RemoteOpsTab
                projectId={projectId}
                projectName={project.name}
                environments={environments}
              />
            )}
          </TabsContent>

          <TabsContent value="security">
            {activatedTabs.has("security") && (
              <SecurityTab projectId={projectId} environments={environments} />
            )}
          </TabsContent>

          <TabsContent value="activity">
            <div className="border rounded-xl p-5 bg-card shadow-sm">
              <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wide">
                Project Activity Log
              </h3>
              <ResourceActivityFeed
                resourceType="project"
                resourceId={projectId}
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingLinkIndex !== null ? "Edit Item" : "Add Reference Info"}
            </DialogTitle>
            <DialogDescription>
              Save web URLs and non-sensitive reference info. Common credential
              formats are rejected; save secrets in the relevant credential
              settings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Type *</Label>
              <Select
                value={linkType}
                onValueChange={(v: "link" | "text") => setLinkType(v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="link">Web Link / URL</SelectItem>
                  <SelectItem value="text">Non-sensitive Reference</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-label" className="text-xs font-semibold">
                Label *
              </Label>
              <Input
                id="link-label"
                placeholder={
                  linkType === "link"
                    ? "e.g. Staging phpMyAdmin, Client Portal"
                    : "e.g. Support hours, deployment window"
                }
                value={linkLabel}
                onChange={(e) => setLinkLabel(e.target.value)}
              />
            </div>
            {linkType === "link" ? (
              <div className="space-y-1.5">
                <Label htmlFor="link-url" className="text-xs font-semibold">
                  URL *
                </Label>
                <Input
                  id="link-url"
                  placeholder="e.g. https://domain.com/path"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="link-value" className="text-xs font-semibold">
                  Value / Text Content *
                </Label>
                <Textarea
                  id="link-value"
                  placeholder="Enter non-sensitive reference information..."
                  value={linkValue}
                  onChange={(e) => setLinkValue(e.target.value)}
                  className="min-h-[100px] resize-y"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLinkDialogOpen(false)}
              disabled={updateProjectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (!linkLabel.trim()) {
                  toast({ title: "Label is required", variant: "destructive" });
                  return;
                }
                if (linkType === "link" && !linkUrl.trim()) {
                  toast({
                    title: "URL is required for web links",
                    variant: "destructive",
                  });
                  return;
                }
                if (linkType === "text" && !linkValue.trim()) {
                  toast({
                    title: "Value is required for custom info",
                    variant: "destructive",
                  });
                  return;
                }

                let finalItem: ProjectLink;
                if (linkType === "link") {
                  let formattedUrl = linkUrl.trim();
                  if (!/^https?:\/\//i.test(formattedUrl)) {
                    formattedUrl = `https://${formattedUrl}`;
                  }
                  finalItem = {
                    label: linkLabel.trim(),
                    url: formattedUrl,
                    isText: false,
                  };
                } else {
                  finalItem = {
                    label: linkLabel.trim(),
                    value: linkValue.trim(),
                    isText: true,
                  };
                }

                const updated = [...(project.links ?? [])];
                if (editingLinkIndex !== null) {
                  updated[editingLinkIndex] = finalItem;
                } else {
                  updated.push(finalItem);
                }

                updateProjectMutation.mutate(
                  { links: updated },
                  { onSuccess: () => setLinkDialogOpen(false) },
                );
              }}
              disabled={updateProjectMutation.isPending}
            >
              {updateProjectMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              )}
              {editingLinkIndex !== null ? "Save Changes" : "Add Item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProjectFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initial={
          project as unknown as Parameters<
            typeof ProjectFormDialog
          >[0]["initial"]
        }
        clients={clients}
        hostingPackages={hostingPkgs}
        supportPackages={supportPkgs}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ["project", projectId] });
          qc.invalidateQueries({ queryKey: ["projects"] });
          setEditOpen(false);
        }}
      />

      <ArchiveDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        projectName={project.name}
        onConfirm={(options) => archiveMutation.mutate(options)}
        isPending={archiveMutation.isPending}
      />

      <RestoreDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        environments={environments}
        onConfirm={(selections) => restoreMutation.mutate(selections)}
        isPending={restoreMutation.isPending}
      />
    </div>
  );
}
