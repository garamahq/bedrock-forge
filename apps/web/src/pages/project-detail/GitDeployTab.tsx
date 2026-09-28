import React, { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  GitCommit,
  GitPullRequest,
  Rocket,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  Shield,
  Clock,
  Terminal,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Settings2,
  Key,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  git_remote_url?: string | null;
  git_branch?: string | null;
  git_current_commit?: string | null;
  git_last_deployed_at?: string | null;
  has_deploy_webhook_token?: boolean;
  server: Server;
}

export function GitDeployTab({
  projectId,
  environments,
  defaultRepo,
}: {
  projectId: number;
  environments: Environment[];
  defaultRepo?: string | null;
}) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const envParam = searchParams.get("env");
  const initialEnvId = envParam ? Number(envParam) : environments[0]?.id || 0;

  const [selectedEnvId, setSelectedEnvId] = useState<number>(initialEnvId);
  const [activeJobExecutionId, setActiveJobExecutionId] = useState<
    number | null
  >(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const [webhookToken, setWebhookToken] = useState<string | null>(null);
  const [copiedWebhookToken, setCopiedWebhookToken] = useState(false);
  const [copiedDeployKey, setCopiedDeployKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Sync with URL query parameter
  React.useEffect(() => {
    const envId = Number(searchParams.get("env"));
    if (envId && environments.some((e) => e.id === envId)) {
      setSelectedEnvId(envId);
    }
  }, [searchParams, environments]);

  React.useEffect(() => {
    setWebhookToken(null);
    setCopiedWebhookToken(false);
  }, [selectedEnvId]);

  // Form states for manual deploy
  const [deployBranch, setDeployBranch] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [runComposer, setRunComposer] = useState(true);
  const [updateDb, setUpdateDb] = useState(true);
  const [flushCache, setFlushCache] = useState(true);

  // Settings form states
  const [editRemoteUrl, setEditRemoteUrl] = useState("");
  const [editBranch, setEditBranch] = useState("");

  const selectedEnv =
    environments.find((e) => e.id === selectedEnvId) || environments[0];

  // Fetch Server Deploy Key for private repos
  const {
    data: deployKeyData,
    isLoading: isDeployKeyLoading,
    refetch: refetchDeployKey,
  } = useQuery<{
    publicKey: string;
    keyType: string;
    isGenerated: boolean;
  }>({
    queryKey: ["server-deploy-key", selectedEnv?.id],
    queryFn: () =>
      api.get(
        `/projects/${projectId}/environments/${selectedEnv.id}/git/deploy-key`,
      ),
    enabled: !!selectedEnv?.id,
    staleTime: 60_000,
  });

  const copyDeployKey = () => {
    if (!deployKeyData?.publicKey) return;
    navigator.clipboard.writeText(deployKeyData.publicKey);
    setCopiedDeployKey(true);
    toast({
      title: "Copied!",
      description: "Server public SSH deploy key copied to clipboard.",
    });
    setTimeout(() => setCopiedDeployKey(false), 2000);
  };

  const handleSelectEnv = (id: number) => {
    setSelectedEnvId(id);
    setActiveJobExecutionId(null);
    setIsDeploying(false);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("env", String(id));
      return next;
    });
  };

  // Sync default branch when environment changes
  React.useEffect(() => {
    if (selectedEnv) {
      setDeployBranch(selectedEnv.git_branch || "main");
      setEditRemoteUrl(
        selectedEnv.git_remote_url ||
          (defaultRepo ? `https://github.com/${defaultRepo}.git` : ""),
      );
      setEditBranch(selectedEnv.git_branch || "main");
    }
  }, [
    selectedEnv?.id,
    selectedEnv?.git_branch,
    selectedEnv?.git_remote_url,
    defaultRepo,
  ]);

  // Mutation: Trigger Deployment
  const deployMutation = useMutation({
    mutationFn: async () => {
      if (!selectedEnv) throw new Error("No environment selected");
      const res = await api.post<{
        environmentId: number;
        jobExecutionId: number;
        jobId: string;
      }>(`/projects/${projectId}/environments/${selectedEnv.id}/deploy`, {
        branch: deployBranch || undefined,
        commitSha: commitSha.trim() || undefined,
        runComposer,
        updateDb,
        flushCache,
      });
      return res;
    },
    onSuccess: (data) => {
      setActiveJobExecutionId(data.jobExecutionId);
      setIsDeploying(true);
      toast({
        title: "Deployment Queued",
        description: `Deployment job #${data.jobId} is in progress.`,
      });
      queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
    },
    onError: (err) => {
      toast({
        title: "Deployment Failed to Queue",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Mutation: Update Git Settings
  const updateSettingsMutation = useMutation({
    mutationFn: async () => {
      if (!selectedEnv) throw new Error("No environment selected");
      return api.patch(
        `/projects/${projectId}/environments/${selectedEnv.id}/git`,
        {
          git_remote_url: editRemoteUrl.trim() || undefined,
          git_branch: editBranch.trim() || undefined,
        },
      );
    },
    onSuccess: () => {
      toast({
        title: "Settings Updated",
        description: "Git repository settings saved successfully.",
      });
      setSettingsOpen(false);
      queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
    },
    onError: (err) => {
      toast({
        title: "Failed to Update Settings",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Mutation: Generate Webhook Token
  const generateTokenMutation = useMutation({
    mutationFn: async () => {
      if (!selectedEnv) throw new Error("No environment selected");
      return api.post<{ token: string }>(
        `/projects/${projectId}/environments/${selectedEnv.id}/git/webhook-token`,
        {},
      );
    },
    onSuccess: ({ token }) => {
      setWebhookToken(token);
      toast({
        title: "Webhook Token Generated",
        description:
          "Copy the token now and add it as your GitHub webhook secret.",
      });
      queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
    },
    onError: (err) => {
      toast({
        title: "Failed to Generate Token",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  if (!selectedEnv) {
    return (
      <Card className="p-8 text-center border-dashed">
        <p className="text-muted-foreground">
          No environments found for this project. Create an environment first.
        </p>
      </Card>
    );
  }

  const webhookUrl = selectedEnv.has_deploy_webhook_token
    ? `${window.location.origin}/api/webhooks/deploy/${selectedEnv.id}`
    : null;

  const copyWebhook = () => {
    if (!webhookUrl) return;
    navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhook(true);
    toast({
      title: "Copied!",
      description: "Webhook URL copied to clipboard.",
    });
    setTimeout(() => setCopiedWebhook(false), 2000);
  };

  const copyWebhookToken = () => {
    if (!webhookToken) return;
    navigator.clipboard.writeText(webhookToken);
    setCopiedWebhookToken(true);
    toast({
      title: "Copied",
      description: "Webhook secret copied to clipboard.",
    });
    setTimeout(() => setCopiedWebhookToken(false), 2000);
  };

  const effectiveRepo =
    selectedEnv.git_remote_url ||
    (defaultRepo ? `https://github.com/${defaultRepo}` : null);

  return (
    <div className="space-y-6">
      {/* Top bar: Environment selector & settings */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
            Environment:
          </Label>
          <Select
            value={String(selectedEnv.id)}
            onValueChange={(val) => handleSelectEnv(Number(val))}
          >
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue placeholder="Select environment" />
            </SelectTrigger>
            <SelectContent>
              {environments.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>
                  <span className="capitalize">{e.type}</span> ({e.server.name})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            Git Settings
          </Button>
        </div>
      </div>

      {/* Grid: Repo Status & Manual Deploy */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Card 1: Repository Overview */}
        <Card className="border-border/50 shadow-sm flex flex-col justify-between">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-primary" />
                Repository
              </CardTitle>
              <Badge variant="outline" className="text-xs font-mono capitalize">
                {selectedEnv.git_branch || "main"}
              </Badge>
            </div>
            <CardDescription className="text-xs">
              Linked Git remote for this environment
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-1 text-xs">
            <div className="rounded-lg bg-muted/40 p-3 border border-border/40 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Remote URL:</span>
                {effectiveRepo ? (
                  <a
                    href={effectiveRepo.replace(/\.git$/, "")}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary flex items-center gap-1 hover:underline truncate max-w-[180px]"
                  >
                    {effectiveRepo}
                    <ExternalLink className="h-3 w-3 inline" />
                  </a>
                ) : (
                  <span className="text-muted-foreground italic">
                    Not configured
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Active Branch:</span>
                <span className="font-mono font-medium">
                  {selectedEnv.git_branch || "main"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Root Path:</span>
                <span className="font-mono truncate max-w-[180px]">
                  {selectedEnv.root_path || "N/A"}
                </span>
              </div>
            </div>

            {/* Current Commit Badge */}
            <div className="border-t border-border/40 pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1">
                  <GitCommit className="h-3.5 w-3.5" />
                  Deployed Commit:
                </span>
                {selectedEnv.git_current_commit ? (
                  <span className="font-mono font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded">
                    {selectedEnv.git_current_commit.slice(0, 7)}
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">Never</span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  Last Deployed:
                </span>
                <span className="font-medium text-foreground">
                  {selectedEnv.git_last_deployed_at
                    ? new Date(
                        selectedEnv.git_last_deployed_at,
                      ).toLocaleString()
                    : "No record"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Card 2: Manual Deploy Action */}
        <Card className="border-border/50 shadow-sm lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Rocket className="h-4 w-4 text-primary" />
              Deploy Code
            </CardTitle>
            <CardDescription className="text-xs">
              Pull latest commits, install dependencies, and apply updates.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Target Branch</Label>
                <Input
                  value={deployBranch}
                  onChange={(e) => setDeployBranch(e.target.value)}
                  placeholder="e.g. main, develop"
                  className="h-9 text-xs font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  Specific Commit SHA{" "}
                  <span className="text-muted-foreground text-[10px]">
                    (optional)
                  </span>
                </Label>
                <Input
                  value={commitSha}
                  onChange={(e) => setCommitSha(e.target.value)}
                  placeholder="e.g. 7a8b9c0"
                  className="h-9 text-xs font-mono"
                />
              </div>
            </div>

            {/* Deploy Pipeline Options */}
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 space-y-2.5 text-xs">
              <span className="font-semibold text-foreground uppercase tracking-wider text-[10px]">
                Deployment Pipeline Tasks:
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={runComposer}
                    onCheckedChange={(c) => setRunComposer(!!c)}
                  />
                  <span>Run Composer</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={updateDb}
                    onCheckedChange={(c) => setUpdateDb(!!c)}
                  />
                  <span>WP Database Update</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={flushCache}
                    onCheckedChange={(c) => setFlushCache(!!c)}
                  />
                  <span>Flush Caches</span>
                </label>
              </div>
            </div>

            <div className="flex justify-end pt-1">
              <Button
                onClick={() => deployMutation.mutate()}
                disabled={deployMutation.isPending}
                className="gap-2 shadow-sm"
              >
                {deployMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Rocket className="h-4 w-4" />
                )}
                Deploy Now
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Execution Log Timeline Panel */}
      {activeJobExecutionId && (
        <Card className="border-border/50 shadow-sm overflow-hidden">
          <CardHeader className="pb-2 bg-muted/10 border-b border-border/30">
            <CardTitle className="text-sm font-semibold flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-primary" />
                Deployment Execution #{activeJobExecutionId}
              </span>
              {isDeploying && (
                <Badge
                  variant="secondary"
                  className="gap-1 animate-pulse text-xs"
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                  In Progress
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ExecutionLogPanel
              jobExecutionId={activeJobExecutionId}
              isActive={isDeploying}
            />
          </CardContent>
        </Card>
      )}

      {/* Card 3: GitHub Push Webhook Auto-Deploy */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card className="border-border/50 shadow-sm bg-gradient-to-br from-background to-muted/10">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <GitPullRequest className="h-4 w-4 text-primary" />
                GitHub Auto-Deploy Webhook
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={() => generateTokenMutation.mutate()}
                disabled={generateTokenMutation.isPending}
              >
                <RefreshCw
                  className={`h-3 w-3 ${
                    generateTokenMutation.isPending ? "animate-spin" : ""
                  }`}
                />
                {selectedEnv.has_deploy_webhook_token
                  ? "Regenerate Token"
                  : "Generate Token"}
              </Button>
            </div>
            <CardDescription className="text-xs">
              Trigger automated deployment when new commits are pushed to{" "}
              <code className="font-mono text-primary font-medium">
                {selectedEnv.git_branch || "main"}
              </code>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-1 text-xs">
            {webhookUrl ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="font-mono text-xs h-9 bg-muted/40 select-all"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 px-3 gap-1 shrink-0"
                    onClick={copyWebhook}
                  >
                    {copiedWebhook ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-success" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        Copy URL
                      </>
                    )}
                  </Button>
                </div>

                {webhookToken && (
                  <div className="space-y-1.5">
                    <Label htmlFor="deploy-webhook-secret">
                      GitHub webhook secret (shown once)
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="deploy-webhook-secret"
                        readOnly
                        type="password"
                        value={webhookToken}
                        className="font-mono text-xs h-9"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 shrink-0"
                        onClick={copyWebhookToken}
                      >
                        {copiedWebhookToken ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        <span className="ml-1">
                          {copiedWebhookToken ? "Copied" : "Copy secret"}
                        </span>
                      </Button>
                    </div>
                  </div>
                )}

                <div className="p-3 bg-muted/30 rounded-lg border border-border/30 space-y-1.5 text-muted-foreground text-[11px] leading-relaxed">
                  <p className="font-semibold text-foreground">
                    Quick GitHub Setup:
                  </p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>
                      GitHub Repo &rarr; <strong>Settings</strong> &rarr;{" "}
                      <strong>Webhooks</strong> &rarr;{" "}
                      <strong>Add webhook</strong>.
                    </li>
                    <li>
                      Paste Payload URL, set Content type to{" "}
                      <code>application/json</code>.
                    </li>
                    <li>
                      Paste the shown token into GitHub&apos;s{" "}
                      <strong>Secret</strong> field.
                    </li>
                    <li>
                      Select <strong>Just the push event</strong> and save.
                    </li>
                  </ol>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 p-4 text-center space-y-2">
                <p className="text-muted-foreground">
                  No webhook token generated for this environment yet.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => generateTokenMutation.mutate()}
                  disabled={generateTokenMutation.isPending}
                >
                  Generate Deploy Webhook
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Card 4: Server Deploy Key (for Private Repositories) */}
        <Card className="border-border/50 shadow-sm bg-gradient-to-br from-background to-muted/10">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Key className="h-4 w-4 text-primary" />
                Server Deploy Key (Private Repositories)
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={() => refetchDeployKey()}
                disabled={isDeployKeyLoading}
              >
                <RefreshCw
                  className={`h-3 w-3 ${
                    isDeployKeyLoading ? "animate-spin" : ""
                  }`}
                />
                Refresh Key
              </Button>
            </div>
            <CardDescription className="text-xs">
              Add this public SSH key to your GitHub repository for private repo
              access.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-1 text-xs">
            {deployKeyData?.publicKey ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={deployKeyData.publicKey}
                    className="font-mono text-xs h-9 bg-muted/40 select-all"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 px-3 gap-1 shrink-0"
                    onClick={copyDeployKey}
                  >
                    {copiedDeployKey ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-success" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        Copy Key
                      </>
                    )}
                  </Button>
                </div>

                <div className="p-3 bg-muted/30 rounded-lg border border-border/30 space-y-1.5 text-muted-foreground text-[11px] leading-relaxed">
                  <p className="font-semibold text-foreground">
                    Adding to GitHub:
                  </p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>
                      GitHub Repo &rarr; <strong>Settings</strong> &rarr;{" "}
                      <strong>Deploy Keys</strong> &rarr;{" "}
                      <strong>Add deploy key</strong>.
                    </li>
                    <li>
                      Title:{" "}
                      <code>Bedrock Forge ({selectedEnv.server.name})</code>
                    </li>
                    <li>
                      Paste the key above and click <strong>Add key</strong>.
                    </li>
                  </ol>
                </div>
              </div>
            ) : isDeployKeyLoading ? (
              <div className="py-6 text-center text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Reading server deploy key...
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 p-4 text-center space-y-2">
                <p className="text-muted-foreground">
                  No SSH deploy key could be read from the server.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => refetchDeployKey()}
                >
                  Retry
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Edit Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Git Repository Settings</DialogTitle>
            <DialogDescription className="text-xs">
              Configure Git remote URL and tracking branch for this environment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 text-xs">
            <div className="space-y-1.5">
              <Label className="text-xs">Git Remote URL</Label>
              <Input
                value={editRemoteUrl}
                onChange={(e) => setEditRemoteUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
                className="text-xs font-mono h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Default Tracking Branch</Label>
              <Input
                value={editBranch}
                onChange={(e) => setEditBranch(e.target.value)}
                placeholder="main"
                className="text-xs font-mono h-9"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => updateSettingsMutation.mutate()}
              disabled={updateSettingsMutation.isPending}
            >
              {updateSettingsMutation.isPending && (
                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              )}
              Save Settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
