import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ShieldAlert,
  Clock,
  Server as ServerIcon,
  Globe,
  FileText,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  History,
  XCircle,
  Eye,
  Wrench,
  HelpCircle,
  ChevronRight,
  Info,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import type { SecurityFindingItem, FindingStatus, Severity } from "../types";

const SEVERITY_BADGE_CLASSES: Record<Severity, string> = {
  critical: "bg-red-500/15 text-red-500 border-red-500/30 hover:bg-red-500/20",
  high: "bg-orange-500/15 text-orange-500 border-orange-500/30 hover:bg-orange-500/20",
  medium: "bg-yellow-500/15 text-yellow-500 border-yellow-500/30 hover:bg-yellow-500/20",
  low: "bg-blue-500/15 text-blue-500 border-blue-500/30 hover:bg-blue-500/20",
  info: "bg-slate-500/15 text-slate-400 border-slate-500/30 hover:bg-slate-500/20",
};

const STATUS_BADGE_CLASSES: Record<FindingStatus, string> = {
  new: "bg-red-500/15 text-red-400 border-red-500/30",
  investigating: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  acknowledged: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  remediated: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  resolved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  ignored: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  false_positive: "bg-purple-500/15 text-purple-400 border-purple-500/30",
};

interface FindingDetailDrawerProps {
  findingId: number | null;
  onClose: () => void;
  onRemediateClick?: (finding: SecurityFindingItem) => void;
}

export function FindingDetailDrawer({
  findingId,
  onClose,
  onRemediateClick,
}: FindingDetailDrawerProps) {
  const queryClient = useQueryClient();
  const [transitionDialog, setTransitionDialog] = useState<{
    status: FindingStatus;
    title: string;
  } | null>(null);
  const [transitionNote, setTransitionNote] = useState("");

  const { data: finding, isLoading } = useQuery<SecurityFindingItem>({
    queryKey: ["security", "finding", findingId],
    queryFn: () => api.get(`/security/findings/${findingId}`),
    enabled: findingId !== null,
  });

  const transitionMutation = useMutation<SecurityFindingItem, Error, { status: FindingStatus; note?: string }>({
    mutationFn: ({
      status,
      note,
    }: {
      status: FindingStatus;
      note?: string;
    }) =>
      api.post(`/security/findings/${findingId}/transition`, {
        status,
        note: note?.trim() || undefined,
      }),
    onSuccess: (updated) => {
      toast({
        title: "Finding updated",
        description: `Status changed to ${updated?.status || "updated"}`,
      });
      setTransitionDialog(null);
      setTransitionNote("");
      void queryClient.invalidateQueries({ queryKey: ["security", "finding", findingId] });
      void queryClient.invalidateQueries({ queryKey: ["security", "findings"] });
      void queryClient.invalidateQueries({ queryKey: ["security", "overview"] });
    },
    onError: (err) => {
      toast({
        title: "Failed to update status",
        description: err.message || "An error occurred",
        variant: "destructive",
      });
    },
  });

  const handleStatusChange = (status: FindingStatus, title: string) => {
    setTransitionDialog({ status, title });
    setTransitionNote("");
  };

  const submitTransition = () => {
    if (!transitionDialog) return;
    transitionMutation.mutate({
      status: transitionDialog.status,
      note: transitionNote,
    });
  };

  return (
    <>
      <Sheet open={findingId !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent className="sm:max-w-2xl overflow-y-auto w-full p-6 space-y-6">
          {isLoading && (
            <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
              <Clock className="h-5 w-5 animate-spin mr-2" />
              Loading finding details...
            </div>
          )}

          {!isLoading && finding && (
            <>
              <SheetHeader className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant="outline"
                    className={`font-semibold uppercase text-xs ${SEVERITY_BADGE_CLASSES[finding.severity]}`}
                  >
                    {finding.severity}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={`capitalize text-xs ${STATUS_BADGE_CLASSES[finding.status]}`}
                  >
                    {finding.status.replace("_", " ")}
                  </Badge>
                  <Badge variant="secondary" className="text-xs">
                    {finding.category}
                  </Badge>
                </div>
                <SheetTitle className="text-lg font-bold leading-snug">
                  {finding.title}
                </SheetTitle>
                <SheetDescription className="text-sm text-muted-foreground">
                  {finding.description}
                </SheetDescription>
              </SheetHeader>

              {/* Action Buttons */}
              <div className="flex flex-wrap gap-2 pt-1 pb-2 border-y border-border">
                {finding.status !== "investigating" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleStatusChange("investigating", "Start Investigation")}
                  >
                    <Eye className="h-3.5 w-3.5 mr-1.5 text-blue-400" />
                    Investigate
                  </Button>
                )}
                {finding.status !== "acknowledged" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleStatusChange("acknowledged", "Acknowledge Finding")}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-amber-400" />
                    Acknowledge
                  </Button>
                )}
                {finding.status !== "resolved" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleStatusChange("resolved", "Mark as Resolved")}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-emerald-400" />
                    Resolve
                  </Button>
                )}
                {finding.remediation_available && (
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => onRemediateClick?.(finding)}
                  >
                    <Wrench className="h-3.5 w-3.5 mr-1.5" />
                    Remediate
                  </Button>
                )}
                {finding.status !== "ignored" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => handleStatusChange("ignored", "Ignore Finding")}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1.5" />
                    Ignore
                  </Button>
                )}
                {finding.status !== "false_positive" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => handleStatusChange("false_positive", "Mark as False Positive")}
                  >
                    <HelpCircle className="h-3.5 w-3.5 mr-1.5" />
                    False Positive
                  </Button>
                )}
              </div>

              {/* Target & Scope */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Target Information
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm bg-muted/40 p-3.5 rounded-lg border border-border/50">
                  {finding.server && (
                    <div className="flex items-center gap-2">
                      <ServerIcon className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-xs text-muted-foreground">Server</div>
                        <div className="font-medium">{finding.server.name}</div>
                        <div className="text-xs text-muted-foreground">{finding.server.ip_address}</div>
                      </div>
                    </div>
                  )}
                  {finding.environment && (
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-xs text-muted-foreground">Environment</div>
                        <div className="font-medium">
                          {finding.environment.project?.name || "Project"} ({finding.environment.type})
                        </div>
                        <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {finding.environment.url}
                        </div>
                      </div>
                    </div>
                  )}
                  {finding.resource && (
                    <div className="sm:col-span-2 flex items-start gap-2 pt-1 border-t border-border/40">
                      <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div className="min-w-0">
                        <div className="text-xs text-muted-foreground">Affected Resource</div>
                        <div className="font-mono text-xs break-all bg-background/80 px-2 py-1 rounded border border-border/50 mt-1">
                          {finding.resource}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Recommendation */}
              {finding.recommendation && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5 text-blue-400" />
                    Remediation & Recommendation
                  </h4>
                  <div className="p-3.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm leading-relaxed text-slate-200">
                    {finding.recommendation}
                  </div>
                </div>
              )}

              {/* Evidence / Metadata */}
              {finding.evidence && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Terminal className="h-3.5 w-3.5 text-amber-400" />
                    Evidence & Details
                  </h4>
                  <div className="bg-zinc-950 p-3.5 rounded-lg border border-border/60 overflow-x-auto">
                    <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap break-words">
                      {typeof finding.evidence === "string"
                        ? finding.evidence
                        : JSON.stringify(finding.evidence, null, 2)}
                    </pre>
                  </div>
                </div>
              )}

              {/* Timestamps */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Timeline
                </h4>
                <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground bg-muted/20 p-3 rounded-lg border border-border/40">
                  <div>
                    <span className="block font-medium text-foreground">First Seen</span>
                    {new Date(finding.first_seen_at).toLocaleString()}
                  </div>
                  <div>
                    <span className="block font-medium text-foreground">Last Seen</span>
                    {new Date(finding.last_seen_at).toLocaleString()}
                  </div>
                  <div>
                    <span className="block font-medium text-foreground">Resolved At</span>
                    {finding.resolved_at
                      ? new Date(finding.resolved_at).toLocaleString()
                      : "Not resolved"}
                  </div>
                </div>
              </div>

              {/* Transition History */}
              {finding.transitions && finding.transitions.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5" />
                    Activity History
                  </h4>
                  <div className="space-y-2 border-l-2 border-border pl-3 ml-1.5">
                    {finding.transitions.map((t) => (
                      <div key={t.id} className="text-xs space-y-0.5 relative py-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground capitalize">
                            {t.to_status.replace("_", " ")}
                          </span>
                          {t.from_status && (
                            <span className="text-muted-foreground">
                              from {t.from_status.replace("_", " ")}
                            </span>
                          )}
                          <span className="text-muted-foreground text-[10px]">
                            {new Date(t.created_at).toLocaleString()}
                          </span>
                        </div>
                        {t.actor && (
                          <div className="text-muted-foreground text-[11px]">
                            by {t.actor.name} ({t.actor.email})
                          </div>
                        )}
                        {t.note && (
                          <div className="bg-muted/40 text-foreground p-2 rounded text-xs mt-1 border border-border/40">
                            {t.note}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Status Transition Dialog */}
      <Dialog
        open={transitionDialog !== null}
        onOpenChange={(open) => !open && setTransitionDialog(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{transitionDialog?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Add an optional note to record reasons or context for this status update in the audit trail.
            </p>
            <Textarea
              placeholder="e.g. Verified legitimate script; accepted risk for staging..."
              value={transitionNote}
              onChange={(e) => setTransitionNote(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTransitionDialog(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={submitTransition}
              disabled={transitionMutation.isPending}
            >
              {transitionMutation.isPending ? "Updating..." : "Confirm Status"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
