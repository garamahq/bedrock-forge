import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InvoicesRepository } from "./invoices.repository";
import { PrismaService } from "../../prisma/prisma.service";

describe("InvoicesRepository (#68, #69, #70)", () => {
  it("allocates max sequence + 1 after a mid-year deletion and handles 4-digit numbers (#68)", async () => {
    const createMock = jest.fn().mockResolvedValue({
      id: BigInt(10),
      invoice_number: "INV-2026-1001",
    });
    const tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          { invoice_number: "INV-2026-001" },
          { invoice_number: "INV-2026-003" }, // 002 deleted
          { invoice_number: "INV-2026-999" },
          { invoice_number: "INV-2026-1000" },
        ]),
        create: createMock,
      },
    };
    const prisma = {
      $transaction: jest.fn((cb: (client: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaService;

    const repo = new InvoicesRepository(prisma);
    await repo.createSerialized(
      {
        project_id: BigInt(7),
        client_id: BigInt(2),
        total_amount: 100,
        period_start: new Date("2026-03-01T00:00:00Z"),
        period_end: new Date("2026-03-31T23:59:59Z"),
        due_date: new Date("2026-03-31T00:00:00Z"),
      } as never,
      2026,
    );

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoice_number: "INV-2026-1001",
        }),
      }),
    );
  });

  it("retries transient serialization/unique conflicts on concurrent sequence allocation (#68)", async () => {
    let attempt = 0;
    const tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          { invoice_number: "INV-2026-001" },
        ]),
        create: jest.fn().mockImplementation(async ({ data }: { data: { invoice_number: string } }) => {
          attempt += 1;
          if (attempt === 1) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Transaction failed due to a write conflict",
              { code: "P2034", clientVersion: "test" },
            );
          }
          return { id: BigInt(2), invoice_number: data.invoice_number };
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((cb: (client: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaService;

    const repo = new InvoicesRepository(prisma);
    const result = await repo.createSerialized(
      {
        project_id: BigInt(1),
        client_id: BigInt(1),
        total_amount: 50,
        period_start: new Date("2026-04-01T00:00:00Z"),
        period_end: new Date("2026-04-30T23:59:59Z"),
        due_date: new Date("2026-05-01T00:00:00Z"),
      } as never,
      2026,
    );

    expect(attempt).toBe(2);
    expect(result.invoice_number).toBe("INV-2026-002");
  });

  it("checks period overlap inside the serializable transaction and throws ConflictException (#69)", async () => {
    const createMock = jest.fn();
    const findFirstMock = jest.fn().mockResolvedValue({ id: BigInt(55) });
    const tx = {
      invoice: {
        findFirst: findFirstMock,
        findMany: jest.fn(),
        create: createMock,
      },
    };
    const prisma = {
      $transaction: jest.fn((cb: (client: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaService;

    const repo = new InvoicesRepository(prisma);
    await expect(
      repo.createSerialized(
        {
          project_id: BigInt(12),
          client_id: BigInt(3),
          total_amount: 120,
          period_start: new Date("2026-01-01T00:00:00Z"),
          period_end: new Date("2026-01-31T23:59:59Z"),
          due_date: new Date("2026-01-31T00:00:00Z"),
        } as never,
        2026,
      ),
    ).rejects.toThrow(ConflictException);

    expect(findFirstMock).toHaveBeenCalledWith({
      where: {
        project_id: BigInt(12),
        period_start: { lte: new Date("2026-01-31T23:59:59Z") },
        period_end: { gte: new Date("2026-01-01T00:00:00Z") },
      },
      select: { id: true },
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("translates database exclusion constraint 23P01 into ConflictException immediately (#69)", async () => {
    const tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'conflicting key value violates exclusion constraint "invoices_no_overlapping_project_period" (23P01)',
            ),
          ),
      },
    };
    const prisma = {
      $transaction: jest.fn((cb: (client: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaService;

    const repo = new InvoicesRepository(prisma);
    await expect(
      repo.createSerialized(
        {
          project_id: BigInt(12),
          client_id: BigInt(3),
          total_amount: 120,
          period_start: new Date("2026-01-01T00:00:00Z"),
          period_end: new Date("2026-01-31T23:59:59Z"),
          due_date: new Date("2026-01-31T00:00:00Z"),
        } as never,
        2026,
      ),
    ).rejects.toThrow(ConflictException);
    expect(tx.invoice.create).toHaveBeenCalledTimes(1);
  });

  it("conditionally transitions overdue invoices only when unpaid and sets status without touching paid_at (#70)", async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      invoice: { updateMany },
    } as unknown as PrismaService;

    const repo = new InvoicesRepository(prisma);
    await expect(repo.markAsOverdueIfEligible(10)).resolves.toBe(false);
    await expect(repo.markAsOverdueIfEligible(11)).resolves.toBe(true);

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: BigInt(10),
        status: { in: ["draft", "sent"] },
        paid_at: null,
      },
      data: { status: "overdue" },
    });
  });
});
