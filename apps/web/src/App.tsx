import React, { Component, useEffect, useState, lazy, Suspense } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
} from "react-router-dom";
import { useAuthStore, isTokenExpired } from "@/store/auth.store";
import { api } from "@/lib/api-client";
import { destroySocket } from "@/lib/websocket";
import { AppLayout } from "@/components/layout/AppLayout";

// Lazy-load all page bundles — each becomes a separate chunk
const LoginPage = lazy(() =>
  import("@/pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const DashboardPage = lazy(() =>
  import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const ClientsPage = lazy(() =>
  import("@/pages/ClientsPage").then((m) => ({ default: m.ClientsPage })),
);
const ClientDetailPage = lazy(() =>
  import("@/pages/ClientDetailPage").then((m) => ({
    default: m.ClientDetailPage,
  })),
);
const ServersPage = lazy(() =>
  import("@/pages/ServersPage").then((m) => ({ default: m.ServersPage })),
);
const ProjectsPage = lazy(() =>
  import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })),
);
const ProjectDetailPage = lazy(() =>
  import("@/pages/ProjectDetailPage").then((m) => ({
    default: m.ProjectDetailPage,
  })),
);
const BackupsPage = lazy(() =>
  import("@/pages/BackupsPage").then((m) => ({ default: m.BackupsPage })),
);
const DomainsPage = lazy(() =>
  import("@/pages/DomainsPage").then((m) => ({ default: m.DomainsPage })),
);
const MonitorsPage = lazy(() =>
  import("@/pages/MonitorsPage").then((m) => ({ default: m.MonitorsPage })),
);
const LighthousePage = lazy(() =>
  import("@/pages/LighthousePage").then((m) => ({ default: m.LighthousePage })),
);
const MonitorDetailPage = lazy(() =>
  import("@/pages/MonitorDetailPage").then((m) => ({
    default: m.MonitorDetailPage,
  })),
);
const SettingsPage = lazy(() =>
  import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const ActivityPage = lazy(() =>
  import("@/pages/ActivityPage").then((m) => ({ default: m.ActivityPage })),
);
const UsersPage = lazy(() =>
  import("@/pages/UsersPage").then((m) => ({ default: m.UsersPage })),
);
const PackagesPage = lazy(() =>
  import("@/pages/PackagesPage").then((m) => ({ default: m.PackagesPage })),
);
const InvoicesPage = lazy(() =>
  import("@/pages/InvoicesPage").then((m) => ({ default: m.InvoicesPage })),
);
const NotificationsPage = lazy(() =>
  import("@/pages/NotificationsPage").then((m) => ({
    default: m.NotificationsPage,
  })),
);
const ReportsPage = lazy(() =>
  import("@/pages/ReportsPage").then((m) => ({ default: m.ReportsPage })),
);
const ProblemsPage = lazy(() =>
  import("@/pages/ProblemsPage").then((m) => ({ default: m.ProblemsPage })),
);
const AuditLogsPage = lazy(() =>
  import("@/pages/AuditLogsPage").then((m) => ({ default: m.AuditLogsPage })),
);
const SecurityPage = lazy(() =>
  import("@/pages/SecurityPage").then((m) => ({ default: m.SecurityPage })),
);
const ServerDetailPage = lazy(() =>
  import("@/pages/ServerDetailPage").then((m) => ({
    default: m.ServerDetailPage,
  })),
);
const InvoiceDetailPage = lazy(() =>
  import("@/pages/InvoiceDetailPage").then((m) => ({
    default: m.InvoiceDetailPage,
  })),
);
const TagsPage = lazy(() =>
  import("@/pages/TagsPage").then((m) => ({ default: m.TagsPage })),
);
const MaintenanceWindowsPage = lazy(() =>
  import("@/pages/MaintenanceWindowsPage").then((m) => ({
    default: m.MaintenanceWindowsPage,
  })),
);
const NotFoundPage = lazy(() =>
  import("@/pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })),
);

class ErrorBoundary extends Component<
  React.PropsWithChildren,
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled React error boundary failure", {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex h-screen items-center justify-center text-center p-8"
          role="alert"
          aria-live="assertive"
        >
          <div className="max-w-lg">
            <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
            <p className="text-sm text-muted-foreground mb-4">
              The page failed to render. Retry the current view or reload the
              application.
            </p>
            {import.meta.env.DEV && this.state.error && (
              <pre className="text-left text-xs bg-muted p-4 rounded mb-4 overflow-auto max-h-64">
                {(this.state.error as Error).message}
                {"\n"}
                {(this.state.error as Error).stack}
              </pre>
            )}
            <div className="flex gap-3 justify-center">
              <button
                type="button"
                className="text-sm underline"
                onClick={this.reset}
              >
                Retry
              </button>
              <button
                type="button"
                className="text-sm underline"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
              <a href="/dashboard" className="text-sm underline">
                Go to Dashboard
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.accessToken);
  const isExpired = isTokenExpired(token);
  return token && !isExpired ? (
    <>{children}</>
  ) : (
    <Navigate to="/login" replace />
  );
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.accessToken);
  if (!user || isTokenExpired(token)) return <Navigate to="/login" replace />;
  return user.roles.includes("admin") ? (
    <>{children}</>
  ) : (
    <Navigate to="/dashboard" replace />
  );
}

function ManagerRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.accessToken);
  if (!user || isTokenExpired(token)) return <Navigate to="/login" replace />;
  return user.roles.includes("admin") || user.roles.includes("manager") ? (
    <>{children}</>
  ) : (
    <Navigate to="/dashboard" replace />
  );
}

function MaintainerRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.accessToken);
  if (!user || isTokenExpired(token)) return <Navigate to="/login" replace />;
  return user.roles.includes("admin") ||
    user.roles.includes("manager") ||
    user.roles.includes("maintainer") ? (
    <>{children}</>
  ) : (
    <Navigate to="/access-denied" replace />
  );
}

function AccessDeniedPage() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col justify-center gap-3 p-8">
      <h1 className="text-2xl font-semibold">Operator access required</h1>
      <p className="text-muted-foreground">
        This installation is for one trusted operator team. Client accounts do
        not have access to installation-wide operational data.
      </p>
    </main>
  );
}

/**
 * Watches the auth store and navigates to /login whenever the access token is
 * cleared (by logout(), failed refresh, or rehydration cleanup).
 * Must render inside <BrowserRouter> so useNavigate is available.
 */
function SessionGuard() {
  const navigate = useNavigate();
  useEffect(() => {
    return useAuthStore.subscribe((state, prev) => {
      if (!state.accessToken && prev.accessToken) {
        navigate("/login", { replace: true });
      }
    });
  }, [navigate]);
  return null;
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);

  // Rehydrate from the httpOnly refresh cookie when possible, then re-validate
  // roles to pick up server-side permission changes.
  useEffect(() => {
    const hydrate = async () => {
      const { accessToken, setAccessToken, setUser, logout } =
        useAuthStore.getState();
      try {
        if (accessToken) {
          const user = await api.get<{
            id: number;
            email: string;
            name: string;
            roles: string[];
          }>("/auth/me");
          setUser(user);
          return;
        }

        const session = await api.post<{
          accessToken: string;
          user: { id: number; email: string; name: string; roles: string[] };
        }>("/auth/refresh", {});
        setAccessToken(session.accessToken);
        setUser(session.user);
      } catch {
        logout();
      } finally {
        setAuthReady(true);
      }
    };
    void hydrate();
  }, []);

  // Disconnect WebSocket when the user logs out
  useEffect(() => {
    return useAuthStore.subscribe((state, prev) => {
      if (!state.accessToken && prev.accessToken) {
        destroySocket();
      }
    });
  }, []);

  if (!authReady) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <SessionGuard />
        <Suspense
          fallback={
            <div className="flex h-screen items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          }
        >
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <PrivateRoute>
                  <AppLayout />
                </PrivateRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route
                path="dashboard"
                element={
                  <MaintainerRoute>
                    <DashboardPage />
                  </MaintainerRoute>
                }
              />
              <Route path="access-denied" element={<AccessDeniedPage />} />
              <Route
                path="clients"
                element={
                  <ManagerRoute>
                    <ClientsPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="clients/:id"
                element={
                  <ManagerRoute>
                    <ClientDetailPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="servers"
                element={
                  <ManagerRoute>
                    <ServersPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="servers/:id"
                element={
                  <ManagerRoute>
                    <ServerDetailPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="projects"
                element={
                  <ManagerRoute>
                    <ProjectsPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="projects/:id"
                element={
                  <ManagerRoute>
                    <ProjectDetailPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="backups"
                element={
                  <ManagerRoute>
                    <BackupsPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="monitors"
                element={
                  <ManagerRoute>
                    <MonitorsPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="lighthouse"
                element={
                  <ManagerRoute>
                    <LighthousePage />
                  </ManagerRoute>
                }
              />
              <Route
                path="monitors/:id"
                element={
                  <ManagerRoute>
                    <MonitorDetailPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="activity"
                element={
                  <MaintainerRoute>
                    <ActivityPage />
                  </MaintainerRoute>
                }
              />
              <Route
                path="problems"
                element={
                  <MaintainerRoute>
                    <ProblemsPage />
                  </MaintainerRoute>
                }
              />
              <Route path="settings" element={<SettingsPage />} />{" "}
              <Route
                path="users"
                element={
                  <AdminRoute>
                    <UsersPage />
                  </AdminRoute>
                }
              />
              <Route
                path="packages"
                element={
                  <ManagerRoute>
                    <PackagesPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="invoices"
                element={
                  <ManagerRoute>
                    <InvoicesPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="invoices/:id"
                element={
                  <ManagerRoute>
                    <InvoiceDetailPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="tags"
                element={
                  <ManagerRoute>
                    <TagsPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="notifications"
                element={
                  <AdminRoute>
                    <NotificationsPage />
                  </AdminRoute>
                }
              />
              <Route
                path="reports"
                element={
                  <AdminRoute>
                    <ReportsPage />
                  </AdminRoute>
                }
              />
              <Route
                path="domains"
                element={
                  <ManagerRoute>
                    <DomainsPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="security"
                element={
                  <ManagerRoute>
                    <SecurityPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="maintenance-windows"
                element={
                  <ManagerRoute>
                    <MaintenanceWindowsPage />
                  </ManagerRoute>
                }
              />
              <Route
                path="audit-logs"
                element={
                  <AdminRoute>
                    <AuditLogsPage />
                  </AdminRoute>
                }
              />{" "}
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
