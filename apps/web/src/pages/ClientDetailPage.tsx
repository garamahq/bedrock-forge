import { useParams, Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  FolderKanban,
  Mail,
  Phone,
  Tag,
  Receipt,
  Pencil,
  ListChecks,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ClientFormDialog } from "./ClientsPage";
import { ResourceActivityFeed } from "@/components/ResourceActivityFeed";
import { ErrorState } from "@/components/crud";
import { useAuthStore } from "@/store/auth.store";

interface TagItem {
  id: number;
  name: string;
  color: string;
}

interface Project {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
}

interface Invoice {
  id: number;
  invoice_number: string;
  period_year: number;
  total_amount: string | number;
  status: "draft" | "sent" | "paid" | "overdue" | "cancelled";
  due_date: string | null;
  project: { id: number; name: string } | null;
}

interface ClientDetail {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  client_tags: { tag: TagItem }[];
  projects: Project[];
}

export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );
  const [editOpen, setEditOpen] = useState(false);

  const { data: tags = [] } = useQuery<TagItem[]>({
    queryKey: ["tags"],
    queryFn: () => api.get("/tags"),
    staleTime: 120_000,
  });

  const {
    data: client,
    isLoading,
    isError,
    refetch: refetchClient,
  } = useQuery<ClientDetail>({
    queryKey: ["client", id],
    queryFn: () => api.get(`/clients/${id}`),
    enabled: !!id,
  });

  const {
    data: invoicesData,
    isLoading: invoicesLoading,
    isError: invoicesError,
    refetch: refetchInvoices,
  } = useQuery<{ data: Invoice[]; total: number }>({
    queryKey: ["client-invoices", id],
    queryFn: () => api.get(`/invoices?client_id=${id}&limit=50&page=1`),
    enabled: !!id,
  });

  const invoices = invoicesData?.data ?? [];

  function statusVariant(
    status: Invoice["status"],
  ): "default" | "secondary" | "outline" | "destructive" {
    if (status === "paid") return "default";
    if (status === "overdue") return "destructive";
    if (status === "cancelled") return "secondary";
    return "outline";
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-6 max-w-3xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 max-w-3xl">
        <ErrorState
          title="Client details could not be loaded"
          description="Retry the request or return to the client list."
          onRetry={() => void refetchClient()}
        />
        <Button
          variant="outline"
          onClick={() => navigate("/clients")}
          className="mx-auto block"
        >
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Back to Clients
        </Button>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Client not found.</p>
        <Button
          variant="outline"
          className="mt-3"
          onClick={() => navigate("/clients")}
        >
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Back to Clients
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/clients")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{client.name}</h1>
            <p className="text-sm text-muted-foreground">
              Client since {new Date(client.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>
        {isAdmin && (
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4 mr-1.5" />
            Edit Client
          </Button>
        )}
      </div>

      {/* Info card */}
      <div className="bg-card border rounded-lg p-4 space-y-3">
        <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
          Contact Information
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
            {client.email ? (
              <a
                href={`mailto:${client.email}`}
                className="text-sm text-primary hover:underline truncate"
              >
                {client.email}
              </a>
            ) : (
              <span className="text-sm text-muted-foreground">No email</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
            {client.phone ? (
              <a
                href={`tel:${client.phone}`}
                className="text-sm text-primary hover:underline"
              >
                {client.phone}
              </a>
            ) : (
              <span className="text-sm text-muted-foreground">No phone</span>
            )}
          </div>
        </div>

        {client.client_tags.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
            {client.client_tags.map(({ tag }) => (
              <Badge
                key={tag.id}
                style={{ backgroundColor: tag.color, color: "#fff" }}
                className="text-xs"
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        )}

        {client.notes && (
          <div className="pt-1">
            <p className="text-sm text-muted-foreground mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{client.notes}</p>
          </div>
        )}
      </div>

      {/* Projects */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2">
            <FolderKanban className="h-4 w-4" />
            Projects ({client.projects.length})
          </h2>
          <Button asChild variant="outline" size="sm">
            <Link to="/projects">View All Projects</Link>
          </Button>
        </div>

        {client.projects.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No projects linked to this client.
          </p>
        ) : (
          <div className="space-y-2">
            {client.projects.map((project) => (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="flex items-center justify-between p-3 bg-card border rounded-md hover:bg-muted/30 transition-colors group"
              >
                <div>
                  <p className="text-sm font-medium group-hover:text-primary transition-colors">
                    {project.name}
                  </p>
                  {project.description && (
                    <p className="text-xs text-muted-foreground truncate max-w-[400px]">
                      {project.description}
                    </p>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0 ml-4">
                  {new Date(project.created_at).toLocaleDateString()}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Invoices */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2">
            <Receipt className="h-4 w-4" />
            Invoices (
            {invoicesLoading
              ? "…"
              : invoicesError
                ? "—"
                : (invoicesData?.total ?? invoices.length)}
            )
          </h2>
          <Button asChild variant="outline" size="sm">
            <Link to="/invoices">View All Invoices</Link>
          </Button>
        </div>

        {invoicesError ? (
          <ErrorState
            title="Invoices could not be loaded"
            onRetry={() => void refetchInvoices()}
            className="py-8"
          />
        ) : invoicesLoading ? (
          <p className="text-muted-foreground text-sm">Loading invoices…</p>
        ) : invoices.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No invoices for this client.
          </p>
        ) : (
          <div className="space-y-2">
            {invoices.map((invoice) => (
              <div
                key={invoice.id}
                className="flex items-center justify-between p-3 bg-card border rounded-md"
              >
                <div>
                  <p className="text-sm font-medium">
                    {invoice.invoice_number ?? `Invoice #${invoice.id}`}
                    {invoice.project && (
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        — {invoice.project.name}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {invoice.period_year}
                    {invoice.due_date && (
                      <>
                        {" "}
                        · Due {new Date(invoice.due_date).toLocaleDateString()}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium tabular-nums">
                    ${Number(invoice.total_amount).toFixed(2)}
                  </span>
                  <Badge variant={statusVariant(invoice.status)}>
                    {invoice.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Activity Feed */}
      <div>
        <h2 className="font-semibold flex items-center gap-2 mb-3">
          <ListChecks className="h-4 w-4" />
          Activity
        </h2>
        <div className="border rounded-lg p-4">
          <ResourceActivityFeed
            resourceType="client"
            resourceId={client.id}
            limit={15}
          />
        </div>
      </div>

      {editOpen && (
        <ClientFormDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          initial={client as Parameters<typeof ClientFormDialog>[0]["initial"]}
          allTags={tags}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["client", id] });
            qc.invalidateQueries({ queryKey: ["clients"] });
            setEditOpen(false);
          }}
        />
      )}
    </div>
  );
}
