import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Loader2,
  Layers,
  Eye,
  EyeOff,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { WS_EVENTS } from "@bedrock-forge/shared";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { useWebSocketEvent, useSubscribeEnvironment } from "@/lib/websocket";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Stepper } from "@/components/ui/stepper";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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

interface Client {
  id: number;
  name: string;
}

interface Server {
  id: number;
  name: string;
  ip_address: string;
}

interface ProjectEnv {
  id: number;
  url: string | null;
  type: string;
}

interface ProjectOption {
  id: number;
  name: string;
  environments: ProjectEnv[];
}

interface CreateFullResponse {
  project: { id: number; name: string };
  environment: { id: number; url: string | null };
  jobExecutionId: number;
  jobId: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const PHP_VERSIONS = ["8.1", "8.2", "8.3"] as const;

const STEPS = [
  { label: "Project Info", description: "Name & client" },
  { label: "Server & Domain", description: "Hosting details" },
  { label: "Database", description: "Credentials" },
  { label: "Review", description: "Confirm & create" },
] as const;

function randomHex(len: number) {
  return Array.from({ length: len }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

function generateDbCredentials(projectName: string) {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 10)
    .replace(/^_|_$/g, "");
  const suffix = randomHex(6);
  const base = slug || "wp";
  return {
    dbName: `${base}_${suffix}`,
    dbUser: `${base}_${suffix}`,
    dbPassword: randomHex(16),
    dbHost: "localhost",
  };
}

export function CreateBedrockDialog({ open, onOpenChange, onSuccess }: Props) {
  const navigate = useNavigate();

  // Stepper state
  const [step, setStep] = useState(0);

  // Mode
  const [mode, setMode] = useState<"fresh" | "clone">("fresh");

  // Step 0 — Project Info
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");

  // Step 1 — Server & Domain
  const [serverId, setServerId] = useState("");
  const [domain, setDomain] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [phpVersion, setPhpVersion] = useState("8.3");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceEnvId, setSourceEnvId] = useState("");

  // Step 2 — Database
  const [dbName, setDbName] = useState("");
  const [dbUser, setDbUser] = useState("");
  const [dbPassword, setDbPassword] = useState("");
  const [dbHost, setDbHost] = useState("localhost");
  const [showPassword, setShowPassword] = useState(false);

  // Job tracking state
  const [jobId, setJobId] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [jobExecutionId, setJobExecutionId] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [jobDone, setJobDone] = useState<"completed" | "failed" | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  // Subscribe to WS room for environment once we have it
  useSubscribeEnvironment(environmentId ?? 0);

  useWebSocketEvent(WS_EVENTS.JOB_PROGRESS, (raw: unknown) => {
    const d = raw as {
      jobId: string;
      queueName: string;
      progress: number;
      step?: string;
    };
    if (d.queueName !== "projects" || d.jobId !== jobId) return;
    setProgress(d.progress ?? 0);
    if (d.step) setProgressMsg(d.step);
  });

  useWebSocketEvent(WS_EVENTS.JOB_COMPLETED, (raw: unknown) => {
    const d = raw as { jobId: string; queueName: string };
    if (d.queueName !== "projects" || d.jobId !== jobId) return;
    setJobDone("completed");
    setProgress(100);
    onSuccess();
    toast({ title: "Bedrock project created successfully!" });
  });

  useWebSocketEvent(WS_EVENTS.JOB_FAILED, (raw: unknown) => {
    const d = raw as { jobId: string; queueName: string; error?: string };
    if (d.queueName !== "projects" || d.jobId !== jobId) return;
    setJobDone("failed");
    setJobError(d.error ?? "An unexpected error occurred");
    toast({
      title: "Bedrock creation failed",
      description: d.error,
      variant: "destructive",
    });
  });

  // Data queries
  const { data: clients } = useQuery({
    queryKey: ["clients-list"],
    queryFn: () =>
      api.get<{ items: Client[] }>("/clients?limit=100").then((r) => r.items),
    enabled: open,
  });

  const { data: servers } = useQuery({
    queryKey: ["servers-list"],
    queryFn: () =>
      api.get<{ items: Server[] }>("/servers?limit=100").then((r) => r.items),
    enabled: open,
  });

  const { data: projects } = useQuery({
    queryKey: ["projects-list-for-clone"],
    queryFn: () =>
      api
        .get<{ items: ProjectOption[] }>("/projects?limit=100")
        .then((r) => r.items),
    enabled: open && mode === "clone",
  });

  // Submit mutation
  const mutation = useMutation({
    mutationFn: (body: object) =>
      api.post<CreateFullResponse>("/projects/create-full", body),
    onSuccess: (res) => {
      setJobId(res.jobId);
      setEnvironmentId(res.environment.id);
      setProjectId(res.project.id);
      setJobExecutionId(res.jobExecutionId);
      setProgress(0);
      setProgressMsg("Starting...");
    },
    onError: (err: unknown) => {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Failed to start Bedrock creation";
      toast({ title: "Error", description: msg, variant: "destructive" });
    },
  });

  function handleSubmit() {
    if (!name || !clientId || !serverId || !domain || !adminEmail) {
      toast({
        title: "Missing fields",
        description: "Please fill in all required fields.",
        variant: "destructive",
      });
      return;
    }
    if (mode === "clone" && !sourceEnvId) {
      toast({
        title: "Missing source",
        description: "Select a source environment to clone from.",
        variant: "destructive",
      });
      return;
    }

    const trimmedDbHost = dbHost.trim() || "localhost";
    const body: Record<string, unknown> = {
      name,
      client_id: parseInt(clientId, 10),
      server_id: parseInt(serverId, 10),
      domain,
      admin_email: adminEmail,
      php_version: phpVersion,
      db_name: dbName || undefined,
      db_user: dbUser || undefined,
      db_password: dbPassword || undefined,
      db_host: trimmedDbHost !== "localhost" ? trimmedDbHost : undefined,
    };
    if (mode === "clone") {
      body.source_environment_id = parseInt(sourceEnvId, 10);
    }

    mutation.mutate(body);
  }

  function handleNavigate() {
    if (projectId) navigate(`/projects/${projectId}`);
  }

  function handleClose() {
    if (mutation.isPending) return;
    onOpenChange(false);
    setTimeout(reset, 200);
  }

  function reset() {
    setStep(0);
    setMode("fresh");
    setName("");
    setClientId("");
    setServerId("");
    setDomain("");
    setAdminEmail("");
    setPhpVersion("8.3");
    setSourceProjectId("");
    setSourceEnvId("");
    setDbName("");
    setDbUser("");
    setDbPassword("");
    setDbHost("localhost");
    setShowPassword(false);
    setJobId(null);
    setEnvironmentId(null);
    setProjectId(null);
    setJobExecutionId(null);
    setProgress(0);
    setProgressMsg("");
    setJobDone(null);
    setJobError(null);
    setShowLogs(false);
    mutation.reset();
  }

  function goToStep(next: number) {
    // Validate current step before advancing
    if (next > step) {
      if (step === 0 && (!name.trim() || !clientId)) {
        toast({
          title: "Missing fields",
          description: "Enter a project name and select a client.",
          variant: "destructive",
        });
        return;
      }
      if (step === 1) {
        if (!serverId || !domain.trim() || !adminEmail.trim()) {
          toast({
            title: "Missing fields",
            description: "Fill in server, domain and admin email.",
            variant: "destructive",
          });
          return;
        }
        if (mode === "clone" && !sourceEnvId) {
          toast({
            title: "Missing source",
            description: "Select a source environment to clone from.",
            variant: "destructive",
          });
          return;
        }
      }
      if (step === 2) {
        const trimmedHost = dbHost.trim();
        if (
          trimmedHost &&
          !/^[a-zA-Z0-9._:\-\[\]\/]+$/.test(trimmedHost)
        ) {
          toast({
            title: "Invalid database host",
            description:
              "Enter a valid hostname, IP, host:port, or socket path without spaces.",
            variant: "destructive",
          });
          return;
        }
      }
    }

    // Auto-generate DB credentials when entering step 2 for the first time
    if (next === 2 && !dbName) {
      const creds = generateDbCredentials(name);
      setDbName(creds.dbName);
      setDbUser(creds.dbUser);
      setDbPassword(creds.dbPassword);
      setDbHost(creds.dbHost);
    }

    setStep(next);
  }

  function regenerateCredentials() {
    const creds = generateDbCredentials(name);
    setDbName(creds.dbName);
    setDbUser(creds.dbUser);
    setDbPassword(creds.dbPassword);
  }

  // Reset source env when project changes
  useEffect(() => {
    setSourceEnvId("");
  }, [sourceProjectId]);

  const clients_label = clients?.find(
    (c) => c.id === parseInt(clientId, 10),
  )?.name;
  const server_label = servers?.find((s) => s.id === parseInt(serverId, 10));
  const sourceProject = projects?.find(
    (p) => p.id === parseInt(sourceProjectId, 10),
  );

  const isRunning = !!jobId && !jobDone;
  const isSubmitted = !!jobId;
  const isBusy = mutation.isPending || isRunning;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            Create Bedrock Project
          </DialogTitle>
        </DialogHeader>

        {!isSubmitted ? (
          <>
            <Stepper
              steps={
                STEPS as unknown as { label: string; description?: string }[]
              }
              currentStep={step}
              className="mb-2"
            />

            {/* ── Step 0: Project Info ────────────────────────── */}
            {step === 0 && (
              <div className="space-y-4 py-2">
                {/* Mode */}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={mode === "fresh" ? "default" : "outline"}
                    onClick={() => setMode("fresh")}
                  >
                    Fresh Bedrock
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === "clone" ? "default" : "outline"}
                    onClick={() => setMode("clone")}
                  >
                    Clone from Existing
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bf-name">
                    Project Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="bf-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My WordPress Site"
                    autoFocus
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>
                    Client <span className="text-destructive">*</span>
                  </Label>
                  <Select value={clientId} onValueChange={setClientId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select client…" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients?.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* ── Step 1: Server & Domain ─────────────────────── */}
            {step === 1 && (
              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label>
                    Server <span className="text-destructive">*</span>
                  </Label>
                  <Select value={serverId} onValueChange={setServerId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select server…" />
                    </SelectTrigger>
                    <SelectContent>
                      {servers?.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.name} ({s.ip_address})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bf-domain">
                    Domain <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="bf-domain"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="example.com"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bf-email">
                    Admin Email <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="bf-email"
                    type="email"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    placeholder="admin@example.com"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>PHP Version</Label>
                  <Select value={phpVersion} onValueChange={setPhpVersion}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PHP_VERSIONS.map((v) => (
                        <SelectItem key={v} value={v}>
                          PHP {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {mode === "clone" && (
                  <>
                    <div className="space-y-1.5">
                      <Label>
                        Source Project{" "}
                        <span className="text-destructive">*</span>
                      </Label>
                      <Select
                        value={sourceProjectId}
                        onValueChange={setSourceProjectId}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select source project…" />
                        </SelectTrigger>
                        <SelectContent>
                          {projects?.map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {sourceProject && (
                      <div className="space-y-1.5">
                        <Label>
                          Source Environment{" "}
                          <span className="text-destructive">*</span>
                        </Label>
                        <Select
                          value={sourceEnvId}
                          onValueChange={setSourceEnvId}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select environment…" />
                          </SelectTrigger>
                          <SelectContent>
                            {sourceProject.environments.map((e) => (
                              <SelectItem key={e.id} value={String(e.id)}>
                                {e.type} — {e.url ?? `env #${e.id}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Step 2: Database ─────────────────────────────── */}
            {step === 2 && (
              <div className="space-y-4 py-2">
                <p className="text-sm text-muted-foreground">
                  Credentials have been auto-generated. You can edit them or
                  regenerate a new set.
                </p>

                <div className="space-y-1.5">
                  <Label htmlFor="bf-dbname">Database Name</Label>
                  <Input
                    id="bf-dbname"
                    value={dbName}
                    onChange={(e) => setDbName(e.target.value)}
                    placeholder="wp_abc123"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bf-dbuser">Database User</Label>
                  <Input
                    id="bf-dbuser"
                    value={dbUser}
                    onChange={(e) => setDbUser(e.target.value)}
                    placeholder="wp_abc123"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bf-dbpass">Database Password</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        id="bf-dbpass"
                        type={showPassword ? "text" : "password"}
                        value={dbPassword}
                        onChange={(e) => setDbPassword(e.target.value)}
                        className="pr-10 font-mono"
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowPassword((s) => !s)}
                        aria-label={
                          showPassword ? "Hide password" : "Show password"
                        }
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bf-dbhost">Database Host</Label>
                  <Input
                    id="bf-dbhost"
                    value={dbHost}
                    onChange={(e) => setDbHost(e.target.value)}
                    placeholder="localhost"
                  />
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={regenerateCredentials}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Regenerate Credentials
                </Button>
              </div>
            )}

            {/* ── Step 3: Review ───────────────────────────────── */}
            {step === 3 && (
              <div className="space-y-3 py-2">
                <p className="text-sm text-muted-foreground">
                  Review your configuration before creating the project.
                </p>
                <div className="rounded-md border divide-y text-sm">
                  <ReviewRow
                    label="Mode"
                    value={
                      mode === "fresh" ? "Fresh Bedrock" : "Clone from Existing"
                    }
                  />
                  <ReviewRow label="Project Name" value={name} />
                  <ReviewRow label="Client" value={clients_label ?? clientId} />
                  <ReviewRow
                    label="Server"
                    value={
                      server_label
                        ? `${server_label.name} (${server_label.ip_address})`
                        : serverId
                    }
                  />
                  <ReviewRow label="Domain" value={domain} />
                  <ReviewRow label="Admin Email" value={adminEmail} />
                  <ReviewRow label="PHP Version" value={phpVersion} />
                  {mode === "clone" && (
                    <ReviewRow
                      label="Source Env"
                      value={
                        sourceProject?.environments.find(
                          (e) => e.id === parseInt(sourceEnvId, 10),
                        )?.url ?? `env #${sourceEnvId}`
                      }
                    />
                  )}
                  <ReviewRow label="DB Name" value={dbName || "(auto)"} mono />
                  <ReviewRow label="DB User" value={dbUser || "(auto)"} mono />
                  <ReviewRow
                    label="DB Password"
                    value={dbPassword ? "••••••••" : "(auto)"}
                    mono
                  />
                  <ReviewRow label="DB Host" value={dbHost} mono />
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={step === 0 ? handleClose : () => setStep((s) => s - 1)}
                disabled={isBusy}
              >
                {step === 0 ? "Cancel" : "Back"}
              </Button>
              {step < 3 ? (
                <Button onClick={() => goToStep(step + 1)}>Next</Button>
              ) : (
                <Button onClick={handleSubmit} disabled={isBusy}>
                  {mutation.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Create Project
                </Button>
              )}
            </DialogFooter>
          </>
        ) : (
          <>
            {/* Progress view */}
            <div className="py-4 space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {jobDone === "completed"
                      ? "Completed!"
                      : jobDone === "failed"
                        ? "Failed"
                        : progressMsg || "Working…"}
                  </span>
                  <span className="font-medium">{progress}%</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      jobDone === "failed"
                        ? "bg-destructive"
                        : jobDone === "completed"
                          ? "bg-green-500"
                          : "bg-primary"
                    }`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>

              {jobError && (
                <p className="text-sm text-destructive">{jobError}</p>
              )}

              {jobDone === "completed" && (
                <p className="text-sm text-muted-foreground">
                  Your Bedrock project has been provisioned and is ready.
                </p>
              )}

              {/* Execution log toggle — available once job is dispatched */}
              {jobExecutionId && (
                <div>
                  <button
                    onClick={() => setShowLogs((s) => !s)}
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ScrollText className="h-3.5 w-3.5" />
                    {showLogs ? "Hide Logs" : "View Logs"}
                  </button>
                  {showLogs && (
                    <div className="mt-2 max-h-60 overflow-y-auto border rounded-md p-2">
                      <ExecutionLogPanel
                        jobExecutionId={jobExecutionId}
                        isActive={isRunning}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <DialogFooter>
              {jobDone === "completed" ? (
                <>
                  <Button variant="outline" onClick={handleClose}>
                    Close
                  </Button>
                  <Button onClick={handleNavigate}>View Project</Button>
                </>
              ) : jobDone === "failed" ? (
                <>
                  <Button variant="outline" onClick={handleClose}>
                    Close
                  </Button>
                  <Button variant="destructive" onClick={reset}>
                    Try Again
                  </Button>
                </>
              ) : (
                <Button variant="outline" disabled>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating…
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span
        className={`text-right truncate max-w-[60%] ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
