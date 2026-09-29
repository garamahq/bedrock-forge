import React, { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/crud";
import { api } from "@/lib/api-client";
import type { OverviewData } from "./types";
import { OverviewTab } from "./tabs/OverviewTab";
import { ServerSecurityTab } from "./tabs/ServerSecurityTab";
import { ProjectSecurityTab } from "./tabs/ProjectSecurityTab";
import { FindingsTab } from "./tabs/FindingsTab";
import { BaselineDriftTab } from "./tabs/BaselineDriftTab";
import { IncidentsTab } from "./tabs/IncidentsTab";
import { AlertRulesTab } from "./tabs/AlertRulesTab";
import { WatcherTab } from "./tabs/WatcherTab";
import { ServerSchedulesTab, ProjectSchedulesTab } from "./tabs/ScheduleTabs";
import { SecurityScanProgress } from "./components/SecurityScanProgress";
import { ErrorState } from "@/components/crud";

export function SecurityPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") ?? "overview";
  const validTabs = [
    "overview",
    "incidents",
    "watcher",
    "servers",
    "projects",
    "findings",
    "baseline",
    "alert-rules",
    "schedules",
  ];
  const activeTab = validTabs.includes(requestedTab)
    ? requestedTab
    : "overview";

  const {
    data: overview,
    isFetching,
    isError,
    refetch,
  } = useQuery<OverviewData>({
    queryKey: ["security", "overview"],
    queryFn: () => api.get("/security/overview"),
    refetchInterval: 30_000,
  });

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["security"] });
  }, [queryClient]);

  const handleTabChange = useCallback(
    (tab: string) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        if (tab === "overview") next.delete("tab");
        else next.set("tab", tab);
        return next;
      });
    },
    [setSearchParams],
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Security">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </PageHeader>

      <SecurityScanProgress />

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Security workspace</p>
          <Select value={activeTab} onValueChange={handleTabChange}>
            <SelectTrigger
              className="w-full sm:w-72"
              aria-label="Security area"
            >
              <SelectValue placeholder="Choose a security area" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Overview</SelectLabel>
                <SelectItem value="overview">Overview</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Incident response</SelectLabel>
                <SelectItem value="incidents">Incidents</SelectItem>
                <SelectItem value="watcher">Threat Watcher</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Assets</SelectLabel>
                <SelectItem value="servers">Servers</SelectItem>
                <SelectItem value="projects">Projects</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Findings and baselines</SelectLabel>
                <SelectItem value="findings">Findings</SelectItem>
                <SelectItem value="baseline">Baseline & Drift</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Rules and schedules</SelectLabel>
                <SelectItem value="alert-rules">Alert Rules</SelectItem>
                <SelectItem value="schedules">Schedules</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="mt-4">
          <TabsContent value="overview">
            {overview ? (
              <OverviewTab data={overview} />
            ) : isFetching ? (
              <div
                className="flex justify-center py-16"
                role="status"
                aria-label="Loading security overview"
              >
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ErrorState
                title="Security overview could not be loaded"
                description="Retry this overview. Findings, incidents, and other security areas remain available from the selector."
                onRetry={() => void refetch()}
              />
            )}
          </TabsContent>
          <TabsContent value="incidents">
            <IncidentsTab servers={overview?.servers ?? []} />
          </TabsContent>
          <TabsContent value="watcher">
            <WatcherTab servers={overview?.servers ?? []} />
          </TabsContent>
          <TabsContent value="servers">
            {overview ? (
              <ServerSecurityTab data={overview} />
            ) : (
              <ErrorState
                title="Server security data is unavailable"
                onRetry={() => void refetch()}
              />
            )}
          </TabsContent>
          <TabsContent value="projects">
            {overview ? (
              <ProjectSecurityTab data={overview} />
            ) : (
              <ErrorState
                title="Project security data is unavailable"
                onRetry={() => void refetch()}
              />
            )}
          </TabsContent>
          <TabsContent value="findings">
            <FindingsTab
              servers={overview?.servers ?? []}
              environments={overview?.environments ?? []}
            />
          </TabsContent>
          <TabsContent value="baseline">
            <BaselineDriftTab
              servers={overview?.servers ?? []}
              environments={overview?.environments ?? []}
            />
          </TabsContent>
          <TabsContent value="alert-rules">
            <AlertRulesTab servers={overview?.servers ?? []} />
          </TabsContent>
          <TabsContent value="schedules">
            {overview ? (
              <div className="space-y-8">
                <section className="space-y-3">
                  <h2 className="text-base font-semibold">Server schedules</h2>
                  <ServerSchedulesTab data={overview} />
                </section>
                <section className="space-y-3">
                  <h2 className="text-base font-semibold">Project schedules</h2>
                  <ProjectSchedulesTab data={overview} />
                </section>
              </div>
            ) : (
              <ErrorState
                title="Security schedule data is unavailable"
                onRetry={() => void refetch()}
              />
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
