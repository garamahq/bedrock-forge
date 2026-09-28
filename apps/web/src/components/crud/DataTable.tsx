import React, { useState, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState, ErrorState } from "./StateViews";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SlidersHorizontal } from "lucide-react";

export interface Column<T> {
  id?: string;
  header: string;
  render: (row: T) => React.ReactNode;
  className?: string;
  headerClassName?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  isLoading?: boolean;
  emptyMessage?: string;
  emptyDescription?: string | React.ReactNode;
  emptyAction?: React.ReactNode;
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string | number;
  skeletonRows?: number;
  /** Extra cell(s) at the end of each row — used for action buttons */
  renderActions?: (row: T) => React.ReactNode;
  /** Extra header cell for the actions column */
  actionsHeader?: React.ReactNode;
  /** Render a full-width detail row below a given data row. Return null to hide. */
  renderExpandedRow?: (row: T) => React.ReactNode;
  /** Key of the currently expanded row (matches rowKey output) */
  expandedRowKey?: string | number | null;
  /** Show an error state instead of table content */
  isError?: boolean;
  /** Callback for the Retry button shown in the error state */
  onRetry?: () => void;
  /** Multi-selection props */
  selectedIds?: (string | number)[];
  onSelectionChange?: (ids: (string | number)[]) => void;
  /** Optional unique ID for this table to persist column visibility in localStorage */
  tableId?: string;
}

export function DataTable<T>({
  columns,
  data,
  isLoading = false,
  emptyMessage = "No results.",
  emptyDescription = "Try adjusting your search or filters to find what you are looking for.",
  emptyAction,
  onRowClick,
  rowKey,
  skeletonRows = 5,
  renderActions,
  actionsHeader,
  renderExpandedRow,
  expandedRowKey,
  isError = false,
  onRetry,
  selectedIds,
  onSelectionChange,
  tableId,
}: DataTableProps<T>) {
  // ── Column Visibility State ──────────────────────────────────────────────
  const [hiddenColumnIds, setHiddenColumnIds] = useState<Set<string>>(() => {
    if (!tableId) return new Set();
    try {
      const saved = localStorage.getItem(`bf_table_cols_${tableId}`);
      if (saved) {
        return new Set(JSON.parse(saved));
      }
    } catch {
      // ignore parse errors
    }
    return new Set();
  });

  useEffect(() => {
    if (!tableId) return;
    try {
      localStorage.setItem(
        `bf_table_cols_${tableId}`,
        JSON.stringify(Array.from(hiddenColumnIds)),
      );
    } catch {
      // ignore quota exceeded or other errors
    }
  }, [tableId, hiddenColumnIds]);

  const toggleColumnVisibility = (colId: string) => {
    setHiddenColumnIds((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId);
      else next.add(colId);
      return next;
    });
  };

  // Filter out columns that are hidden
  const visibleColumns = columns.filter((col) => {
    const colId = col.id ?? col.header;
    // Special case for columns without a header/id (like the chevron toggle)
    if (!colId) return true;
    return !hiddenColumnIds.has(colId);
  });

  const colCount =
    visibleColumns.length +
    (renderActions ? 1 : 0) +
    (onSelectionChange ? 1 : 0);

  if (isError && !isLoading) {
    return (
      <div className="bg-card border rounded-lg overflow-hidden">
        <ErrorState onRetry={onRetry} />
      </div>
    );
  }

  const handleSelectAll = (checked: boolean) => {
    if (!onSelectionChange) return;
    if (checked) {
      onSelectionChange(data.map((row) => rowKey(row)));
    } else {
      onSelectionChange([]);
    }
  };

  const handleSelectRow = (checked: boolean, id: string | number) => {
    if (!onSelectionChange || !selectedIds) return;
    if (checked) {
      if (!selectedIds.includes(id)) onSelectionChange([...selectedIds, id]);
    } else {
      onSelectionChange(selectedIds.filter((x) => x !== id));
    }
  };

  useEffect(() => {
    if (!onSelectionChange || !selectedIds?.length) return;
    const visibleIds = new Set(data.map((row) => rowKey(row)));
    const visibleSelection = selectedIds.filter((id) => visibleIds.has(id));
    if (visibleSelection.length !== selectedIds.length) {
      onSelectionChange(visibleSelection);
    }
  }, [data, onSelectionChange, rowKey, selectedIds]);

  return (
    <div className="bg-card border rounded-lg overflow-hidden shadow-sm">
      {tableId && (
        <div className="flex justify-end px-4 py-2 border-b bg-muted/20">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-xs">
                <SlidersHorizontal className="h-3.5 w-3.5 mr-2" />
                View
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Toggle Columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {columns.map((col, i) => {
                const colId = col.id ?? col.header;
                if (!colId) return null;
                return (
                  <DropdownMenuCheckboxItem
                    key={colId}
                    checked={!hiddenColumnIds.has(colId)}
                    onCheckedChange={() => toggleColumnVisibility(colId)}
                  >
                    {col.header}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="overflow-x-auto" aria-busy={isLoading} aria-live="polite">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              {onSelectionChange && (
                <th className="w-10 px-4 py-3">
                  <Checkbox
                    checked={
                      data.length > 0 && selectedIds?.length === data.length
                    }
                    onCheckedChange={handleSelectAll}
                  />
                </th>
              )}
              {visibleColumns.map((col, i) => (
                <th
                  key={i}
                  className={`px-4 py-3 text-left font-medium text-muted-foreground ${col.headerClassName ?? ""}`}
                >
                  {col.header}
                </th>
              ))}
              {renderActions && (
                <th
                  scope="col"
                  className="w-10 text-left px-4 py-3 font-medium"
                >
                  {actionsHeader ?? ""}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading
              ? Array.from({ length: skeletonRows }).map((_, ri) => (
                  <tr key={ri}>
                    {Array.from({ length: colCount }).map((_, ci) => (
                      <td key={ci} className="px-4 py-3">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : data.map((row) => {
                  const key = rowKey(row);
                  const isSelected = selectedIds?.includes(key);
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className={`hover:bg-muted/20 transition-colors ${onRowClick ? "cursor-pointer" : ""} ${isSelected ? "bg-muted/40" : ""}`}
                        onClick={onRowClick ? () => onRowClick(row) : undefined}
                      >
                        {onSelectionChange && (
                          <td
                            className="px-4 py-3"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(checked) =>
                                handleSelectRow(!!checked, key)
                              }
                            />
                          </td>
                        )}
                        {visibleColumns.map((col, ci) => (
                          <td key={ci} className={col.className ?? "px-4 py-3"}>
                            {col.render(row)}
                          </td>
                        ))}
                        {renderActions && (
                          <td
                            className="px-2 py-3"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {renderActions(row)}
                          </td>
                        )}
                      </tr>
                      {renderExpandedRow && expandedRowKey === key && (
                        <tr>
                          <td
                            colSpan={colCount}
                            className="px-0 py-0 border-t-0 bg-muted/10"
                          >
                            {renderExpandedRow(row)}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
          </tbody>
        </table>
      </div>
      {!isLoading && data.length === 0 && (
        <EmptyState
          title={emptyMessage}
          description={emptyDescription as string}
          action={emptyAction}
        />
      )}
    </div>
  );
}
