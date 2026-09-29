import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, Loader2, ScanLine } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { ScannedSite, ServerOption } from "../types";
import { ENV_TYPES, EnvTypeValue } from "../utils";
import { environmentsApi } from "../api";

export function AddEnvironmentWizard({
  open,
  onOpenChange,
  projectId,
  servers,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: number;
  servers: ServerOption[];
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [manualMode, setManualMode] = useState(false);
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [sites, setSites] = useState<ScannedSite[]>([]);
  const [selectedSite, setSelectedSite] = useState<ScannedSite | null>(null);
  const [envType, setEnvType] = useState<EnvTypeValue>("production");
  const [customUrl, setCustomUrl] = useState("");
  const [manualRootPath, setManualRootPath] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const scanMutation = useMutation({
    mutationFn: (serverId: number) =>
      environmentsApi.scanServer(projectId, serverId),
    onSuccess: (data) => {
      setSites(Array.isArray(data) ? data : []);
      setStep(2);
    },
    onError: () => toast({ title: "Scan failed", variant: "destructive" }),
  });

  function reset() {
    setStep(1);
    setSelectedServerId(null);
    setSites([]);
    setSelectedSite(null);
    setManualMode(false);
    setEnvType("production");
    setCustomUrl("");
    setManualRootPath("");
  }

  function handleClose(o: boolean) {
    if (!o) reset();
    onOpenChange(o);
  }

  async function handleCreate() {
    if (!selectedServerId || (!manualMode && !selectedSite)) return;
    const url = customUrl.trim() || selectedSite?.siteUrl || "";
    if (!url) {
      toast({ title: "Site URL is required", variant: "destructive" });
      return;
    }
    if (
      manualMode &&
      (!/^\/[A-Za-z0-9_./-]+$/.test(manualRootPath.trim()) ||
        manualRootPath.split("/").includes(".."))
    ) {
      toast({
        title: "Enter a safe absolute document root path",
        variant: "destructive",
      });
      return;
    }
    setIsCreating(true);
    try {
      await environmentsApi.createEnvironment(projectId, {
        type: envType,
        server_id: selectedServerId,
        url,
        root_path: manualMode ? manualRootPath.trim() : selectedSite!.path,
        ...(!manualMode && selectedSite?.dbCredentials
          ? { db_credentials: selectedSite.dbCredentials }
          : {}),
      });
      toast({ title: "Environment created" });
      onSuccess();
      handleClose(false);
    } catch (error) {
      toast({
        title: "Environment creation failed",
        description:
          error instanceof Error
            ? error.message
            : "Please check the site URL and document root.",
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Environment</DialogTitle>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Select a server to scan for WordPress installations.
            </p>
            <div className="space-y-1">
              <Label>Server</Label>
              <Select
                value={selectedServerId?.toString()}
                onValueChange={(v) => setSelectedServerId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select server…" />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id.toString()}>
                      {s.name}{" "}
                      <span className="text-muted-foreground text-xs">
                        ({s.ip_address})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
              >
                Cancel
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!selectedServerId}
                  onClick={() => {
                    setManualMode(true);
                    setStep(2);
                  }}
                >
                  Enter manually
                </Button>
                <Button
                  disabled={!selectedServerId || scanMutation.isPending}
                  onClick={() =>
                    selectedServerId && scanMutation.mutate(selectedServerId)
                  }
                >
                  {scanMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      Scanning…
                    </>
                  ) : (
                    <>
                      <ScanLine className="h-4 w-4 mr-1.5" />
                      Scan Server
                    </>
                  )}
                </Button>
              </div>
            </DialogFooter>
          </div>
        ) : manualMode ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Enter the WordPress installation details for the selected server.
              The document root must be an absolute path without parent
              traversal.
            </p>
            <div className="space-y-1">
              <Label htmlFor="manual-env-type">Environment Type</Label>
              <Select
                value={envType}
                onValueChange={(value) => setEnvType(value as EnvTypeValue)}
              >
                <SelectTrigger id="manual-env-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENV_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="manual-env-url">Site URL</Label>
              <Input
                id="manual-env-url"
                type="url"
                value={customUrl}
                onChange={(event) => setCustomUrl(event.target.value)}
                placeholder="https://example.com"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="manual-env-root">Document root</Label>
              <Input
                id="manual-env-root"
                value={manualRootPath}
                onChange={(event) => setManualRootPath(event.target.value)}
                placeholder="/home/site/public_html"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setManualMode(false);
                  setStep(1);
                }}
              >
                Back
              </Button>
              <Button
                disabled={
                  !selectedServerId ||
                  !customUrl.trim() ||
                  !manualRootPath.trim() ||
                  isCreating
                }
                onClick={handleCreate}
              >
                {isCreating ? "Creating…" : "Create Environment"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {sites.length === 0
                ? "No WordPress sites found on this server."
                : `Found ${sites.length} site${sites.length !== 1 ? "s" : ""}. Select one to add as an environment.`}
            </p>
            {sites.length === 0 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setManualMode(true)}
              >
                Enter details manually
              </Button>
            )}

            {sites.length > 0 && (
              <div className="border rounded-lg divide-y max-h-64 overflow-y-auto">
                {sites.map((site) => (
                  <button
                    key={site.path}
                    type="button"
                    disabled={site.alreadyInThisProject}
                    onClick={() => {
                      setSelectedSite(site);
                      setCustomUrl(site.siteUrl ?? "");
                    }}
                    className={[
                      "w-full text-left px-3 py-2.5 transition-colors flex items-start gap-2",
                      site.alreadyInThisProject
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:bg-muted/50 cursor-pointer",
                      selectedSite?.path === site.path &&
                      !site.alreadyInThisProject
                        ? "bg-primary/10"
                        : "",
                    ].join(" ")}
                  >
                    <div className="mt-0.5 shrink-0">
                      {site.alreadyInThisProject ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : selectedSite?.path === site.path ? (
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                      ) : (
                        <CircleDashed className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {site.name}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {site.path}
                      </p>
                      {site.siteUrl && (
                        <p className="text-xs text-muted-foreground truncate">
                          {site.siteUrl}
                        </p>
                      )}
                      {site.alreadyInThisProject && (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          Already in this project
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {selectedSite && (
              <div className="space-y-3 border-t pt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Environment Type *</Label>
                    <Select
                      value={envType}
                      onValueChange={(v) => setEnvType(v as EnvTypeValue)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select type…" />
                      </SelectTrigger>
                      <SelectContent>
                        {ENV_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Site URL *</Label>
                    <Input
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="https://example.com"
                    />
                  </div>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setManualMode(false);
                  setStep(1);
                }}
              >
                Back
              </Button>
              <Button
                disabled={!selectedSite || !envType || isCreating}
                onClick={handleCreate}
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Creating…
                  </>
                ) : (
                  "Create Environment"
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
