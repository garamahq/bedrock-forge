import React, { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Shield,
  ServerIcon,
  FolderKanban,
  ListFilter,
  RefreshCw,
  Clock,
  GitCompare,
  Flame,
  BellRing,
  Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="overview">
            <Shield className="h-3.5 w-3.5 mr-1.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="incidents">
            <Flame className="h-3.5 w-3.5 mr-1.5 text-red-500" />
            Incidents
          </TabsTrigger>
          <TabsTrigger value="watcher">
            <Radio className="h-3.5 w-3.5 mr-1.5 text-emerald-500" />
            Threat Watcher
          </TabsTrigger>
          <TabsTrigger value="servers">
            <ServerIcon className="h-3.5 w-3.5 mr-1.5" />
            Servers
          </TabsTrigger>
          <TabsTrigger value="projects">
            <FolderKanban className="h-3.5 w-3.5 mr-1.5" />
            Projects
          </TabsTrigger>
          <TabsTrigger value="findings">
            <ListFilter className="h-3.5 w-3.5 mr-1.5" />
            Findings
          </TabsTrigger>
          <TabsTrigger value="baseline">
            <GitCompare className="h-3.5 w-3.5 mr-1.5" />
            Baseline & Drift
          </TabsTrigger>
          <TabsTrigger value="alert-rules">
            <BellRing className="h-3.5 w-3.5 mr-1.5" />
            Alert Rules
          </TabsTrigger>
          <TabsTrigger value="schedules">
            <Clock className="h-3.5 w-3.5 mr-1.5" />
            Schedules
          </TabsTrigger>
        </TabsList>

        <div className="mt-4">
          {isError && !overview && (
            <ErrorState
              title="Security overview could not be loaded"
              description="Security features are unavailable until the overview request succeeds."
              onRetry={() => void refetch()}
            />
          )}
          {!overview && isFetching && (
            <div className="flex justify-center py-16">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {overview && (
            <>
              <TabsContent value="overview">
                <OverviewTab data={overview} />
              </TabsContent>
              <TabsContent value="incidents">
                <IncidentsTab servers={overview.servers} />
              </TabsContent>
              <TabsContent value="watcher">
                <WatcherTab servers={overview.servers} />
              </TabsContent>
              <TabsContent value="servers">
                <ServerSecurityTab data={overview} />
              </TabsContent>
              <TabsContent value="projects">
                <ProjectSecurityTab data={overview} />
              </TabsContent>
              <TabsContent value="findings">
                <FindingsTab
                  servers={overview.servers}
                  environments={overview.environments}
                />
              </TabsContent>
              <TabsContent value="baseline">
                <BaselineDriftTab
                  servers={overview.servers}
                  environments={overview.environments}
                />
              </TabsContent>
              <TabsContent value="alert-rules">
                <AlertRulesTab servers={overview.servers} />
              </TabsContent>
              <TabsContent value="schedules">
                <Tabs defaultValue="server-schedules">
                  <TabsList className="mb-4">
                    <TabsTrigger value="server-schedules">Servers</TabsTrigger>
                    <TabsTrigger value="project-schedules">
                      Projects
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="server-schedules">
                    <ServerSchedulesTab data={overview} />
                  </TabsContent>
                  <TabsContent value="project-schedules">
                    <ProjectSchedulesTab data={overview} />
                  </TabsContent>
                </Tabs>
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </div>
  );
}
