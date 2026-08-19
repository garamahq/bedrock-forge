import { useState } from "react";
import {
  Users,
  ChevronUp,
  ChevronDown,
  Loader2,
  LogIn,
  Copy,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWpUsersQuery } from "../hooks";
import { environmentsApi } from "../api";
import { QuickLoginResult } from "../types";

export function WpUsersSection({
  projectId,
  envId,
}: {
  projectId: number;
  envId: number;
}) {
  const [open, setOpen] = useState(false);
  const [loginResult, setLoginResult] = useState<QuickLoginResult | null>(null);
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [loadingUserId, setLoadingUserId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    data: users,
    isLoading,
    isError,
    refetch,
  } = useWpUsersQuery(projectId, envId, open);

  async function handleQuickLogin(userId: number) {
    setLoadingUserId(userId);
    try {
      const result = await environmentsApi.generateQuickLogin(
        projectId,
        envId,
        userId,
      );
      setLoginResult(result);
      setLoginDialogOpen(true);
    } catch {
      toast({ title: "Failed to create login link", variant: "destructive" });
    } finally {
      setLoadingUserId(null);
    }
  }

  function copyLoginUrl() {
    if (!loginResult) return;
    navigator.clipboard.writeText(loginResult.loginUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const ROLE_COLORS: Record<string, string> = {
    administrator:
      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    editor: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    author:
      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    contributor:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    subscriber: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
  };

  return (
    <>
      <div className="border rounded-md overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium bg-muted/50 hover:bg-muted transition-colors"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            WP Users
          </span>
          {open ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>

        {open && (
          <div className="px-3 py-2.5 text-xs">
            {isLoading && (
              <div className="space-y-1.5">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-4/5" />
                <Skeleton className="h-5 w-3/5" />
              </div>
            )}
            {isError && (
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground">Failed to load users</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs"
                  onClick={() => refetch()}
                >
                  Retry
                </Button>
              </div>
            )}
            {!isLoading && !isError && users && users.length === 0 && (
              <p className="text-muted-foreground text-center py-1">
                No users found
              </p>
            )}
            {!isLoading && !isError && users && users.length > 0 && (
              <div className="space-y-1">
                {users.map((u) => {
                  const loginStr = u.user_login || u.user_email || "User";
                  const initial = (loginStr[0] || "U").toUpperCase();
                  const colorCode = (loginStr.charCodeAt(0) || 65) * 47;
                  const roles = Array.isArray(u.roles) ? u.roles : [];

                  return (
                    <div
                      key={u.id}
                      className="flex items-center justify-between gap-2 py-1 border-b last:border-0"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className="h-6 w-6 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                          style={{
                            backgroundColor: `hsl(${colorCode % 360}, 60%, 45%)`,
                          }}
                        >
                          {initial}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate leading-tight">
                            {u.user_login || "—"}
                          </p>
                          <p className="text-muted-foreground truncate leading-tight">
                            {u.user_email || "—"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1 shrink-0">
                          {roles.map((role) => (
                            <span
                              key={role}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ROLE_COLORS[role] ?? "bg-muted text-muted-foreground"}`}
                            >
                              {role}
                            </span>
                          ))}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs shrink-0"
                        disabled={loadingUserId === u.id}
                        onClick={() => handleQuickLogin(u.id)}
                      >
                        {loadingUserId === u.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <LogIn className="h-3 w-3 mr-1" />
                            Login
                          </>
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick login link dialog */}
      <Dialog open={loginDialogOpen} onOpenChange={setLoginDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LogIn className="h-4 w-4" /> Quick Login Link
            </DialogTitle>
          </DialogHeader>
          {loginResult && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This one-time link expires at{" "}
                <span className="font-medium text-foreground">
                  {new Date(loginResult.expiresAt).toLocaleTimeString()}
                </span>{" "}
                and self-destructs after use.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-muted px-2 py-1.5 rounded font-mono break-all">
                  {loginResult.loginUrl}
                </code>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={copyLoginUrl}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  {copied ? "Copied!" : "Copy URL"}
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => {
                    window.open(loginResult.loginUrl, "_blank", "noopener");
                    setLoginDialogOpen(false);
                  }}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
