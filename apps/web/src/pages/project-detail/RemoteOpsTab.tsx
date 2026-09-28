import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  Archive,
  Download,
  File,
  Folder,
  FilePlus,
  FolderPlus,
  GitCompare,
  Loader2,
  NotebookPen,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatBytes } from "./backups/utils";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { DangerConfirmDialog } from "@/components/ui/danger-confirm-dialog";

interface Environment {
  id: number;
  type: string;
  url?: string;
  root_path?: string;
  backup_path?: string;
  server: { id?: number; name: string };
}

interface EnvFileResponse {
  path: string;
  checksum: string;
  content: string;
  missing_required: string[];
  confirmation_phrase: string;
  variables: { key: string; masked_value: string; is_secret: boolean }[];
}

interface FileListItem {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  mode?: string;
  modified_at?: number;
}

interface FileListResponse {
  path: string;
  roots?: { key: string; label: string; path: string }[];
  items: FileListItem[];
}

interface FileReadResponse {
  path: string;
  checksum: string;
  content: string;
}

interface TailResponse {
  path: string;
  lines: string[];
  fetched_at: string;
}

interface Note {
  id: number;
  body: string;
  pinned: boolean;
  updated_at: string;
}

export function RemoteOpsTab({
  projectId,
  projectName,
  environments,
}: {
  projectId: number;
  projectName: string;
  environments: Environment[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get("env");
  const initialEnvId = envParam ? Number(envParam) : null;
  const [selectedEnvId, setSelectedEnvId] = useState<number | null>(
    environments.find((e) => e.id === initialEnvId)?.id ??
      environments.find((e) => e.type === "production")?.id ??
      environments[0]?.id ??
      null,
  );
  const selectedEnv = environments.find((e) => e.id === selectedEnvId);
  const qc = useQueryClient();

  useEffect(() => {
    const envId = Number(searchParams.get("env"));
    if (envId && environments.some((e) => e.id === envId)) {
      setSelectedEnvId(envId);
    }
  }, [searchParams, environments]);

  useEffect(() => {
    if (!selectedEnvId) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get("env") !== String(selectedEnvId)) {
          next.set("env", String(selectedEnvId));
        }
        return next;
      },
      { replace: true },
    );
  }, [selectedEnvId, setSearchParams]);

  const envQuery = useQuery<EnvFileResponse>({
    queryKey: ["env-file", selectedEnvId],
    queryFn: () => api.get(`/environments/${selectedEnvId}/env-file`),
    enabled: !!selectedEnvId,
    retry: false,
  });
  const [envContent, setEnvContent] = useState("");
  useEffect(() => {
    if (envQuery.data?.content != null) setEnvContent(envQuery.data.content);
  }, [envQuery.data?.content]);

  const [confirmEnvSave, setConfirmEnvSave] = useState(false);
  const saveEnvMutation = useMutation({
    mutationFn: () =>
      api.put(`/environments/${selectedEnvId}/env-file`, {
        content: envContent,
        checksum: envQuery.data?.checksum,
        confirmation: selectedEnv?.type,
      }),
    onSuccess: () => {
      toast({ title: ".env saved" });
      setConfirmEnvSave(false);
      void qc.invalidateQueries({ queryKey: ["env-file", selectedEnvId] });
    },
    onError: (err) =>
      toast({
        title: "Failed to save .env",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const [compareRightId, setCompareRightId] = useState<number | null>(null);
  const compareQuery = useQuery<{
    rows: {
      key: string;
      left: string | null;
      right: string | null;
      status: string;
      is_secret: boolean;
    }[];
  }>({
    queryKey: ["env-compare", projectId, selectedEnvId, compareRightId],
    queryFn: () =>
      api.get(
        `/projects/${projectId}/env-file/compare?left=${selectedEnvId}&right=${compareRightId}`,
      ),
    enabled:
      !!selectedEnvId && !!compareRightId && selectedEnvId !== compareRightId,
    retry: false,
  });

  const [filePath, setFilePath] = useState<string | undefined>();
  const [touchDialogOpen, setTouchDialogOpen] = useState(false);
  const [touchType, setTouchType] = useState<"file" | "directory">("file");
  const [touchName, setTouchName] = useState("");

  const filesQuery = useQuery<FileListResponse>({
    queryKey: ["remote-files", selectedEnvId, filePath],
    queryFn: () =>
      api.get(
        `/environments/${selectedEnvId}/files${filePath ? `?path=${encodeURIComponent(filePath)}` : ""}`,
      ),
    enabled: !!selectedEnvId,
    retry: false,
  });
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const fileReadQuery = useQuery<FileReadResponse>({
    queryKey: ["remote-file-read", selectedEnvId, openFilePath],
    queryFn: () =>
      api.get(
        `/environments/${selectedEnvId}/files/read?path=${encodeURIComponent(openFilePath ?? "")}`,
      ),
    enabled: !!selectedEnvId && !!openFilePath,
    retry: false,
  });
  const [fileContent, setFileContent] = useState("");
  const [tailing, setTailing] = useState(false);
  useEffect(() => {
    if (fileReadQuery.data?.content != null) {
      setFileContent(fileReadQuery.data.content);
    }
  }, [fileReadQuery.data?.content]);
  const [confirmFileSave, setConfirmFileSave] = useState(false);
  const tailQuery = useQuery<TailResponse>({
    queryKey: ["remote-file-tail", selectedEnvId, openFilePath],
    queryFn: () =>
      api.get(
        `/environments/${selectedEnvId}/files/tail?path=${encodeURIComponent(openFilePath ?? "")}&lines=200`,
      ),
    enabled: !!selectedEnvId && !!openFilePath && tailing,
    refetchInterval: tailing ? 3000 : false,
    retry: false,
  });
  const saveFileMutation = useMutation({
    mutationFn: () =>
      api.put(`/environments/${selectedEnvId}/files`, {
        path: openFilePath,
        content: fileContent,
        checksum: fileReadQuery.data?.checksum,
        confirmation: selectedEnv?.type,
      }),
    onSuccess: () => {
      toast({ title: "File saved" });
      setConfirmFileSave(false);
      void qc.invalidateQueries({
        queryKey: ["remote-file-read", selectedEnvId, openFilePath],
      });
    },
    onError: (err) =>
      toast({
        title: "Failed to save file",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const downloadFileMutation = useMutation({
    mutationFn: (targetPath?: string) => {
      const p = targetPath || openFilePath;
      if (!p) throw new Error("No file selected for download");
      return api.get<{
        filename: string;
        content: string;
        encoding: "base64";
      }>(
        `/environments/${selectedEnvId}/files/download?path=${encodeURIComponent(p)}`,
      );
    },
    onSuccess: (data) => {
      const binary = atob(data.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = data.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    onError: (err) =>
      toast({
        title: "Failed to download file",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const archiveUploadsMutation = useMutation({
    mutationFn: () =>
      api.post<{ archive_path: string }>(
        `/environments/${selectedEnvId}/uploads/archive`,
        {},
      ),
    onSuccess: (data) =>
      toast({
        title: "Uploads archive created",
        description: data.archive_path,
      }),
    onError: (err) =>
      toast({
        title: "Failed to archive uploads",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const notesQuery = useQuery<Note[]>({
    queryKey: ["resource-notes", "project", projectId],
    queryFn: () => api.get(`/resource-notes/project/${projectId}`),
  });
  const [noteBody, setNoteBody] = useState("");
  const noteMutation = useMutation({
    mutationFn: () =>
      api.post("/resource-notes", {
        resource_type: "project",
        resource_id: String(projectId),
        body: noteBody,
        pinned: false,
      }),
    onSuccess: () => {
      setNoteBody("");
      void qc.invalidateQueries({
        queryKey: ["resource-notes", "project", projectId],
      });
    },
  });

  const currentPath = filesQuery.data?.path ?? selectedEnv?.root_path ?? "";
  const parentPath = useMemo(() => {
    if (!currentPath) return undefined;
    const parts = currentPath.split("/").filter(Boolean);
    if (parts.length <= 1) return undefined;
    return `/${parts.slice(0, -1).join("/")}`;
  }, [currentPath]);

  const touchMutation = useMutation({
    mutationFn: () => {
      if (!selectedEnvId || !touchName.trim()) throw new Error("Name required");
      const target = currentPath
        ? `${currentPath.replace(/\/+$/, "")}/${touchName.trim()}`
        : touchName.trim();
      return api.post(`/environments/${selectedEnvId}/files/touch`, {
        path: target,
        type: touchType,
      });
    },
    onSuccess: () => {
      toast({
        title: touchType === "directory" ? "Directory Created" : "File Created",
        description: touchName,
      });
      setTouchDialogOpen(false);
      setTouchName("");
      void filesQuery.refetch();
    },
    onError: (err) => {
      toast({
        title: "Creation Failed",
        description: err?.message || "Failed to create remote path",
        variant: "destructive",
      });
    },
  });

  if (!environments.length) {
    return (
      <Card>
        <CardContent className="py-10 text-sm text-muted-foreground">
          No environments configured.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={selectedEnvId ? String(selectedEnvId) : ""}
          onValueChange={(value) => setSelectedEnvId(Number(value))}
        >
          <SelectTrigger className="w-[260px]">
            <SelectValue placeholder="Environment" />
          </SelectTrigger>
          <SelectContent>
            {environments.map((env) => (
              <SelectItem key={env.id} value={String(env.id)}>
                {env.type} — {env.server.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedEnv && (
          <Badge variant="secondary">{selectedEnv.root_path}</Badge>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(340px,.8fr)]">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4" />
                Environment Variables
              </CardTitle>
              <CardDescription>{envQuery.data?.path ?? ".env"}</CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void envQuery.refetch()}
              disabled={envQuery.isFetching}
            >
              <RefreshCw className="h-4 w-4 mr-1.5" />
              Refresh
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {envQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">
                Loading .env...
              </div>
            ) : envQuery.error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {envQuery.error instanceof Error
                  ? envQuery.error.message
                  : "Unable to load .env"}
              </div>
            ) : (
              <>
                {envQuery.data?.missing_required.length ? (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/25 dark:text-amber-200">
                    <AlertTriangle className="h-4 w-4 mt-0.5" />
                    <span>
                      Missing required keys:{" "}
                      {envQuery.data.missing_required.join(", ")}
                    </span>
                  </div>
                ) : null}
                <Textarea
                  className="min-h-[360px] font-mono text-xs"
                  value={envContent}
                  onChange={(event) => setEnvContent(event.target.value)}
                  spellCheck={false}
                />
                <div className="flex justify-end">
                  <Button
                    onClick={() => setConfirmEnvSave(true)}
                    disabled={!envQuery.data || saveEnvMutation.isPending}
                  >
                    <Save className="h-4 w-4 mr-1.5" />
                    Save .env
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <GitCompare className="h-4 w-4" />
                Compare
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select
                value={compareRightId ? String(compareRightId) : ""}
                onValueChange={(value) => setCompareRightId(Number(value))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Compare with environment" />
                </SelectTrigger>
                <SelectContent>
                  {environments
                    .filter((env) => env.id !== selectedEnvId)
                    .map((env) => (
                      <SelectItem key={env.id} value={String(env.id)}>
                        {env.type}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <div className="max-h-64 overflow-auto rounded-md border">
                {compareQuery.data?.rows?.length ? (
                  compareQuery.data.rows.map((row) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-[1fr_auto] gap-3 border-b px-3 py-2 text-xs last:border-b-0"
                    >
                      <span className="font-mono">{row.key}</span>
                      <Badge
                        variant={
                          row.status === "same" ? "secondary" : "warning"
                        }
                      >
                        {row.status.replace("_", " ")}
                      </Badge>
                    </div>
                  ))
                ) : (
                  <div className="p-3 text-sm text-muted-foreground">
                    Select another environment.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <NotebookPen className="h-4 w-4" />
                Project Notes
              </CardTitle>
              <CardDescription>{projectName}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={noteBody}
                onChange={(event) => setNoteBody(event.target.value)}
                placeholder="Add note..."
              />
              <Button
                size="sm"
                onClick={() => noteMutation.mutate()}
                disabled={!noteBody.trim() || noteMutation.isPending}
              >
                Add Note
              </Button>
              <div className="space-y-2">
                {notesQuery.data?.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap"
                  >
                    {note.body}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">File Browser</CardTitle>
          <CardDescription>{currentPath}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(260px,.8fr)_minmax(0,1.2fr)]">
          <div className="rounded-md border">
            <div className="space-y-2 border-b p-2">
              <div className="flex flex-wrap gap-1">
                {filesQuery.data?.roots?.map((root) => (
                  <Button
                    key={root.key}
                    size="sm"
                    variant={currentPath === root.path ? "secondary" : "ghost"}
                    onClick={() => setFilePath(root.path)}
                    className="h-7 px-2 text-xs"
                  >
                    {root.label}
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={filePath ?? ""}
                  onChange={(event) => setFilePath(event.target.value)}
                  placeholder="Path"
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => void filesQuery.refetch()}
                  title="Refresh files"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    setTouchType("file");
                    setTouchName("");
                    setTouchDialogOpen(true);
                  }}
                  title="New File"
                >
                  <FilePlus className="h-4 w-4 text-primary" />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    setTouchType("directory");
                    setTouchName("");
                    setTouchDialogOpen(true);
                  }}
                  title="New Directory"
                >
                  <FolderPlus className="h-4 w-4 text-amber-500" />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => archiveUploadsMutation.mutate()}
                  disabled={!selectedEnvId || archiveUploadsMutation.isPending}
                  title="Archive uploads"
                >
                  <Archive className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="max-h-[440px] overflow-auto">
              {parentPath && (
                <button
                  className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => setFilePath(parentPath)}
                >
                  <ChevronRight className="h-4 w-4 rotate-180" />
                  Parent
                </button>
              )}
              {filesQuery.isLoading ? (
                <div className="p-3 text-sm text-muted-foreground">
                  Loading files...
                </div>
              ) : filesQuery.data?.items?.length ? (
                filesQuery.data.items.map((item) => (
                  <div
                    key={item.path}
                    className={cn(
                      "group flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted/70 transition-colors last:border-b-0 cursor-pointer",
                      openFilePath === item.path && "bg-muted font-medium",
                    )}
                    onClick={() =>
                      item.type === "directory"
                        ? setFilePath(item.path)
                        : setOpenFilePath(item.path)
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {item.type === "directory" ? (
                        <Folder className="h-4 w-4 text-amber-600 shrink-0" />
                      ) : (
                        <File className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="truncate">{item.name}</span>
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground">
                        {item.type === "file" ? formatBytes(item.size) : ""}
                      </span>
                      {item.type === "file" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-background"
                          title={`Download ${item.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadFileMutation.mutate(item.path);
                          }}
                        >
                          <Download className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-3 text-sm text-muted-foreground">
                  No files.
                </div>
              )}
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 truncate text-sm font-medium">
                {openFilePath ?? "No file selected"}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={tailing ? "secondary" : "outline"}
                  onClick={() => setTailing((v) => !v)}
                  disabled={!openFilePath || fileReadQuery.isError}
                >
                  Tail
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadFileMutation.mutate(openFilePath ?? undefined)}
                  disabled={!openFilePath || downloadFileMutation.isPending}
                >
                  <Download className="h-4 w-4 mr-1.5" />
                  Download
                </Button>
                <Button
                  size="sm"
                  onClick={() => setConfirmFileSave(true)}
                  disabled={
                    !openFilePath ||
                    !fileReadQuery.data ||
                    fileReadQuery.isError ||
                    saveFileMutation.isPending
                  }
                >
                  {saveFileMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1.5" />
                  )}
                  Save File
                </Button>
              </div>
            </div>
            {fileReadQuery.isError ? (
              <div className="min-h-[440px] flex flex-col items-center justify-center rounded-md border border-dashed p-8 text-center space-y-4 bg-muted/20">
                <div className="p-3 bg-muted rounded-full">
                  <Archive className="h-8 w-8 text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <p className="font-semibold text-sm">Binary or Large File</p>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    {fileReadQuery.error instanceof Error
                      ? fileReadQuery.error.message
                      : "This file cannot be displayed in the text editor. You can download it directly."}
                  </p>
                </div>
                <Button
                  onClick={() => downloadFileMutation.mutate(openFilePath ?? undefined)}
                  disabled={downloadFileMutation.isPending}
                >
                  {downloadFileMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <Download className="h-4 w-4 mr-1.5" />
                  )}
                  Download File
                </Button>
              </div>
            ) : (
              <Textarea
                className="min-h-[440px] font-mono text-xs"
                value={
                  tailing
                    ? (tailQuery.data?.lines.join("\n") ?? fileContent)
                    : fileContent
                }
                onChange={(event) => setFileContent(event.target.value)}
                spellCheck={false}
                disabled={!openFilePath || fileReadQuery.isLoading || tailing}
              />
            )}
            {tailing && tailQuery.data?.fetched_at && (
              <p className="text-xs text-muted-foreground">
                Last tail refresh:{" "}
                {new Date(tailQuery.data.fetched_at).toLocaleTimeString()}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <DangerConfirmDialog
        open={confirmEnvSave}
        onOpenChange={setConfirmEnvSave}
        title="Save .env"
        description="This writes the remote environment file after creating a backup."
        confirmation={selectedEnv?.type ?? ""}
        confirmLabel="Save .env"
        isPending={saveEnvMutation.isPending}
        onConfirm={() => saveEnvMutation.mutate()}
      />
      <DangerConfirmDialog
        open={confirmFileSave}
        onOpenChange={setConfirmFileSave}
        title="Save Remote File"
        description="This writes the selected remote file after creating a backup."
        confirmation={selectedEnv?.type ?? ""}
        confirmLabel="Save File"
        isPending={saveFileMutation.isPending}
        onConfirm={() => saveFileMutation.mutate()}
      />

      {/* Create File / Directory Dialog */}
      <Dialog open={touchDialogOpen} onOpenChange={setTouchDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {touchType === "directory" ? "Create New Directory" : "Create New File"}
            </DialogTitle>
            <DialogDescription>
              Create a new {touchType} in{" "}
              <code className="font-mono text-xs">{currentPath || "root"}</code>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              value={touchName}
              onChange={(e) => setTouchName(e.target.value)}
              placeholder={touchType === "directory" ? "new-folder" : "filename.txt"}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  touchMutation.mutate();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTouchDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => touchMutation.mutate()}
              disabled={!touchName.trim() || touchMutation.isPending}
            >
              {touchMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              )}
              Create {touchType === "directory" ? "Directory" : "File"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
