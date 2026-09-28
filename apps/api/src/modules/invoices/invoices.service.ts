import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { existsSync } from "fs";
import { InvoicesRepository } from "./invoices.repository";
import { NotificationsService } from "../notifications/notifications.service";
import {
  GenerateInvoiceDto,
  GenerateBulkInvoiceDto,
  GenerateClientInvoiceDto,
  UpdateInvoiceDto,
  QueryInvoicesDto,
} from "./dto/invoice.dto";

function buildPeriodStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

function buildPeriodEnd(year: number, month: number): Date {
  // Day 0 of the following month = last day of target month
  return new Date(Date.UTC(year, month, 0, 23, 59, 59));
}

function countMonths(
  fromYear: number,
  fromMonth: number,
  toYear: number,
  toMonth: number,
): number {
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

function assertValidPeriod(
  fromYear: number,
  fromMonth: number,
  toYear: number,
  toMonth: number,
): void {
  if (toYear * 12 + toMonth < fromYear * 12 + fromMonth) {
    throw new BadRequestException(
      '"To" period must be on or after "From" period',
    );
  }
}

function firstExistingPath(paths: Array<string | undefined>): string | null {
  return paths.find((path) => path !== undefined && existsSync(path)) ?? null;
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly repo: InvoicesRepository,
    private readonly notifications: NotificationsService,
  ) {}

  async findAll(filters: QueryInvoicesDto) {
    const { data, total } = await this.repo.findAll({
      client_id: filters.client_id,
      project_id: filters.project_id,
      status: filters.status,
      year: filters.year,
      page: filters.page ?? 1,
      limit: filters.limit ?? 20,
    });

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;

    return {
      items: data.map(this.serialise),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findById(id: number) {
    const inv = await this.repo.findById(id);
    if (!inv) throw new NotFoundException(`Invoice #${id} not found`);
    return this.serialise(inv);
  }

  async generatePdf(id: number): Promise<Buffer> {
    const rawInv = await this.repo.findById(id);
    if (!rawInv) throw new NotFoundException(`Invoice #${id} not found`);
    const inv = this.serialise(rawInv);

    const chromePath = firstExistingPath([
      process.env.LIGHTHOUSE_CHROME_PATH,
      process.env.CHROME_PATH,
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ]);

    if (!chromePath) {
      throw new ServiceUnavailableException(
        "Invoice PDF generation is unavailable because Chromium is not installed.",
      );
    }

    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      headless: true,
    });

    try {
      const page = await browser.newPage();
      const html = this.buildInvoiceHtml(inv);
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: "20mm",
          bottom: "20mm",
          left: "20mm",
          right: "20mm",
        },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private buildInvoiceHtml(
    inv: ReturnType<InvoicesService["serialise"]>,
  ): string {
    const formatDate = (value: Date | null) => {
      if (!value) return "—";
      const date = new Date(value);
      return date.toISOString().slice(0, 10);
    };

    const hostingAmount = Number(inv.hosting_amount);
    const supportAmount = Number(inv.support_amount);
    const totalAmount = Number(inv.total_amount);
    const status = escapeHtml(inv.status);
    const statusClass =
      inv.status === "paid" ||
      inv.status === "sent" ||
      inv.status === "overdue" ||
      inv.status === "cancelled"
        ? inv.status
        : "draft";

    let hostingRow = "";
    if (inv.hosting_package_snapshot && hostingAmount > 0) {
      hostingRow = `
        <tr>
          <td>
            <strong>Hosting Package: ${escapeHtml(inv.hosting_package_snapshot)}</strong>
            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">Monthly WordPress hosting plan.</div>
          </td>
          <td style="text-align: right; vertical-align: middle;">€${hostingAmount.toFixed(2)}</td>
        </tr>
      `;
    }

    let supportRow = "";
    if (inv.support_package_snapshot && supportAmount > 0) {
      supportRow = `
        <tr>
          <td>
            <strong>Support & Maintenance: ${escapeHtml(inv.support_package_snapshot)}</strong>
            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">Updates, security scans, and operational support.</div>
          </td>
          <td style="text-align: right; vertical-align: middle;">€${supportAmount.toFixed(2)}</td>
        </tr>
      `;
    }

    const subtotal = hostingAmount + supportAmount;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice ${escapeHtml(inv.invoice_number)}</title>
  <style>
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      color: #1f2937;
      margin: 0;
      padding: 0;
      font-size: 14px;
      line-height: 1.5;
    }
    .invoice-container {
      max-width: 800px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 40px;
      border-bottom: 2px solid #f3f4f6;
      padding-bottom: 20px;
    }
    .logo {
      font-size: 22px;
      font-weight: 700;
      color: #4f46e5;
      letter-spacing: -0.025em;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .status-badge.status-paid { background-color: #ecfdf5; color: #065f46; }
    .status-badge.status-sent { background-color: #eff6ff; color: #1e40af; }
    .status-badge.status-overdue { background-color: #fef2f2; color: #991b1b; }
    .status-badge.status-draft { background-color: #f3f4f6; color: #374151; }
    .status-badge.status-cancelled { background-color: #f5f5f5; color: #555555; }
    
    .meta-grid {
      display: flex;
      justify-content: space-between;
      margin-bottom: 40px;
      gap: 40px;
    }
    .meta-block {
      flex: 1;
    }
    .meta-block h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #6b7280;
      margin: 0 0 8px 0;
    }
    .meta-block p {
      margin: 0 0 4px 0;
      font-size: 13px;
    }
    .table-container {
      margin-bottom: 30px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th {
      background-color: #f9fafb;
      padding: 10px 14px;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      color: #4b5563;
      border-bottom: 2px solid #e5e7eb;
    }
    td {
      padding: 14px;
      border-bottom: 1px solid #f3f4f6;
    }
    .totals {
      display: flex;
      justify-content: flex-end;
      margin-top: 20px;
    }
    .totals-table {
      width: 280px;
    }
    .totals-table td {
      padding: 6px 12px;
      border: none;
    }
    .totals-table tr.grand-total td {
      font-weight: 700;
      font-size: 15px;
      color: #111827;
      border-top: 2px solid #e5e7eb;
      padding-top: 10px;
    }
    .notes-section {
      margin-top: 50px;
      border-top: 1px solid #e5e7eb;
      padding-top: 20px;
      font-size: 12px;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="invoice-container">
    <div class="header">
      <div>
        <div class="logo">BEDROCK FORGE</div>
        <div style="font-size: 11px; color: #6b7280; margin-top: 4px;">Automated WordPress Hosting & Maintenance Operations</div>
      </div>
      <div style="text-align: right;">
        <span class="status-badge status-${statusClass}">${status}</span>
        <div style="margin-top: 8px;">
          <strong style="font-size: 16px; color: #111827;">${escapeHtml(inv.invoice_number)}</strong>
        </div>
      </div>
    </div>
    
    <div class="meta-grid">
      <div class="meta-block">
        <h3>Billed To</h3>
        <p><strong>${escapeHtml(inv.client?.name)}</strong></p>
        ${inv.client?.email ? `<p>${escapeHtml(inv.client.email)}</p>` : ""}
        ${inv.client?.phone ? `<p>${escapeHtml(inv.client.phone)}</p>` : ""}
      </div>
      <div class="meta-block" style="text-align: right;">
        <h3>Invoice Details</h3>
        <p><strong>Date Issued:</strong> ${formatDate(inv.created_at)}</p>
        <p><strong>Due Date:</strong> ${formatDate(inv.due_date)}</p>
        <p><strong>Billing Period:</strong> ${formatDate(inv.period_start)} to ${formatDate(inv.period_end)}</p>
        <p><strong>Project:</strong> ${escapeHtml(inv.project?.name || "—")}</p>
      </div>
    </div>
    
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th style="text-align: right; width: 120px;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${hostingRow}
          ${supportRow}
        </tbody>
      </table>
    </div>
    
    <div class="totals">
      <table class="totals-table">
        <tbody>
          <tr>
            <td style="color: #6b7280;">Subtotal</td>
            <td style="text-align: right;">€${subtotal.toFixed(2)}</td>
          </tr>
          <tr class="grand-total">
            <td>Total Due</td>
            <td style="text-align: right;">€${totalAmount.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    
    ${inv.notes ? `
    <div class="notes-section">
      <h3 style="font-size: 11px; text-transform: uppercase; margin: 0 0 6px 0; color: #374151;">Notes</h3>
      <p style="margin: 0; line-height: 1.5;">${escapeHtml(inv.notes)}</p>
    </div>
    ` : ''}
  </div>
</body>
</html>
    `;
  }

  async generate(dto: GenerateInvoiceDto) {
    assertValidPeriod(dto.fromYear, dto.fromMonth, dto.toYear, dto.toMonth);

    const project = await this.repo.findProjectWithPackages(dto.projectId);

    if (!project)
      throw new NotFoundException(`Project #${dto.projectId} not found`);

    if (!project.hosting_package && !project.support_package) {
      throw new BadRequestException(
        "Project has no hosting or support package assigned — cannot generate invoice",
      );
    }

    const periodStart = buildPeriodStart(dto.fromYear, dto.fromMonth);
    const periodEnd = buildPeriodEnd(dto.toYear, dto.toMonth);

    const alreadyExists = await this.repo.existsForProjectAndPeriodOverlap(
      dto.projectId,
      periodStart,
      periodEnd,
    );
    if (alreadyExists) {
      throw new ConflictException(
        `An invoice already exists for project #${dto.projectId} that overlaps this period`,
      );
    }

    const months = countMonths(
      dto.fromYear,
      dto.fromMonth,
      dto.toYear,
      dto.toMonth,
    );
    const hostingAmount = project.hosting_package
      ? Number(project.hosting_package.price_monthly) * months
      : 0;
    const supportAmount = project.support_package
      ? Number(project.support_package.price_monthly) * months
      : 0;
    const totalAmount = hostingAmount + supportAmount;

    const dueDate = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

    const inv = await this.repo.createSerialized(
      {
        project_id: BigInt(dto.projectId),
        client_id: project.client_id,
        hosting_package_id: project.hosting_package_id ?? undefined,
        support_package_id: project.support_package_id ?? undefined,
        hosting_package_snapshot: project.hosting_package?.name ?? null,
        support_package_snapshot: project.support_package?.name ?? null,
        hosting_amount: hostingAmount,
        support_amount: supportAmount,
        total_amount: totalAmount,
        period_start: periodStart,
        period_end: periodEnd,
        due_date: dueDate,
        status: "draft",
      },
      dto.fromYear,
    );

    this.notifications.dispatch("invoice.created", {
      invoiceNumber: inv.invoice_number,
      projectName: project.name,
      clientName: project.client.name,
      totalAmount,
      year: dto.fromYear,
    });

    return this.serialise(inv);
  }

  async generateBulk(dto: GenerateBulkInvoiceDto) {
    assertValidPeriod(dto.fromYear, dto.fromMonth, dto.toYear, dto.toMonth);

    const projects = await this.repo.findActiveProjectsWithPackages();

    const results: {
      projectId: number;
      invoiceNumber?: string;
      skipped?: string;
    }[] = [];

    const periodStart = buildPeriodStart(dto.fromYear, dto.fromMonth);
    const periodEnd = buildPeriodEnd(dto.toYear, dto.toMonth);
    const months = countMonths(
      dto.fromYear,
      dto.fromMonth,
      dto.toYear,
      dto.toMonth,
    );
    const dueDate = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

    for (const project of projects) {
      const alreadyExists = await this.repo.existsForProjectAndPeriodOverlap(
        Number(project.id),
        periodStart,
        periodEnd,
      );
      if (alreadyExists) {
        results.push({
          projectId: Number(project.id),
          skipped: "already_exists",
        });
        continue;
      }

      const hostingAmount = project.hosting_package
        ? Number(project.hosting_package.price_monthly) * months
        : 0;
      const supportAmount = project.support_package
        ? Number(project.support_package.price_monthly) * months
        : 0;
      const totalAmount = hostingAmount + supportAmount;

      const inv = await this.repo.createSerialized(
        {
          project_id: project.id,
          client_id: project.client_id,
          hosting_package_id: project.hosting_package_id ?? undefined,
          support_package_id: project.support_package_id ?? undefined,
          hosting_package_snapshot: project.hosting_package?.name ?? null,
          support_package_snapshot: project.support_package?.name ?? null,
          hosting_amount: hostingAmount,
          support_amount: supportAmount,
          total_amount: totalAmount,
          period_start: periodStart,
          period_end: periodEnd,
          due_date: dueDate,
          status: "draft",
        },
        dto.fromYear,
      );

      this.notifications.dispatch("invoice.created", {
        invoiceNumber: inv.invoice_number,
        projectName: project.name,
        clientName: project.client.name,
        totalAmount,
        year: dto.fromYear,
      });

      results.push({
        projectId: Number(project.id),
        invoiceNumber: inv.invoice_number,
      });
    }

    return results;
  }

  /**
   * Generate invoices scoped to a single client.
   * If projectIds is provided, only those projects are targeted.
   * If omitted, all active projects of the client with at least one package are invoiced.
   */
  async generateForClient(
    dto: GenerateClientInvoiceDto,
  ): Promise<
    { projectId: number; invoiceNumber?: string; skipped?: string }[]
  > {
    assertValidPeriod(dto.fromYear, dto.fromMonth, dto.toYear, dto.toMonth);

    const projects = await this.repo.findActiveProjectsWithPackages(
      dto.clientId,
      dto.projectIds,
    );

    if (!projects.length) {
      throw new NotFoundException(
        `No invoiceable projects found for client #${dto.clientId}`,
      );
    }

    const results: {
      projectId: number;
      invoiceNumber?: string;
      skipped?: string;
    }[] = [];

    const periodStart = buildPeriodStart(dto.fromYear, dto.fromMonth);
    const periodEnd = buildPeriodEnd(dto.toYear, dto.toMonth);
    const months = countMonths(
      dto.fromYear,
      dto.fromMonth,
      dto.toYear,
      dto.toMonth,
    );
    const dueDate = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

    for (const project of projects) {
      const alreadyExists = await this.repo.existsForProjectAndPeriodOverlap(
        Number(project.id),
        periodStart,
        periodEnd,
      );
      if (alreadyExists) {
        results.push({
          projectId: Number(project.id),
          skipped: "already_exists",
        });
        continue;
      }

      const hostingAmount = project.hosting_package
        ? Number(project.hosting_package.price_monthly) * months
        : 0;
      const supportAmount = project.support_package
        ? Number(project.support_package.price_monthly) * months
        : 0;
      const totalAmount = hostingAmount + supportAmount;

      const inv = await this.repo.createSerialized(
        {
          project_id: project.id,
          client_id: project.client_id,
          hosting_package_id: project.hosting_package_id ?? undefined,
          support_package_id: project.support_package_id ?? undefined,
          hosting_package_snapshot: project.hosting_package?.name ?? null,
          support_package_snapshot: project.support_package?.name ?? null,
          hosting_amount: hostingAmount,
          support_amount: supportAmount,
          total_amount: totalAmount,
          period_start: periodStart,
          period_end: periodEnd,
          due_date: dueDate,
          status: "draft",
        },
        dto.fromYear,
      );

      this.notifications.dispatch("invoice.created", {
        invoiceNumber: inv.invoice_number,
        projectName: project.name,
        clientName: project.client.name,
        totalAmount,
        year: dto.fromYear,
      });

      results.push({
        projectId: Number(project.id),
        invoiceNumber: inv.invoice_number,
      });
    }

    return results;
  }

  async update(id: number, dto: UpdateInvoiceDto) {
    const inv = await this.repo.findById(id);
    if (!inv) throw new NotFoundException(`Invoice #${id} not found`);

    const data: Record<string, unknown> = {};
    if (dto.status) data.status = dto.status;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.due_date) data.due_date = new Date(dto.due_date);

    const updated = await this.repo.update(id, data);
    return this.serialise(updated);
  }

  async markAsPaid(id: number) {
    const inv = await this.repo.findById(id);
    if (!inv) throw new NotFoundException(`Invoice #${id} not found`);

    const updated = await this.repo.update(id, {
      status: "paid",
      paid_at: new Date(),
    });

    return this.serialise(updated);
  }

  async markAsSent(id: number) {
    const inv = await this.repo.findById(id);
    if (!inv) throw new NotFoundException(`Invoice #${id} not found`);

    if (inv.status !== "draft") {
      throw new BadRequestException(
        "Only draft invoices can be marked as sent",
      );
    }

    const updated = await this.repo.update(id, { status: "sent" });
    return this.serialise(updated);
  }

  async remove(id: number): Promise<void> {
    const inv = await this.repo.findById(id);
    if (!inv) throw new NotFoundException(`Invoice #${id} not found`);

    await this.repo.remove(Number(inv.id));
  }

  /**
   * Daily cron: mark unpaid invoices whose due_date has passed as 'overdue'
   * and dispatch a Slack/notification for each.
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async checkOverdueInvoices(): Promise<void> {
    const now = new Date();
    const overdueList = await this.repo.findOverdue(now);

    if (overdueList.length === 0) return;

    for (const inv of overdueList) {
      try {
        await this.repo.update(Number(inv.id), { status: "overdue" });
        this.notifications.dispatch("invoice.overdue", {
          invoiceNumber: inv.invoice_number,
          clientName: inv.client.name,
          totalAmount: Number(inv.total_amount),
        });
      } catch (err) {
        this.logger.error(
          `Failed to mark invoice #${inv.id} as overdue: ${err}`,
        );
      }
    }

    this.logger.log(`Marked ${overdueList.length} invoice(s) as overdue`);
  }

  private serialise(
    inv: NonNullable<Awaited<ReturnType<InvoicesRepository["findById"]>>>,
  ) {
    return {
      ...inv,
      id: Number(inv.id),
      project_id: Number(inv.project_id),
      client_id: Number(inv.client_id),
      hosting_package_id: inv.hosting_package_id
        ? Number(inv.hosting_package_id)
        : null,
      support_package_id: inv.support_package_id
        ? Number(inv.support_package_id)
        : null,
      hosting_amount: Number(inv.hosting_amount),
      support_amount: Number(inv.support_amount),
      total_amount: Number(inv.total_amount),
    };
  }
}
