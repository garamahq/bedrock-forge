import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

const PROJECT_WITH_PACKAGES_INCLUDE = {
  hosting_package: true,
  support_package: true,
  client: true,
} as const;

const INVOICE_INCLUDE = {
  include: {
    project: { select: { id: true, name: true } },
    client: { select: { id: true, name: true, email: true, phone: true } },
    hosting_package: { select: { id: true, name: true } },
    support_package: { select: { id: true, name: true } },
  },
} as const;

export interface InvoiceFilters {
  client_id?: number;
  project_id?: number;
  status?: string;
  year?: number;
  page: number;
  limit: number;
}

@Injectable()
export class InvoicesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filters: InvoiceFilters) {
    const where: Record<string, unknown> = {};

    if (filters.client_id) where.client_id = BigInt(filters.client_id);
    if (filters.project_id) where.project_id = BigInt(filters.project_id);
    if (filters.status) where.status = filters.status;
    if (filters.year) {
      const start = new Date(`${filters.year}-01-01T00:00:00Z`);
      const end = new Date(`${filters.year}-12-31T23:59:59Z`);
      where.period_start = { gte: start };
      where.period_end = { lte: end };
    }

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        ...INVOICE_INCLUDE,
        orderBy: { created_at: "desc" },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data, total };
  }

  findById(id: number) {
    return this.prisma.invoice.findUnique({
      where: { id: BigInt(id) },
      ...INVOICE_INCLUDE,
    });
  }

  /**
   * Atomically allocate the next invoice number and create the invoice record.
   * Runs inside a single serializable transaction so concurrent calls cannot
   * read the same sequence value and produce duplicate invoice numbers.
   */
  createSerialized(
    data: Omit<
      Parameters<typeof this.prisma.invoice.create>[0]["data"],
      "invoice_number"
    >,
    year: number,
  ) {
    const prefix = `INV-${year}-`;
    return this.prisma.$transaction(
      async (tx) => {
        const count = await tx.invoice.count({
          where: { invoice_number: { startsWith: prefix } },
        });
        const invoiceNumber = `${prefix}${String(count + 1).padStart(3, "0")}`;
        return tx.invoice.create({
          data: { invoice_number: invoiceNumber, ...data } as Parameters<
            typeof tx.invoice.create
          >[0]["data"],
          ...INVOICE_INCLUDE,
        });
      },
      { isolationLevel: "Serializable" },
    );
  }

  async existsForProjectAndPeriodOverlap(
    projectId: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<boolean> {
    const count = await this.prisma.invoice.count({
      where: {
        project_id: BigInt(projectId),
        period_start: { lte: periodEnd },
        period_end: { gte: periodStart },
      },
    });
    return count > 0;
  }

  // ─── Project helpers (used by InvoicesService — avoids cross-module Prisma access) ─────────

  findProjectWithPackages(projectId: number) {
    return this.prisma.project.findUnique({
      where: { id: BigInt(projectId) },
      include: PROJECT_WITH_PACKAGES_INCLUDE,
    });
  }

  /**
   * Returns active projects that have at least one package assigned.
   * Optionally filters to a specific client and/or a subset of project IDs.
   */
  findActiveProjectsWithPackages(clientId?: number, projectIds?: number[]) {
    const where: Record<string, unknown> = {
      status: "active",
      OR: [
        { hosting_package_id: { not: null } },
        { support_package_id: { not: null } },
      ],
    };
    if (clientId) where.client_id = BigInt(clientId);
    if (projectIds?.length)
      where.id = { in: projectIds.map((id) => BigInt(id)) };
    return this.prisma.project.findMany({
      where,
      include: PROJECT_WITH_PACKAGES_INCLUDE,
    });
  }

  create(data: Parameters<typeof this.prisma.invoice.create>[0]["data"]) {
    return this.prisma.invoice.create({ data, ...INVOICE_INCLUDE });
  }

  update(
    id: number,
    data: Parameters<typeof this.prisma.invoice.update>[0]["data"],
  ) {
    return this.prisma.invoice.update({
      where: { id: BigInt(id) },
      data,
      ...INVOICE_INCLUDE,
    });
  }

  remove(id: number) {
    return this.prisma.invoice.delete({ where: { id: BigInt(id) } });
  }

  /**
   * Returns invoices in draft or sent status whose due_date is before `now`.
   * Used by the daily overdue-detection cron.
   */
  findOverdue(now: Date) {
    return this.prisma.invoice.findMany({
      where: {
        status: { in: ["draft", "sent"] },
        due_date: { lt: now },
      },
      include: {
        client: { select: { id: true, name: true } },
      },
    });
  }
}
