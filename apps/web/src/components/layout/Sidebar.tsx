import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth.store";
import { useUiStore } from "@/store/ui.store";
import { ROLE_HIERARCHY, type Role } from "@bedrock-forge/shared";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  LayoutDashboard,
  Users,
  Server,
  FolderKanban,
  HardDrive,
  Globe,
  Activity,
  Gauge,
  ClipboardList,
  Settings,
  Moon,
  Sun,
  Shield,
  ShieldAlert,
  Package,
  FileText,
  Bell,
  ClipboardCheck,
  FileBarChart,
  AlertTriangle,
  Tag,
  Calendar,
} from "lucide-react";

interface NavItemDef {
  to: string;
  label: string;
  icon: React.ElementType;
  minRole?: Role;
}

interface NavGroup {
  label: string | null;
  items: NavItemDef[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        to: "/dashboard",
        label: "Dashboard",
        icon: LayoutDashboard,
        minRole: "maintainer",
      },
      {
        to: "/monitors",
        label: "Monitors",
        icon: Activity,
        minRole: "manager",
      },
      {
        to: "/lighthouse",
        label: "Lighthouse",
        icon: Gauge,
        minRole: "manager",
      },
      {
        to: "/activity",
        label: "Activity",
        icon: ClipboardList,
        minRole: "maintainer",
      },
    ],
  },
  {
    label: "Management",
    items: [
      {
        to: "/projects",
        label: "Projects",
        icon: FolderKanban,
        minRole: "manager",
      },
      { to: "/clients", label: "Clients", icon: Users, minRole: "manager" },
      { to: "/servers", label: "Servers", icon: Server, minRole: "manager" },
      { to: "/domains", label: "Domains", icon: Globe, minRole: "manager" },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/backups", label: "Backups", icon: HardDrive, minRole: "manager" },
      {
        to: "/security",
        label: "Security",
        icon: ShieldAlert,
        minRole: "manager",
      },
      {
        to: "/maintenance-windows",
        label: "Maintenance",
        icon: Calendar,
        minRole: "manager",
      },
      {
        to: "/problems",
        label: "Problems",
        icon: AlertTriangle,
        minRole: "maintainer",
      },
    ],
  },
  {
    label: "Billing & Admin",
    items: [
      { to: "/packages", label: "Packages", icon: Package, minRole: "manager" },
      {
        to: "/invoices",
        label: "Invoices",
        icon: FileText,
        minRole: "manager",
      },
      { to: "/tags", label: "Tags", icon: Tag, minRole: "manager" },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
  {
    label: "System Admin",
    items: [
      { to: "/users", label: "Users & Roles", icon: Shield, minRole: "admin" },
      {
        to: "/audit-logs",
        label: "Audit Logs",
        icon: ClipboardCheck,
        minRole: "admin",
      },
      {
        to: "/notifications",
        label: "Notifications",
        icon: Bell,
        minRole: "admin",
      },
      {
        to: "/reports",
        label: "Reports",
        icon: FileBarChart,
        minRole: "admin",
      },
    ],
  },
];

function NavItem({
  to,
  label,
  icon: Icon,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: React.ElementType;
  collapsed: boolean;
  minRole?: string;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const isActive =
    to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);

  const link = (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={cn(
        "flex items-center text-sm font-medium transition-colors relative group w-full",
        collapsed
          ? "justify-center px-0 py-3 rounded-none"
          : "rounded-md gap-3 px-3 py-2",
        isActive
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

interface SidebarInnerProps {
  collapsed?: boolean;
  onNavigate?: () => void;
}

export function SidebarInner({
  collapsed = false,
  onNavigate,
}: SidebarInnerProps) {
  const user = useAuthStore((s) => s.user);
  const { darkMode, toggleDarkMode } = useUiStore();
  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : (user?.email?.[0]?.toUpperCase() ?? "U");
  const role =
    user?.roles?.reduce(
      (highest, current) =>
        (ROLE_HIERARCHY[current as Role] ?? 0) >
        (ROLE_HIERARCHY[highest as Role] ?? 0)
          ? current
          : highest,
      "",
    ) ?? "";

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col h-full">
        {/* Logo */}
        <div
          className={cn(
            "h-14 flex items-center border-b shrink-0",
            collapsed ? "justify-center px-0" : "px-5",
          )}
        >
          <div
            className={cn(
              "flex items-center min-w-0",
              collapsed ? "justify-center" : "gap-2.5",
            )}
          >
            <div className="w-7 h-7 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm shrink-0">
              B
            </div>
            {!collapsed && (
              <span className="font-bold text-base tracking-tight truncate">
                Bedrock Forge
              </span>
            )}
          </div>
        </div>

        <nav
          aria-label="Main navigation"
          className={cn(
            "flex-1 py-3 overflow-y-auto",
            collapsed ? "px-0 scrollbar-none" : "px-3 sidebar-scrollbar",
          )}
        >
          {(() => {
            const userWeight = Math.max(
              ...(user?.roles ?? []).map((r) => ROLE_HIERARCHY[r as Role] ?? 0),
              0,
            );
            const visibleGroups = NAV_GROUPS.map((group) => ({
              ...group,
              items: group.items.filter((item) => {
                const minW = item.minRole
                  ? (ROLE_HIERARCHY[item.minRole] ?? 0)
                  : 0;
                return minW <= userWeight;
              }),
            })).filter((g) => g.items.length > 0);
            return visibleGroups.map((group, gi) => (
              <div key={group.label ?? "core"}>
                {gi > 0 && <Separator className="my-2" />}
                {!collapsed && group.label && (
                  <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 select-none">
                    {group.label}
                  </p>
                )}
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <NavItem
                      key={item.to}
                      {...item}
                      collapsed={collapsed}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              </div>
            ));
          })()}
        </nav>

        <Separator />

        {/* Dark mode toggle */}
        <div
          className={cn(
            "flex items-center py-3 w-full",
            collapsed ? "justify-center px-0" : "gap-2 px-4",
          )}
        >
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={toggleDarkMode}
                  className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  {darkMode ? (
                    <Sun className="h-4 w-4" />
                  ) : (
                    <Moon className="h-4 w-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {darkMode ? "Light mode" : "Dark mode"}
              </TooltipContent>
            </Tooltip>
          ) : (
            <>
              <span className="text-xs text-muted-foreground flex-1">
                {darkMode ? (
                  <span className="flex items-center gap-1.5">
                    <Sun className="h-3 w-3" /> Light mode
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Moon className="h-3 w-3" /> Dark mode
                  </span>
                )}
              </span>
              <Switch checked={darkMode} onCheckedChange={toggleDarkMode} />
            </>
          )}
        </div>

        <Separator />

        {/* User info */}
        <div
          className={cn(
            "flex items-center py-3 w-full",
            collapsed ? "justify-center px-0" : "gap-3 px-4",
          )}
        >
          <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0">
            {initials}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium truncate">
                {user?.name || user?.email}
              </p>
              {role && (
                <p className="text-xs text-muted-foreground capitalize">
                  {role}
                </p>
              )}
            </div>
          )}
        </div>
        {!collapsed && (
          <p className="px-4 pb-3 text-[10px] text-muted-foreground/40 select-none">
            v{__APP_VERSION__}
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    <aside
      className={cn(
        "bg-card border-r flex flex-col shrink-0 transition-all duration-200 hidden lg:flex",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <SidebarInner collapsed={collapsed} />
    </aside>
  );
}
