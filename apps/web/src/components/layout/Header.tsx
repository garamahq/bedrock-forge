import { useEffect, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { PanelLeftClose, PanelLeft, Menu, Search, Bell } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import { useUiStore } from "@/store/ui.store";
import { api } from "@/lib/api-client";
import { getSocket } from "@/lib/websocket";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SidebarInner } from "./Sidebar";
import { ActionCenter } from "@/components/ActionCenter";

const ROUTE_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  clients: "Clients",
  servers: "Servers",
  projects: "Projects",
  backups: "Backups",
  monitors: "Monitors",
  lighthouse: "Lighthouse",
  domains: "Domains",
  settings: "Settings",
  users: "Users & Roles",
  "audit-logs": "Audit Logs",
  packages: "Packages",
  invoices: "Invoices",
  activity: "Activity",
  notifications: "Notifications",
  problems: "Problems",
  reports: "Reports",
  security: "Security",
};

type WsStatus = "connected" | "reconnecting" | "disconnected";

function WsStatusDot() {
  const [status, setStatus] = useState<WsStatus>("disconnected");

  useEffect(() => {
    const socket = getSocket();
    if (socket.connected) setStatus("connected");

    const onConnect = () => setStatus("connected");
    const onDisconnect = () => setStatus("disconnected");
    const onReconnecting = () => setStatus("reconnecting");

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("reconnect_attempt", onReconnecting);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("reconnect_attempt", onReconnecting);
    };
  }, []);

  const dotClass =
    status === "connected"
      ? "bg-green-500"
      : status === "reconnecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-red-500";

  const label =
    status === "connected"
      ? "WebSocket connected"
      : status === "reconnecting"
        ? "WebSocket reconnecting…"
        : "WebSocket disconnected";

  return (
    <span
      title={label}
      aria-label={label}
      className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`}
    />
  );
}

function Breadcrumb() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);
  const crumbs = segments.map((s) => ROUTE_LABELS[s] ?? s);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm list-none m-0 p-0 min-w-0">
        {crumbs.map((crumb, i) => (
          <li key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && (
              <span className="text-muted-foreground/60 shrink-0" aria-hidden="true">
                /
              </span>
            )}
            <span
              aria-current={i === crumbs.length - 1 ? "page" : undefined}
              className={`truncate max-w-[100px] sm:max-w-[180px] md:max-w-none ${
                i === crumbs.length - 1
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              {crumb}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface InboxItem {
  id: number;
  type: string;
  title: string;
  message: string;
  is_read: boolean;
  action_url?: string | null;
  created_at: string;
}

function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ["notifications-unread"],
    queryFn: () => api.get("/notifications/inbox/unread-count"),
    refetchInterval: 30_000,
  });

  const { data: inboxData } = useQuery<{ data: InboxItem[] }>({
    queryKey: ["notifications-inbox-preview"],
    queryFn: () => api.get("/notifications/inbox?limit=10"),
    enabled: open,
    staleTime: 10_000,
  });

  const markAllMutation = useMutation({
    mutationFn: () => api.post("/notifications/inbox/read-all", {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["notifications-unread"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["notifications-inbox-preview"],
      });
    },
  });

  const unread = unreadData?.count ?? 0;
  const items = inboxData?.data ?? [];

  const relTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 relative"
          aria-label={
            unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
          }
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {unread > 0 && (
            <Badge
              variant="destructive"
              aria-hidden="true"
              className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] leading-none flex items-center justify-center rounded-full"
            >
              {unread > 99 ? "99+" : unread}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground"
              onClick={() => markAllMutation.mutate()}
              disabled={markAllMutation.isPending}
            >
              Mark all read
            </Button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No notifications
          </div>
        ) : (
          items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              className={`flex flex-col items-start gap-0.5 py-2.5 cursor-default ${!item.is_read ? "bg-muted/40" : ""}`}
            >
              <div className="flex items-center gap-1.5 w-full">
                {!item.is_read && (
                  <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                )}
                <span
                  className={`text-sm font-medium truncate flex-1 ${!item.is_read ? "" : "pl-3"}`}
                >
                  {item.title}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {relTime(item.created_at)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2 pl-3">
                {item.message}
              </p>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          asChild
          className="justify-center text-xs font-medium text-primary py-2.5 cursor-pointer"
        >
          <Link to="/notifications">View All Notifications</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Header({ onOpenSearch }: { onOpenSearch?: () => void }) {
  const { user, logout } = useAuthStore();
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    try {
      await api.post("/auth/logout", {});
    } catch {
      /* ignore */
    }
    logout();
  };

  return (
    <header className="h-14 border-b flex items-center justify-between px-4 bg-card shrink-0 gap-4">
      <div className="flex items-center gap-3">
        {/* Mobile sidebar trigger */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden">
              <Menu className="h-4 w-4" />
              <span className="sr-only">Open menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-72 max-w-[85vw]">
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            <SidebarInner
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
            />
          </SheetContent>
        </Sheet>

        {/* Desktop collapse toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hidden lg:flex"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>

        <Breadcrumb />
      </div>

      <div className="flex items-center gap-3">
        <ActionCenter />
        <NotificationBell />
        {onOpenSearch && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenSearch}
            className="hidden md:flex items-center gap-2 text-muted-foreground text-xs h-8 px-3 w-48 justify-start"
          >
            <Search className="h-3.5 w-3.5" />
            <span>Search…</span>
            <kbd className="ml-auto font-mono text-xs">⌘K</kbd>
          </Button>
        )}
        <span className="text-sm text-muted-foreground hidden sm:block">
          {user?.email}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          className="text-muted-foreground hover:text-foreground"
        >
          Sign out
        </Button>
      </div>
    </header>
  );
}
