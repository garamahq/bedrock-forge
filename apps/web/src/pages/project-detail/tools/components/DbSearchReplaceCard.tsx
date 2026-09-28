import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  GitCompare,
  Search,
  ArrowRight,
  ShieldCheck,
  AlertTriangle,
  Play,
  Loader2,
  Copy,
  Check,
  Table,
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

interface SearchReplaceResponse {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  dryRun: boolean;
}

export function DbSearchReplaceCard({
  selectedEnvId,
}: {
  selectedEnvId: number | null;
}) {
  const [search, setSearch] = useState("");
  const [replace, setReplace] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [skipTransients, setSkipTransients] = useState(true);
  const [tables, setTables] = useState("");
  const [result, setResult] = useState<SearchReplaceResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const srMutation = useMutation({
    mutationFn: () => {
      if (!selectedEnvId) throw new Error("No environment selected");
      return api.post<SearchReplaceResponse>(
        `/environments/${selectedEnvId}/wp-actions/search-replace`,
        {
          search: search.trim(),
          replace: replace.trim(),
          dry_run: dryRun,
          skip_transients: skipTransients,
          tables: tables.trim() || undefined,
        },
      );
    },
    onSuccess: (data) => {
      setResult(data);
      if (data.exitCode === 0) {
        toast({
          title: data.dryRun ? "Dry Run Completed" : "Search & Replace Succeeded",
          description: `Executed in ${(data.durationMs / 1000).toFixed(1)}s`,
        });
      } else {
        toast({
          title: "Search & Replace Failed",
          description: data.stderr || "Non-zero exit code returned",
          variant: "destructive",
        });
      }
    },
    onError: (err) => {
      toast({
        title: "Execution Error",
        description: err?.message || "Failed to run search & replace",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!search.trim() || !selectedEnvId || srMutation.isPending) return;

    if (!dryRun) {
      const confirmed = window.confirm(
        `CAUTION: You are about to replace "${search}" with "${replace}" on the live database WITHOUT dry-run.\n\nAre you sure you want to proceed?`,
      );
      if (!confirmed) return;
    }

    srMutation.mutate();
  };

  const handleCopy = () => {
    if (!result) return;
    void navigator.clipboard.writeText(result.stdout || result.stderr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="border border-border/60 shadow-sm overflow-hidden">
      <CardHeader className="pb-3 border-b border-border/30 bg-muted/20">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <GitCompare className="h-4 w-4 text-primary" />
              Database Search & Replace
            </CardTitle>
            <CardDescription className="text-xs">
              Safely find and replace URLs, protocols, or strings across serialized WordPress tables
            </CardDescription>
          </div>
          {dryRun && (
            <Badge variant="outline" className="border-emerald-500/50 text-emerald-600 dark:text-emerald-400 gap-1 text-xs self-start sm:self-auto">
              <ShieldCheck className="h-3.5 w-3.5" />
              Dry Run Active (Safe Preview)
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Search Input */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium flex items-center gap-1.5">
                <Search className="h-3 w-3 text-muted-foreground" /> Search String:
              </Label>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="e.g. http://old-domain.local"
                className="text-xs h-9 font-mono"
                required
                disabled={!selectedEnvId || srMutation.isPending}
              />
            </div>

            {/* Replace Input */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium flex items-center gap-1.5">
                <ArrowRight className="h-3 w-3 text-muted-foreground" /> Replace With:
              </Label>
              <Input
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                placeholder="e.g. https://new-domain.com"
                className="text-xs h-9 font-mono"
                disabled={!selectedEnvId || srMutation.isPending}
              />
            </div>
          </div>

          {/* Tables filter */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium flex items-center gap-1.5">
              <Table className="h-3 w-3 text-muted-foreground" /> Specific Tables (optional):
            </Label>
            <Input
              value={tables}
              onChange={(e) => setTables(e.target.value)}
              placeholder="Leave empty for all tables, or specify space-separated tables (e.g. wp_options wp_posts)"
              className="text-xs h-8 font-mono bg-muted/20"
              disabled={!selectedEnvId || srMutation.isPending}
            />
          </div>

          {/* Checkboxes & Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1 border-t border-border/30">
            <div className="flex items-center gap-5 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer text-xs select-none">
                <Checkbox
                  checked={dryRun}
                  onCheckedChange={(c) => setDryRun(!!c)}
                  disabled={srMutation.isPending}
                />
                <span className="font-medium">Dry Run (Preview only)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-xs select-none">
                <Checkbox
                  checked={skipTransients}
                  onCheckedChange={(c) => setSkipTransients(!!c)}
                  disabled={srMutation.isPending}
                />
                <span className="text-muted-foreground">Skip Transients</span>
              </label>
            </div>

            <Button
              type="submit"
              size="sm"
              variant={dryRun ? "default" : "destructive"}
              className="h-8 text-xs gap-1.5"
              disabled={!selectedEnvId || !search.trim() || srMutation.isPending}
            >
              {srMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : dryRun ? (
                <Play className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              <span>{dryRun ? "Run Dry Run" : "Execute Live Replace"}</span>
            </Button>
          </div>
        </form>

        {/* Results Area */}
        {result && (
          <div className="mt-4 rounded-lg border border-border/50 bg-slate-950 text-slate-100 overflow-hidden shadow-inner">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60 text-xs">
              <span className="font-mono text-[11px] text-slate-400">
                {result.dryRun ? "Dry Run Report" : "Live Replacement Report"}
              </span>
              <div className="flex items-center gap-2">
                <Badge
                  variant={result.exitCode === 0 ? "success" : "destructive"}
                  className="text-[10px] px-1.5 py-0 font-mono"
                >
                  exit {result.exitCode}
                </Badge>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="text-slate-400 hover:text-slate-200 transition-colors p-1"
                  title="Copy report"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>

            <div className="p-4 font-mono text-xs max-h-72 overflow-y-auto whitespace-pre-wrap leading-relaxed select-text text-slate-200">
              {result.stdout || result.stderr || "No replacements found."}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
