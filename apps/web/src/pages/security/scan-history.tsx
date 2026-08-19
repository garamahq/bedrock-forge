import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import type { ScanRecord, ScanHistory } from "./types";
import { SCAN_FINDINGS_INITIAL_LIMIT } from "./constants";
import { formatScanType, groupScansByRun } from "./utils";
import { ScoreRing, SummaryBadges, StatusDot, FindingItem } from "./components";

// ─── ScanHistoryRow ───────────────────────────────────────────────────────────

function ScanHistoryRow({
  scan,
  targetType,
  onFix,
}: {
  scan: ScanRecord;
  targetType?: "server" | "environment";
  onFix?: (actionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { data: fullScan } = useQuery<ScanRecord>({
    queryKey: ["security", "scan", scan.id],
    queryFn: () => api.get(`/security/scans/${scan.id}`),
    enabled: expanded && scan.status === "completed",
  });

  const findings = fullScan?.findings ?? scan.findings ?? [];
  const summaryTotal = scan.summary
    ? (scan.summary.critical ?? 0) +
      (scan.summary.high ?? 0) +
      (scan.summary.medium ?? 0) +
      (scan.summary.low ?? 0) +
      (scan.summary.info ?? 0)
    : 0;
  const findingCount = fullScan ? findings.length : summaryTotal;
  const visibleFindings = showAll
    ? findings
    : findings.slice(0, SCAN_FINDINGS_INITIAL_LIMIT);
  const hiddenCount = findings.length - SCAN_FINDINGS_INITIAL_LIMIT;

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-xs font-mono font-semibold">
            {formatScanType(scan.scan_type)}
          </span>
          <StatusDot status={scan.status} />
          {scan.score !== null && <ScoreRing score={scan.score} />}
          {scan.summary && <SummaryBadges summary={scan.summary} />}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {scan.completed_at
              ? new Date(scan.completed_at).toLocaleString()
              : scan.created_at
                ? new Date(scan.created_at).toLocaleString()
                : "—"}
          </span>
          {scan.status === "completed" && summaryTotal > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => {
                if (expanded) setShowAll(false);
                setExpanded((v) => !v);
              }}
            >
              {expanded
                ? "Hide"
                : `${findingCount} finding${findingCount !== 1 ? "s" : ""}`}
            </Button>
          )}
          {scan.status === "failed" && scan.error && (
            <span
              className="text-xs text-destructive truncate max-w-[240px]"
              title={scan.error}
            >
              {scan.error.slice(0, 80)}
            </span>
          )}
        </div>
      </div>
      {expanded && findings.length > 0 && (
        <div className="mt-2 space-y-1">
          {visibleFindings.map((f) => (
            <FindingItem
              key={f.id}
              finding={f}
              targetType={targetType}
              onFix={onFix}
            />
          ))}
          {!showAll && hiddenCount > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="text-xs text-muted-foreground hover:text-foreground px-1 py-0.5 mt-0.5 underline-offset-2 hover:underline"
            >
              Show {hiddenCount} more finding{hiddenCount !== 1 ? "s" : ""}…
            </button>
          )}
          {showAll && findings.length > SCAN_FINDINGS_INITIAL_LIMIT && (
            <button
              onClick={() => setShowAll(false)}
              className="text-xs text-muted-foreground hover:text-foreground px-1 py-0.5 mt-0.5 underline-offset-2 hover:underline"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ScanRunGroup ─────────────────────────────────────────────────────────────

function ScanRunGroup({
  scans,
  targetType,
  onFix,
}: {
  scans: ScanRecord[];
  targetType: "server" | "environment";
  onFix?: (actionId: string) => void;
}) {
  return (
    <div className="divide-y">
      {scans.map((scan) => (
        <ScanHistoryRow
          key={scan.id}
          scan={scan}
          targetType={targetType}
          onFix={onFix}
        />
      ))}
    </div>
  );
}

// ─── ScanHistoryGroups ────────────────────────────────────────────────────────

function ScanHistoryGroups({
  scans,
  total,
  targetType,
  onFix,
  onLoadMore,
}: {
  scans: ScanRecord[];
  total: number;
  targetType: "server" | "environment";
  onFix?: (actionId: string) => void;
  onLoadMore?: () => void;
}) {
  const [showOlderRuns, setShowOlderRuns] = useState(false);
  const groups = groupScansByRun(scans);
  const latestGroup = groups[0];
  const olderGroups = groups.slice(1);

  return (
    <div>
      <ScanRunGroup scans={latestGroup} targetType={targetType} onFix={onFix} />
      {olderGroups.length > 0 && (
        <>
          <button
            className="w-full text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 border-t text-left hover:bg-accent/30 transition-colors"
            onClick={() => setShowOlderRuns((v) => !v)}
          >
            {showOlderRuns
              ? "Hide older runs"
              : `Show ${olderGroups.length} older run${
                  olderGroups.length !== 1 ? "s" : ""
                }…`}
          </button>
          {showOlderRuns &&
            olderGroups.map((group, i) => (
              <div key={i} className="border-t">
                <p className="text-[10px] text-muted-foreground px-3 py-1 bg-muted/40 font-medium">
                  Run:{" "}
                  {new Date(
                    group[0].completed_at ?? group[0].created_at,
                  ).toLocaleString()}
                </p>
                <ScanRunGroup
                  scans={group}
                  targetType={targetType}
                  onFix={onFix}
                />
              </div>
            ))}
        </>
      )}
      {onLoadMore && scans.length < total && (
        <button
          className="w-full text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 border-t text-left hover:bg-accent/30 transition-colors"
          onClick={onLoadMore}
        >
          Load more…
        </button>
      )}
    </div>
  );
}

// ─── ServerScanHistory ────────────────────────────────────────────────────────

export function ServerScanHistory({
  serverId,
  onFix,
}: {
  serverId: number;
  onFix?: (actionId: string) => void;
}) {
  const [limit, setLimit] = useState(10);
  const { data } = useQuery<ScanHistory>({
    queryKey: ["security", "server-history", serverId, limit],
    queryFn: () =>
      api.get(`/security/servers/${serverId}/scans?limit=${limit}`),
    refetchInterval: (query) => {
      const records = query.state.data?.data;
      const hasActive = records?.some(
        (s) => s.status === "running" || s.status === "pending",
      );
      return hasActive ? 3_000 : false;
    },
  });

  if (!data?.data.length)
    return <p className="text-xs text-muted-foreground p-3">No scans yet.</p>;

  return (
    <ScanHistoryGroups
      scans={data.data}
      total={data.total}
      targetType="server"
      onFix={onFix}
      onLoadMore={() => setLimit((l) => l + 15)}
    />
  );
}

// ─── EnvironmentScanHistory ───────────────────────────────────────────────────

export function EnvironmentScanHistory({
  envId,
  onFix,
}: {
  envId: number;
  onFix?: (actionId: string) => void;
}) {
  const [limit, setLimit] = useState(10);
  const { data } = useQuery<ScanHistory>({
    queryKey: ["security", "env-history", envId, limit],
    queryFn: () =>
      api.get(`/security/environments/${envId}/scans?limit=${limit}`),
    refetchInterval: (query) => {
      const records = query.state.data?.data;
      const hasActive = records?.some(
        (s) => s.status === "running" || s.status === "pending",
      );
      return hasActive ? 3_000 : false;
    },
  });

  if (!data?.data.length)
    return <p className="text-xs text-muted-foreground p-3">No scans yet.</p>;

  return (
    <ScanHistoryGroups
      scans={data.data}
      total={data.total}
      targetType="environment"
      onFix={onFix}
      onLoadMore={() => setLimit((l) => l + 15)}
    />
  );
}
