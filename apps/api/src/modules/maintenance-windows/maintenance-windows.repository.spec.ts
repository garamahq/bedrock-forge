import { Test } from "@nestjs/testing";
import { MaintenanceWindowsRepository } from "./maintenance-windows.repository";
import { PrismaService } from "../../prisma/prisma.service";

describe("MaintenanceWindowsRepository (#100)", () => {
  let repo: MaintenanceWindowsRepository;
  let prisma: {
    maintenanceWindow: { count: jest.Mock };
    environment: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      maintenanceWindow: { count: jest.fn().mockResolvedValue(0) },
      environment: {
        findUnique: jest.fn().mockResolvedValue({
          server_id: BigInt(10),
          project_id: BigInt(20),
        }),
      },
    };

    const mod = await Test.createTestingModule({
      providers: [
        MaintenanceWindowsRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repo = mod.get(MaintenanceWindowsRepository);
  });

  it("returns true when environment's project has an active maintenance window", async () => {
    prisma.maintenanceWindow.count
      .mockResolvedValueOnce(0) // env window count
      .mockResolvedValueOnce(1); // server or project count

    const active = await repo.isEnvironmentUnderMaintenance(
      5,
      new Date("2026-11-25T12:00:00Z"),
    );

    expect(active).toBe(true);
    expect(prisma.maintenanceWindow.count).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              resource_type: "project",
              resource_id: BigInt(20),
            }),
          ]),
        }),
      }),
    );
  });
});
