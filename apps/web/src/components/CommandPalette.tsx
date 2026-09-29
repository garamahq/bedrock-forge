import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Bell,
  Calendar,
  ClipboardCheck,
  ClipboardList,
  FileBarChart,
  FileText,
  FolderOpen,
  Gauge,
  Globe,
  HardDrive,
  LayoutDashboard,
  Loader2,
  Package,
  Palette,
  Puzzle,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  Tag,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api-client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type SearchResultType =
  | "page"
  | "project"
  | "environment"
  | "project_tab"
  | "client"
  | "server"
  | "domain"
  | "monitor"
  | "job"
  | "finding"
  | "plugin"
  | "theme";

interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  subtitle?: string;
  path: string;
  icon?: string;
}

const ICONS: Record<string, LucideIcon> = {
  Activity,
  AlertTriangle,
  Bell,
  Calendar,
  ClipboardCheck,
  ClipboardList,
  FileBarChart,
  FileText,
  FolderOpen,
  Gauge,
  Globe,
  HardDrive,
  LayoutDashboard,
  Package,
  Palette,
  Puzzle,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  Tag,
  Users,
};

const TYPE_LABELS: Record<SearchResultType, string> = {
  page: "Pages",
  project: "Projects",
  environment: "Environments",
  project_tab: "Project Tabs",
  client: "Clients",
  server: "Servers",
  domain: "Domains",
  monitor: "Monitors",
  job: "Jobs",
  finding: "Findings",
  plugin: "Installed Plugins",
  theme: "Installed Themes",
};

const TYPE_TONES: Record<SearchResultType, string> = {
  page: "text-muted-foreground",
  project: "text-warning",
  environment: "text-info",
  project_tab: "text-primary",
  client: "text-info",
  server: "text-success",
  domain: "text-info",
  monitor: "text-success",
  job: "text-primary",
  finding: "text-destructive",
  plugin: "text-primary",
  theme: "text-info",
};

const RECENTS_KEY = "bf-command-palette-recents";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const debouncedQuery = useDebounce(query, 180);

  const { data, isFetching } = useQuery({
    queryKey: ["global-search", debouncedQuery],
    queryFn: () =>
      api.get<{ items: SearchResult[] }>(
        `/search?q=${encodeURIComponent(debouncedQuery)}&limit=8`,
      ),
    enabled: open,
    staleTime: debouncedQuery ? 5_000 : 30_000,
  });

  const allItems = data?.items ?? [];
  const recentItems = loadRecentItems();
  const visibleItems =
    !debouncedQuery && recentItems.length > 0
      ? [...recentItems, ...allItems].filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.path === item.path) ===
            index,
        )
      : allItems;

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedQuery]);

  const handleSelect = (item: SearchResult) => {
    saveRecentItem(item);
    navigate(item.path);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) =>
        Math.max(0, Math.min(i + 1, visibleItems.length - 1)),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (visibleItems[activeIndex]) handleSelect(visibleItems[activeIndex]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="p-0 max-w-2xl gap-0 overflow-hidden">
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label="Search pages, projects, and operations"
            aria-autocomplete="list"
            aria-expanded={visibleItems.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={
              visibleItems[activeIndex]
                ? `${listboxId}-option-${activeIndex}`
                : undefined
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search sites, plugins, themes, findings, jobs…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {isFetching && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground font-mono">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Search results"
          className="max-h-[28rem] overflow-y-auto py-2"
        >
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {isFetching
              ? "Searching"
              : `${visibleItems.length} search result${visibleItems.length === 1 ? "" : "s"}`}
          </div>
          {isFetching && visibleItems.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching…
            </div>
          ) : visibleItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {query
                ? "No results found."
                : "Start typing to search the system."}
            </p>
          ) : null}

          {visibleItems.map((item, i) => {
            const prevItem = visibleItems[i - 1];
            const groupLabel =
              !prevItem || prevItem.type !== item.type
                ? TYPE_LABELS[item.type]
                : null;
            const Icon =
              item.icon && ICONS[item.icon] ? ICONS[item.icon] : Search;

            return (
              <div key={`${item.type}-${item.id}`}>
                {groupLabel && (
                  <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 select-none">
                    {groupLabel}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  id={`${listboxId}-option-${i}`}
                  aria-selected={i === activeIndex}
                  data-index={i}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors ${
                    i === activeIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground"
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${TYPE_TONES[item.type]}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {item.subtitle && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.subtitle}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {item.type === "project_tab"
                      ? "Tab"
                      : item.type === "job"
                        ? "Log"
                        : item.type === "finding"
                          ? "Fix"
                          : item.type[0].toUpperCase() + item.type.slice(1)}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="border-t px-4 py-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> select
          </span>
          <span>
            <kbd className="font-mono">Esc</kbd> close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function loadRecentItems(): SearchResult[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SearchResult[];
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveRecentItem(item: SearchResult) {
  try {
    const recents = loadRecentItems();
    const next = [
      { ...item, type: item.type },
      ...recents.filter((recent) => recent.path !== item.path),
    ].slice(0, 5);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage can be disabled; search still works without recents.
  }
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
