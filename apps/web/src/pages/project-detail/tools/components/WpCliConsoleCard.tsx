import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Terminal,
  Play,
  Loader2,
  Copy,
  Check,
  Trash2,
  Clock,
  Sparkles,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface WpCliResponse {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const PRESET_COMMANDS = [
  { label: "⚡ Flush Cache", command: "cache flush", desc: "Flush object cache and rewrite rules" },
  { label: "🧹 Delete Transients", command: "transient delete --all", desc: "Purge all expired & active transients" },
  { label: "🔄 Reset Permalinks", command: "rewrite structure /%postname%/", desc: "Enforce standard pretty permalinks" },
  { label: "📊 DB Table Sizes", command: "db size --tables", desc: "Inspect disk size per database table" },
  { label: "🛠️ Check Database", command: "db check", desc: "Verify database table integrity" },
  { label: "⚡ Optimize Database", command: "db optimize", desc: "Run MySQL table optimization" },
  { label: "👤 List Administrators", command: "user list --role=administrator", desc: "Audit user accounts with admin role" },
  { label: "🔌 Plugin Status", command: "plugin status", desc: "Inspect active/inactive plugins and updates" },
  { label: "🎨 Theme List", command: "theme list", desc: "List all installed themes and active theme" },
  { label: "⏰ WP Cron Events", command: "cron event list", desc: "List all scheduled WordPress cron hooks" },
  { label: "🌐 Get Site URL", command: "option get siteurl", desc: "Check siteurl option value" },
  { label: "🏠 Get Home URL", command: "option get home", desc: "Check home option value" },
];

export function WpCliConsoleCard({
  selectedEnvId,
}: {
  selectedEnvId: number | null;
}) {
  const [command, setCommand] = useState("cache flush");
  const [output, setOutput] = useState<WpCliResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  const cliMutation = useMutation({
    mutationFn: (cmd: string) => {
      if (!selectedEnvId) throw new Error("No environment selected");
      return api.post<WpCliResponse>(
        `/environments/${selectedEnvId}/wp-actions/cli`,
        { command: cmd },
      );
    },
    onSuccess: (data) => {
      setOutput(data);
      setHistory((prev) => {
        const next = [data.command, ...prev.filter((c) => c !== data.command)];
        return next.slice(0, 10);
      });
      if (data.exitCode === 0) {
        toast({
          title: "Command Succeeded",
          description: `${data.command} executed in ${data.durationMs}ms`,
        });
      } else {
        toast({
          title: `Command Failed (exit ${data.exitCode})`,
          description: data.stderr || "Non-zero exit code returned",
          variant: "destructive",
        });
      }
    },
    onError: (err: any) => {
      toast({
        title: "Execution Error",
        description: err?.message || "Failed to execute WP-CLI command",
        variant: "destructive",
      });
    },
  });

  const handleRun = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!command.trim() || !selectedEnvId || cliMutation.isPending) return;
    cliMutation.mutate(command.trim());
  };

  const handlePresetSelect = (val: string) => {
    setCommand(val);
    if (selectedEnvId) {
      cliMutation.mutate(val);
    }
  };

  const handleCopy = () => {
    if (!output) return;
    const fullText = `Command: ${output.command}\nExit Code: ${output.exitCode}\nDuration: ${output.durationMs}ms\n\nSTDOUT:\n${output.stdout}\n\nSTDERR:\n${output.stderr}`;
    void navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="border border-border/60 shadow-sm overflow-hidden">
      <CardHeader className="pb-3 border-b border-border/30 bg-muted/20">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <Terminal className="h-4 w-4 text-primary" />
              WP-CLI Developer Console
            </CardTitle>
            <CardDescription className="text-xs">
              Execute arbitrary WP-CLI commands remotely with live output capture and presets
            </CardDescription>
          </div>

          {/* Preset Selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-amber-500" /> Presets:
            </span>
            <Select onValueChange={handlePresetSelect}>
              <SelectTrigger className="h-8 w-44 sm:w-56 text-xs bg-background">
                <SelectValue placeholder="Quick presets..." />
              </SelectTrigger>
              <SelectContent>
                {PRESET_COMMANDS.map((p) => (
                  <SelectItem key={p.command} value={p.command} className="text-xs">
                    <span className="font-medium">{p.label}</span>
                    <span className="text-muted-foreground text-[10px] block font-mono">
                      wp {p.command}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        {/* Command Form */}
        <form onSubmit={handleRun} className="flex gap-2 items-center">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground select-none">
              wp
            </span>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. cache flush, db check, option get home"
              className="pl-9 font-mono text-xs h-9 bg-muted/20"
              disabled={!selectedEnvId || cliMutation.isPending}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            className="h-9 px-4 text-xs gap-1.5 shrink-0"
            disabled={!selectedEnvId || !command.trim() || cliMutation.isPending}
          >
            {cliMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
            <span>Run</span>
          </Button>
        </form>

        {/* History Pills */}
        {history.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
            <span className="text-[11px] font-medium shrink-0">Recent:</span>
            {history.map((h, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setCommand(h);
                  if (selectedEnvId) cliMutation.mutate(h);
                }}
                className="font-mono text-[11px] bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border/40 transition-colors truncate max-w-[200px]"
              >
                {h}
              </button>
            ))}
          </div>
        )}

        {/* Terminal Output Window */}
        <div className="rounded-lg border border-slate-800 bg-slate-950 text-slate-100 overflow-hidden shadow-inner">
          {/* Terminal Title Bar */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-slate-900/60 text-xs">
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500/80 inline-block" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-500/80 inline-block" />
              </div>
              <span className="text-slate-400 font-mono text-[11px]">
                {output ? output.command : "console output"}
              </span>
            </div>

            {output && (
              <div className="flex items-center gap-2">
                <Badge
                  variant={output.exitCode === 0 ? "success" : "destructive"}
                  className="text-[10px] px-1.5 py-0 font-mono"
                >
                  exit {output.exitCode}
                </Badge>
                <span className="text-[11px] text-slate-400 font-mono flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {output.durationMs < 1000
                    ? `${output.durationMs}ms`
                    : `${(output.durationMs / 1000).toFixed(1)}s`}
                </span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="text-slate-400 hover:text-slate-200 transition-colors p-1"
                  title="Copy output"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setOutput(null)}
                  className="text-slate-400 hover:text-slate-200 transition-colors p-1"
                  title="Clear output"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {/* Console Body */}
          <div className="p-4 font-mono text-xs max-h-80 overflow-y-auto whitespace-pre-wrap leading-relaxed select-text">
            {cliMutation.isPending ? (
              <div className="flex items-center gap-2 text-slate-400 py-4">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span>Executing WP-CLI command on remote server...</span>
              </div>
            ) : output ? (
              <div className="space-y-2">
                {output.stdout && (
                  <div className="text-slate-200">{output.stdout}</div>
                )}
                {output.stderr && (
                  <div className="text-red-400 bg-red-950/30 p-2 rounded border border-red-900/50">
                    {output.stderr}
                  </div>
                )}
                {!output.stdout && !output.stderr && (
                  <div className="text-slate-500 italic">
                    (Command executed with no output returned)
                  </div>
                )}
              </div>
            ) : (
              <div className="text-slate-500 italic py-2">
                Ready. Select a preset or type a WP-CLI command above and click "Run".
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
