import { useState } from "react";
import {
  Database,
  ChevronUp,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/crud";
import { toast } from "@/hooks/use-toast";
import { useDbCredentialsQuery, useSaveDbCredentialsMutation } from "../hooks";
import { dbCredsSchema, DbCredsForm } from "../utils";

export function DbCredentialsSection({
  projectId,
  envId,
}: {
  projectId: number;
  envId: number;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showPass, setShowPass] = useState(false);

  const {
    data: creds,
    isLoading,
    isError,
    refetch,
  } = useDbCredentialsQuery(projectId, envId, open);
  const saveMutation = useSaveDbCredentialsMutation(projectId, envId);

  const {
    register,
    handleSubmit,
    reset: resetForm,
    setError: setCredsError,
    formState: { errors, isSubmitting },
  } = useForm<DbCredsForm>({
    resolver: zodResolver(dbCredsSchema),
    defaultValues: {
      dbName: creds?.dbName ?? "",
      dbUser: creds?.dbUser ?? "",
      dbPassword: creds?.dbPassword ?? "",
      dbHost: creds?.dbHost ?? "localhost",
    },
    values: creds
      ? {
          dbName: creds.dbName,
          dbUser: creds.dbUser,
          dbPassword: creds.dbPassword,
          dbHost: creds.dbHost,
        }
      : undefined,
  });

  async function saveCreds(data: DbCredsForm) {
    try {
      await saveMutation.mutateAsync(data);
      setEditing(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Save failed. Please try again.";
      setCredsError("root", { message });
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast({ title: `${label} copied` }))
      .catch(() => {});
  }

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium bg-muted/50 hover:bg-muted transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          DB Credentials
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="px-3 py-2.5 space-y-2 text-xs">
          {isLoading ? (
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : isError ? (
            <ErrorState
              title="Could not load database credentials"
              onRetry={() => void refetch()}
              className="py-8"
            />
          ) : !creds && !editing ? (
            <div className="text-center py-1 space-y-2">
              <p className="text-muted-foreground">No credentials stored</p>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                onClick={() => setEditing(true)}
              >
                Add credentials
              </Button>
            </div>
          ) : editing ? (
            <form onSubmit={handleSubmit(saveCreds)} className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">DB Name</Label>
                  <Input
                    {...register("dbName")}
                    placeholder="wordpress_db"
                    className="h-7 text-xs"
                  />
                  {errors.dbName && (
                    <p className="text-destructive text-xs">
                      {errors.dbName.message}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Host</Label>
                  <Input
                    {...register("dbHost")}
                    placeholder="localhost"
                    className="h-7 text-xs"
                  />
                  {errors.dbHost && (
                    <p className="text-destructive text-xs">
                      {errors.dbHost.message}
                    </p>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Username</Label>
                  <Input
                    {...register("dbUser")}
                    placeholder="db_user"
                    className="h-7 text-xs"
                  />
                  {errors.dbUser && (
                    <p className="text-destructive text-xs">
                      {errors.dbUser.message}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Password</Label>
                  <Input
                    type="password"
                    {...register("dbPassword")}
                    placeholder="••••••••"
                    className="h-7 text-xs"
                  />
                  {errors.dbPassword && (
                    <p className="text-destructive text-xs">
                      {errors.dbPassword.message}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2 pt-1 flex-col">
                {errors.root && (
                  <p className="text-xs text-destructive">
                    {errors.root.message}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    className="h-6 text-xs flex-1"
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs"
                    onClick={() => {
                      setEditing(false);
                      resetForm();
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Database</span>
                <div className="flex items-center gap-1">
                  <span className="font-mono">{creds!.dbName}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(creds!.dbName, "DB name")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Host</span>
                <div className="flex items-center gap-1">
                  <span className="font-mono">{creds!.dbHost}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(creds!.dbHost, "Host")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Username</span>
                <div className="flex items-center gap-1">
                  <span className="font-mono">{creds!.dbUser}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(creds!.dbUser, "Username")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Password</span>
                <div className="flex items-center gap-1">
                  <span className="font-mono">
                    {showPass ? creds!.dbPassword : "••••••••"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {showPass ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(creds!.dbPassword, "Password")
                    }
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs w-full mt-1"
                onClick={() => setEditing(true)}
              >
                Edit credentials
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
