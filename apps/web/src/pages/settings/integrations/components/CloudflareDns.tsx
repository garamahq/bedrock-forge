import { useState } from "react";
import { Cloud, Loader2, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  useCloudflareStatus,
  useCloudflareDnsRecords,
  useSaveCloudflare,
  useTestCloudflare,
  usePurgeCloudflare,
  useToggleDevelopmentMode,
  useToggleDnsProxy,
} from "../hooks";

export function CloudflareDns() {
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [cloudflareZoneId, setCloudflareZoneId] = useState("");
  const [cloudflareZoneName, setCloudflareZoneName] = useState("");
  const [cloudflareTestResult, setCloudflareTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const { data: cloudflareStatus } = useCloudflareStatus();
  const saveCloudflare = useSaveCloudflare();
  const testCloudflare = useTestCloudflare();
  const purgeCloudflare = usePurgeCloudflare();
  const toggleDevelopmentMode = useToggleDevelopmentMode();
  const toggleDnsProxy = useToggleDnsProxy();

  const { data: dnsRecords = [], refetch: refetchDns } =
    useCloudflareDnsRecords(!!cloudflareStatus?.configured);

  async function handleSave() {
    await saveCloudflare.mutateAsync({
      api_token: cloudflareToken,
      zone_id: cloudflareZoneId,
      zone_name: cloudflareZoneName,
    });
    setCloudflareToken("");
    setCloudflareTestResult(null);
  }

  async function handleTest() {
    setCloudflareTestResult(null);
    try {
      const result = await testCloudflare.mutateAsync();
      setCloudflareTestResult(result);
    } catch (err) {
      setCloudflareTestResult({
        success: false,
        message:
          err instanceof Error ? err.message : "Connection test failed.",
      });
    }
  }

  return (
    <Card>
      <CardHeader className="bg-muted/40 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-info/10 rounded-lg">
            <Cloud className="h-5 w-5 text-info" />
          </div>
          <div>
            <CardTitle className="text-lg">Cloudflare</CardTitle>
            <CardDescription>DNS, cache, and zone controls.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-6 space-y-6">
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4">
          <div>
            <p className="text-sm font-semibold">
              {cloudflareStatus?.zone_name ||
                cloudflareStatus?.zone_id ||
                "No zone linked"}
            </p>
            <p className="text-xs text-muted-foreground">
              {cloudflareStatus?.configured
                ? "Token stored encrypted"
                : "Add an API token and zone ID"}
            </p>
          </div>
          <Badge variant={cloudflareStatus?.configured ? "success" : "outline"}>
            {cloudflareStatus?.configured ? "Connected" : "Not Configured"}
          </Badge>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs font-semibold text-muted-foreground">
              API Token
            </Label>
            <Input
              type="password"
              value={cloudflareToken}
              onChange={(event) => setCloudflareToken(event.target.value)}
              placeholder="Cloudflare API token"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">
              Zone ID
            </Label>
            <Input
              value={cloudflareZoneId}
              onChange={(event) => setCloudflareZoneId(event.target.value)}
              placeholder={cloudflareStatus?.zone_id ?? "zone id"}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">
              Zone Name
            </Label>
            <Input
              value={cloudflareZoneName}
              onChange={(event) => setCloudflareZoneName(event.target.value)}
              placeholder={cloudflareStatus?.zone_name ?? "example.com"}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={
              saveCloudflare.isPending ||
              cloudflareToken.length < 20 ||
              cloudflareZoneId.length < 3
            }
          >
            {saveCloudflare.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleTest}
            disabled={!cloudflareStatus?.configured || testCloudflare.isPending}
          >
            {testCloudflare.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1.5" />
            )}
            Test
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => purgeCloudflare.mutate()}
            disabled={
              !cloudflareStatus?.configured || purgeCloudflare.isPending
            }
          >
            Purge Cache
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => toggleDevelopmentMode.mutate(true)}
            disabled={
              !cloudflareStatus?.configured || toggleDevelopmentMode.isPending
            }
          >
            Dev Mode On
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => toggleDevelopmentMode.mutate(false)}
            disabled={
              !cloudflareStatus?.configured || toggleDevelopmentMode.isPending
            }
          >
            Dev Mode Off
          </Button>
        </div>

        {cloudflareTestResult && (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${cloudflareTestResult.success ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"}`}
          >
            {cloudflareTestResult.message}
          </div>
        )}

        <div className="rounded-lg border overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">DNS Records</p>
            <Button size="sm" variant="ghost" onClick={() => refetchDns()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <div className="divide-y max-h-96 overflow-auto">
            {dnsRecords.map((record) => (
              <div
                key={record.id}
                className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[70px_1fr_1fr_auto] md:items-center"
              >
                <Badge variant="outline">{record.type}</Badge>
                <span className="truncate font-medium">{record.name}</span>
                <span className="truncate text-muted-foreground">
                  {record.content}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggleDnsProxy.mutate(record)}
                  disabled={toggleDnsProxy.isPending}
                >
                  {record.proxied ? "Proxied" : "DNS Only"}
                </Button>
              </div>
            ))}
            {dnsRecords.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No DNS records loaded.
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
