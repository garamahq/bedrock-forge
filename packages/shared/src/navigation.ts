import type { Role } from "./roles";

export type NavigationIcon =
  | "LayoutDashboard"
  | "Activity"
  | "Gauge"
  | "ClipboardList"
  | "FolderKanban"
  | "Users"
  | "Server"
  | "Globe"
  | "HardDrive"
  | "ShieldAlert"
  | "Calendar"
  | "AlertTriangle"
  | "Package"
  | "FileText"
  | "Tag"
  | "Settings"
  | "Shield"
  | "ClipboardCheck"
  | "Bell"
  | "FileBarChart";

export interface NavigationPage {
  path: string;
  label: string;
  icon: NavigationIcon;
  section: string;
  minRole?: Role;
}

export const NAVIGATION_PAGES: NavigationPage[] = [
  {
    path: "/dashboard",
    label: "Dashboard",
    icon: "LayoutDashboard",
    section: "Overview",
    minRole: "maintainer",
  },
  {
    path: "/monitors",
    label: "Monitors",
    icon: "Activity",
    section: "Overview",
    minRole: "manager",
  },
  {
    path: "/lighthouse",
    label: "Lighthouse",
    icon: "Gauge",
    section: "Overview",
    minRole: "manager",
  },
  {
    path: "/activity",
    label: "Activity",
    icon: "ClipboardList",
    section: "Overview",
    minRole: "maintainer",
  },
  {
    path: "/projects",
    label: "Projects",
    icon: "FolderKanban",
    section: "Management",
    minRole: "manager",
  },
  {
    path: "/clients",
    label: "Clients",
    icon: "Users",
    section: "Management",
    minRole: "manager",
  },
  {
    path: "/servers",
    label: "Servers",
    icon: "Server",
    section: "Management",
    minRole: "manager",
  },
  {
    path: "/domains",
    label: "Domains",
    icon: "Globe",
    section: "Management",
    minRole: "manager",
  },
  {
    path: "/backups",
    label: "Backups",
    icon: "HardDrive",
    section: "Operations",
    minRole: "manager",
  },
  {
    path: "/security",
    label: "Security",
    icon: "ShieldAlert",
    section: "Operations",
    minRole: "manager",
  },
  {
    path: "/maintenance-windows",
    label: "Maintenance",
    icon: "Calendar",
    section: "Operations",
    minRole: "manager",
  },
  {
    path: "/problems",
    label: "Work Queue",
    icon: "AlertTriangle",
    section: "Operations",
    minRole: "maintainer",
  },
  {
    path: "/packages",
    label: "Packages",
    icon: "Package",
    section: "Billing & Admin",
    minRole: "manager",
  },
  {
    path: "/invoices",
    label: "Invoices",
    icon: "FileText",
    section: "Billing & Admin",
    minRole: "manager",
  },
  {
    path: "/tags",
    label: "Tags",
    icon: "Tag",
    section: "Billing & Admin",
    minRole: "manager",
  },
  {
    path: "/settings",
    label: "Settings",
    icon: "Settings",
    section: "Billing & Admin",
  },
  {
    path: "/users",
    label: "Users & Roles",
    icon: "Shield",
    section: "System Admin",
    minRole: "admin",
  },
  {
    path: "/audit-logs",
    label: "Audit Logs",
    icon: "ClipboardCheck",
    section: "System Admin",
    minRole: "admin",
  },
  {
    path: "/notifications",
    label: "Notifications",
    icon: "Bell",
    section: "System Admin",
    minRole: "admin",
  },
  {
    path: "/reports",
    label: "Reports",
    icon: "FileBarChart",
    section: "System Admin",
    minRole: "admin",
  },
];

export const NAVIGATION_SECTIONS = [
  "Overview",
  "Management",
  "Operations",
  "Billing & Admin",
  "System Admin",
] as const;
