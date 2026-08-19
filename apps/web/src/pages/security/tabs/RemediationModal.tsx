import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Wrench,
  ShieldCheck,
  AlertTriangle,
  FileCode,
  Archive,
  CheckCircle2,
  Terminal,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { SecurityFindingItem } from "../types";

export interface DryRunPlan {
  actionType: string;
  targetType: "server" | "environment";
  targetId: number;
  findingId?: number;
  riskLevel: "low" | "medium" | "high";
  commandsToExecute: string[];
  filesToModify: string[];
  safetyBackupPath?: string;
  quarantinePath?: string;
  preconditionChecks: string[];
  postVerificationChecks: string[];
  lamahSafetyNotice: string;
}

const RISK_BADGES: Record<string, string> = {
  low: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  high: "bg-red-500/10 text-red-400 border-red-500/30",
};

export function RemediationModal({
  finding,
  open,
  onOpenChange,
}: {
  finding: SecurityFindingItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);

  const targetType = finding?.server_id ? "server" : "environment";
  const targetId = finding?.server_id || finding?.environment_id || 0;
  const actionType = finding?.remediation_type || "HARDEN_CONFIGURATION";

  // Fetch dry-run preview plan
  const { data: plan, isFetching: isPreviewFetching } = useQuery<DryRunPlan>({
    queryKey: ["security", "remediation", "preview", targetType, targetId, finding?.id, actionType],
    queryFn: () =>
      api.post("/security/remediations/preview", {
        targetType,
        targetId,
        actionType,
        findingId: finding?.id,
        resource: finding?.resource || undefined,
      }),
    enabled: open && !!finding,
  });

  // Apply remediation mutation
  const applyMutation = useMutation({
    mutationFn: () =>
      api.post("/security/remediations/apply", {
        targetType,
        targetId,
        actionType,
        findingId: finding?.id,
        resource: finding?.resource || undefined,
      }),
    onSuccess: () => {
      toast({
        title: "Remediation queued safely",
        description: "Executing remediation with safety backup rollback point.",
      });
      onOpenChange(false);
      setConfirmed(false);
      void queryClient.invalidateQueries({ queryKey: ["security", "findings"] });
      void queryClient.invalidateQueries({ queryKey: ["security", "incidents"] });
    },
    onError: (err: any) => {
      toast({
        title: "Remediation failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  if (!finding) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) setConfirmed(false);
        onOpenChange(isOpen);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-primary" />
            Safe Remediation Execution
          </DialogTitle>
          <DialogDescription>
            Target: <span className="font-semibold text-foreground">{finding.title}</span>
          </DialogDescription>
        </DialogHeader>

        {isPreviewFetching && (
          <div className="py-12 text-center text-xs text-muted-foreground">
            Calculating safe dry-run execution plan...
          </div>
        )}

        {plan && !isPreviewFetching && (
          <div className="space-y-4 py-2 text-xs">
            {/* Lamah Safety Notice */}
            <div className="bg-primary/5 border border-primary/20 rounded-md p-3 flex items-start gap-2.5">
              <ShieldCheck className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <span className="font-semibold text-foreground">
                  Lamah-Staging Non-Destructive Safety Policy
                </span>
                <p className="text-muted-foreground leading-relaxed text-[11px]">
                  {plan.lamahSafetyNotice}
                </p>
              </div>
            </div>

            {/* Risk & Action Metadata */}
            <div className="grid grid-cols-2 gap-3 bg-muted/40 p-3 rounded border border-border/50">
              <div className="space-y-1">
                <span className="text-muted-foreground text-[11px]">Remediation Action:</span>
                <div className="font-mono font-medium text-foreground">{plan.actionType}</div>
              </div>
              <div className="space-y-1">
                <span className="text-muted-foreground text-[11px]">Risk Level:</span>
                <div>
                  <Badge variant="outline" className={`text-[10px] font-bold uppercase tracking-wider ${RISK_BADGES[plan.riskLevel]}`}>
                    {plan.riskLevel} Risk
                  </Badge>
                </div>
              </div>
            </div>

            {/* Safety Backup Destination */}
            {plan.safetyBackupPath && (
              <div className="space-y-1 bg-muted/30 p-2.5 rounded border border-border/40">
                <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] font-semibold">
                  <Archive className="h-3.5 w-3.5 text-primary" />
                  <span>Automated Rollback Archive Destination:</span>
                </div>
                <code className="text-[11px] font-mono text-foreground break-all">
                  {plan.safetyBackupPath}
                </code>
              </div>
            )}

            {/* Commands Preview */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <Terminal className="h-3.5 w-3.5" />
                <span>Commands to Execute:</span>
              </div>
              <pre className="bg-zinc-950 text-zinc-200 p-3 rounded text-[11px] font-mono overflow-x-auto border border-border/60 max-h-40 leading-relaxed">
                {plan.commandsToExecute.join("\n")}
              </pre>
            </div>

            {/* Safety Preconditions & Verifications */}
            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-[11px]">
                Safety Preconditions & Post-Verification Checks:
              </div>
              <ul className="space-y-1 text-[11px] text-muted-foreground">
                {plan.preconditionChecks.map((check, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                    <span>{check}</span>
                  </li>
                ))}
                {plan.postVerificationChecks.map((check, i) => (
                  <li key={`post-${i}`} className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3 w-3 text-blue-500 shrink-0" />
                    <span>{check}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Confirmation Checkbox */}
            <div className="flex items-start gap-2 pt-2 border-t border-border/60">
              <Checkbox
                id="remediateConfirm"
                checked={confirmed}
                onCheckedChange={(c) => setConfirmed(!!c)}
                className="mt-0.5"
              />
              <Label
                htmlFor="remediateConfirm"
                className="text-[11px] font-medium leading-relaxed text-foreground cursor-pointer"
              >
                I authorize Bedrock Forge to safely execute this remediation with automated rollback point creation.
              </Label>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setConfirmed(false);
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => applyMutation.mutate()}
            disabled={!confirmed || applyMutation.isPending || isPreviewFetching}
          >
            {applyMutation.isPending ? "Executing Safely..." : "Execute Safe Remediation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
