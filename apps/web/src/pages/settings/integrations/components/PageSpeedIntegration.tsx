import { useState, useEffect } from "react";
import {
  Gauge,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  Key,
  ExternalLink,
  Zap,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  usePagespeedStatus,
  useSavePagespeed,
  useTestPagespeed,
  useDeletePagespeed,
} from "../hooks";

export function PageSpeedIntegration() {
  const { data: status, isLoading } = usePagespeedStatus();
  const saveMutation = useSavePagespeed();
  const testMutation = useTestPagespeed();
  const deleteMutation = useDeletePagespeed();

  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<"auto" | "local" | "pagespeed">("auto");
  const [testUrl, setTestUrl] = useState("https://example.com");
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    score?: number | null;
  } | null>(null);

  useEffect(() => {
    if (status?.provider) {
      setProvider(status.provider);
    }
  }, [status?.provider]);

  async function handleSave() {
    await saveMutation.mutateAsync({
      apiKey: apiKey.trim() || undefined,
      provider,
    });
    setApiKey("");
  }

  async function handleTest() {
    setTestResult(null);
    const res = await testMutation.mutateAsync(testUrl.trim() || undefined);
    setTestResult({
      success: res.success,
      message: res.message,
      score: (res.data as any)?.score,
    });
  }

  async function handleDelete() {
    if (confirm("Are you sure you want to remove the PageSpeed API key?")) {
      await deleteMutation.mutateAsync();
      setTestResult(null);
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-muted/40 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-500/10 rounded-lg">
            <Gauge className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <CardTitle className="text-lg">Google PageSpeed & Lighthouse</CardTitle>
            <CardDescription>
              Configure Lighthouse performance audits and Google PageSpeed Insights API fallback.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-6 space-y-6">
        {/* Status card */}
        <div className="border rounded-xl p-5 bg-muted/20 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-background flex items-center justify-center border shadow-sm shrink-0">
                <Zap className="h-6 w-6 text-amber-500" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold">Audit Engine Status</p>
                  {isLoading ? (
                    <Badge variant="outline">Checking...</Badge>
                  ) : status?.hasApiKey ? (
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      API Key Configured
                    </Badge>
                  ) : status?.configured ? (
                    <Badge variant="secondary">Ready (Local Engine)</Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-500 border-amber-500/30">
                      Fallback Unconfigured
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {status?.hasApiKey
                    ? `Active Key: ${status.apiKeyPreview} · Provider Mode: ${status.provider.toUpperCase()}`
                    : "No Google PageSpeed API key set. Local Lighthouse runs with public fallback."}
                </p>
              </div>
            </div>

            {status?.hasApiKey && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/20 gap-1.5 self-start sm:self-auto"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Remove Key
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="lighthouse-provider">Audit Provider Strategy</Label>
              <Select
                value={provider}
                onValueChange={(val: "auto" | "local" | "pagespeed") => setProvider(val)}
              >
                <SelectTrigger id="lighthouse-provider">
                  <SelectValue placeholder="Select strategy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    Auto (Local Lighthouse with PageSpeed fallback)
                  </SelectItem>
                  <SelectItem value="pagespeed">
                    Google PageSpeed Insights API (Cloud)
                  </SelectItem>
                  <SelectItem value="local">
                    Local Chromium Lighthouse Only
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Auto attempts local Chromium rendering first and seamlessly falls back to Google PageSpeed.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pagespeed-api-key" className="flex items-center gap-1.5">
                <Key className="h-3.5 w-3.5 text-muted-foreground" />
                Google PageSpeed API Key
              </Label>
              <Input
                id="pagespeed-api-key"
                type="password"
                placeholder={
                  status?.hasApiKey
                    ? `Stored (${status.apiKeyPreview}) - leave empty to keep`
                    : "AIzaSy..."
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground flex items-center justify-between">
                <span>Free API key from Google Cloud Console.</span>
                <a
                  href="https://developers.google.com/speed/docs/insights/v5/get-started"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Get API key <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending || (!apiKey.trim() && provider === status?.provider)}
              className="gap-1.5"
            >
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save Configuration
            </Button>
          </div>
        </div>

        {/* Test Connection section */}
        <div className="border rounded-xl p-5 space-y-4">
          <div>
            <h4 className="text-sm font-semibold">Test Audit Connection</h4>
            <p className="text-xs text-muted-foreground">
              Run a live test audit against Google PageSpeed Insights to verify your API credentials.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="https://example.com"
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
              className="flex-1"
            />
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testMutation.isPending}
              className="gap-1.5 shrink-0"
            >
              {testMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Running Audit...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 text-amber-500" />
                  Test PageSpeed API
                </>
              )}
            </Button>
          </div>

          {testResult && (
            <div
              className={`p-3.5 rounded-lg border text-xs flex items-start gap-2.5 ${
                testResult.success
                  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                  : "bg-destructive/10 border-destructive/20 text-destructive"
              }`}
            >
              {testResult.success ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1">
                <p className="font-semibold">{testResult.message}</p>
                {testResult.score != null && (
                  <p className="text-[11px] opacity-90">
                    Performance Score: <span className="font-bold">{testResult.score}/100</span>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
