import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicesRepository } from "./invoices.repository";
import { NotificationsService } from "../notifications/notifications.service";
import { BillingSettingsService } from "../settings/services/billing-settings.service";

function makeInvoiceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(1),
    invoice_number: "INV-2026-001",
    project_id: BigInt(10),
    client_id: BigInt(20),
    hosting_package_id: BigInt(1),
    support_package_id: BigInt(2),
    hosting_package_snapshot: "Managed Pro",
    support_package_snapshot: "Care Plan",
    hosting_amount: 100,
    support_amount: 50,
    total_amount: 150,
    status: "sent",
    period_start: new Date("2026-01-01T00:00:00Z"),
    period_end: new Date("2026-01-31T23:59:59Z"),
    due_date: new Date("2026-02-01T00:00:00Z"),
    paid_at: null as Date | null,
    notes: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    project: { id: BigInt(10), name: "Example Site" },
    client: { id: BigInt(20), name: "Acme Corp", email: "billing@acme.test", phone: null },
    hosting_package: { id: BigInt(1), name: "Managed Pro" },
    support_package: { id: BigInt(2), name: "Care Plan" },
    ...overrides,
  };
}

describe("InvoicesService (#71, #104, #70, #69)", () => {
  let service: InvoicesService;
  let repo: {
    findById: jest.Mock;
    update: jest.Mock;
    markAsOverdueIfEligible: jest.Mock;
    findOverdue: jest.Mock;
    findProjectWithPackages: jest.Mock;
    findActiveProjectsWithPackages: jest.Mock;
    existsForProjectAndPeriodOverlap: jest.Mock;
    createSerialized: jest.Mock;
  };
  let notifications: { dispatch: jest.Mock };
  let billingSettings: { getBillingSettings: jest.Mock };

  beforeEach(async () => {
    repo = {
      findById: jest.fn(),
      update: jest.fn(),
      markAsOverdueIfEligible: jest.fn(),
      findOverdue: jest.fn(),
      findProjectWithPackages: jest.fn(),
      findActiveProjectsWithPackages: jest.fn(),
      existsForProjectAndPeriodOverlap: jest.fn(),
      createSerialized: jest.fn(),
    };
    notifications = { dispatch: jest.fn() };
    billingSettings = {
      getBillingSettings: jest.fn().mockResolvedValue({
        currency_code: "USD",
        currency_locale: "en-US",
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: InvoicesRepository, useValue: repo },
        { provide: NotificationsService, useValue: notifications },
        { provide: BillingSettingsService, useValue: billingSettings },
      ],
    }).compile();

    service = moduleRef.get(InvoicesService);
  });

  describe("Invoice PDF currency formatting (#71)", () => {
    it("formats line items and totals in USD instead of hardcoded euros", () => {
      const serialise = (
        service as unknown as {
          serialise: (inv: ReturnType<typeof makeInvoiceRecord>) => unknown;
          buildInvoiceHtml: (
            inv: unknown,
            settings: { currency_code: string; currency_locale: string },
          ) => string;
        }
      ).serialise;
      const buildInvoiceHtml = (
        service as unknown as {
          buildInvoiceHtml: (
            inv: unknown,
            settings: { currency_code: string; currency_locale: string },
          ) => string;
        }
      ).buildInvoiceHtml.bind(service);

      const html = buildInvoiceHtml(serialise(makeInvoiceRecord()), {
        currency_code: "USD",
        currency_locale: "en-US",
      });

      expect(html).toContain("$100.00");
      expect(html).toContain("$50.00");
      expect(html).toContain("$150.00");
      expect(html).not.toContain("€");
    });

    it("respects currency decimal precision for 0-decimal (JPY) and 3-decimal (KWD) currencies", () => {
      const svcAny = service as unknown as {
        serialise: (inv: ReturnType<typeof makeInvoiceRecord>) => unknown;
        buildInvoiceHtml: (
          inv: unknown,
          settings: { currency_code: string; currency_locale: string },
        ) => string;
      };
      const inv = svcAny.serialise(
        makeInvoiceRecord({
          hosting_amount: 1500,
          support_amount: 500,
          total_amount: 2000,
        }),
      );

      const jpyHtml = svcAny.buildInvoiceHtml(inv, {
        currency_code: "JPY",
        currency_locale: "ja-JP",
      });
      const expectedJpy = new Intl.NumberFormat("ja-JP", {
        style: "currency",
        currency: "JPY",
      }).format(2000);
      expect(jpyHtml).toContain(expectedJpy);
      expect(jpyHtml).not.toContain("2,000.00");

      const kwdHtml = svcAny.buildInvoiceHtml(
        svcAny.serialise(
          makeInvoiceRecord({
            hosting_amount: 10.25,
            support_amount: 2.095,
            total_amount: 12.345,
          }),
        ),
        { currency_code: "KWD", currency_locale: "en-US" },
      );
      const expectedKwdTotal = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "KWD",
      }).format(12.345);
      expect(kwdHtml).toContain(expectedKwdTotal);
    });
  });

  describe("Payment status and paid_at consistency (#104)", () => {
    it("sets paid_at when paying via generic update(id, { status: 'paid' })", async () => {
      const existing = makeInvoiceRecord({ status: "sent", paid_at: null });
      repo.findById.mockResolvedValue(existing);
      repo.update.mockImplementation(async (_id: number, data: Record<string, unknown>) =>
        makeInvoiceRecord({ ...existing, ...data }),
      );

      const res = await service.update(1, { status: "paid" });
      expect(repo.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: "paid",
          paid_at: expect.any(Date),
        }),
      );
      expect(res.paid_at).toBeInstanceOf(Date);
    });

    it("preserves original paid_at when markAsPaid or update({ status: 'paid' }) is repeated", async () => {
      const originalPaidAt = new Date("2026-01-15T12:00:00Z");
      const paidInv = makeInvoiceRecord({ status: "paid", paid_at: originalPaidAt });
      repo.findById.mockResolvedValue(paidInv);
      repo.update.mockImplementation(async (_id: number, data: Record<string, unknown>) =>
        makeInvoiceRecord({ ...paidInv, ...data }),
      );

      const res1 = await service.markAsPaid(1);
      expect(res1.paid_at).toEqual(originalPaidAt);
      if (repo.update.mock.calls.length > 0) {
        expect(repo.update).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ paid_at: originalPaidAt }),
        );
      }

      const res2 = await service.update(1, { status: "paid" });
      expect(res2.paid_at).toEqual(originalPaidAt);
    });

    it("clears paid_at when moving an already-paid invoice to another status", async () => {
      const paidInv = makeInvoiceRecord({
        status: "paid",
        paid_at: new Date("2026-01-15T12:00:00Z"),
      });
      repo.findById.mockResolvedValue(paidInv);
      repo.update.mockImplementation(async (_id: number, data: Record<string, unknown>) =>
        makeInvoiceRecord({ ...paidInv, ...data }),
      );

      const res = await service.update(1, { status: "cancelled" });
      expect(repo.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: "cancelled",
          paid_at: null,
        }),
      );
      expect(res.paid_at).toBeNull();
    });
  });

  describe("Overdue cron race protection (#70)", () => {
    it("skips overdue notification when an invoice is paid concurrently before update", async () => {
      repo.findOverdue.mockResolvedValue([
        makeInvoiceRecord({ id: BigInt(101), invoice_number: "INV-2026-101" }),
        makeInvoiceRecord({ id: BigInt(102), invoice_number: "INV-2026-102" }),
      ]);
      repo.markAsOverdueIfEligible
        .mockResolvedValueOnce(false) // inv 101 paid concurrently
        .mockResolvedValueOnce(true); // inv 102 transitioned

      await service.checkOverdueInvoices();

      expect(repo.markAsOverdueIfEligible).toHaveBeenCalledWith(101);
      expect(repo.markAsOverdueIfEligible).toHaveBeenCalledWith(102);
      expect(notifications.dispatch).toHaveBeenCalledTimes(1);
      expect(notifications.dispatch).toHaveBeenCalledWith(
        "invoice.overdue",
        expect.objectContaining({ invoiceNumber: "INV-2026-102" }),
      );
    });
  });

  describe("Concurrent overlapping billing rejection (#69)", () => {
    it("skips conflicting project cleanly in generateBulk without emitting duplicate notification", async () => {
      repo.findActiveProjectsWithPackages.mockResolvedValue([
        {
          id: BigInt(1),
          name: "Site One",
          client_id: BigInt(10),
          hosting_package_id: BigInt(1),
          support_package_id: null,
          hosting_package: { name: "Basic", price_monthly: 50 },
          support_package: null,
          client: { name: "Client A" },
        },
        {
          id: BigInt(2),
          name: "Site Two",
          client_id: BigInt(10),
          hosting_package_id: BigInt(1),
          support_package_id: null,
          hosting_package: { name: "Basic", price_monthly: 75 },
          support_package: null,
          client: { name: "Client A" },
        },
      ]);
      repo.existsForProjectAndPeriodOverlap.mockResolvedValue(false);
      // Project 1 raced with concurrent single generate(), Project 2 succeeds
      repo.createSerialized
        .mockRejectedValueOnce(new ConflictException("Overlap detected"))
        .mockResolvedValueOnce(
          makeInvoiceRecord({ id: BigInt(2), invoice_number: "INV-2026-002" }),
        );

      const res = await service.generateBulk({
        fromYear: 2026,
        fromMonth: 5,
        toYear: 2026,
        toMonth: 5,
      });

      expect(res).toEqual([
        { projectId: 1, skipped: "already_exists" },
        { projectId: 2, invoiceNumber: "INV-2026-002" },
      ]);
      expect(notifications.dispatch).toHaveBeenCalledTimes(1);
      expect(notifications.dispatch).toHaveBeenCalledWith(
        "invoice.created",
        expect.objectContaining({ projectName: "Site Two" }),
      );
    });

    it("propagates ConflictException and suppresses notification when concurrent single generate loses race", async () => {
      repo.findProjectWithPackages.mockResolvedValue({
        id: BigInt(1),
        name: "Site One",
        client_id: BigInt(10),
        hosting_package_id: BigInt(1),
        support_package_id: null,
        hosting_package: { name: "Basic", price_monthly: 50 },
        support_package: null,
        client: { name: "Client A" },
      });
      repo.existsForProjectAndPeriodOverlap.mockResolvedValue(false);
      repo.createSerialized.mockRejectedValue(
        new ConflictException("Overlap detected"),
      );

      await expect(
        service.generate({
          projectId: 1,
          fromYear: 2026,
          fromMonth: 5,
          toYear: 2026,
          toMonth: 5,
        }),
      ).rejects.toThrow(ConflictException);

      expect(notifications.dispatch).not.toHaveBeenCalled();
    });
  });
});
