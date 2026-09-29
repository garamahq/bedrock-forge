import { PrismaService } from "../../prisma/prisma.service";
import { JobExecutionsRepository } from "./job-executions.repository";

describe("JobExecutionsRepository search", () => {
  it("searches project, client, environment, queue, type, and error fields", async () => {
    const count = jest.fn().mockResolvedValue(0);
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      jobExecution: { count, findMany },
    } as unknown as PrismaService;
    const repository = new JobExecutionsRepository(prisma);

    await repository.findPaginated({ search: "Misaha" }, 1, 20);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { queue_name: { contains: "Misaha", mode: "insensitive" } },
            { job_type: { contains: "Misaha", mode: "insensitive" } },
            { bull_job_id: { contains: "Misaha", mode: "insensitive" } },
            { last_error: { contains: "Misaha", mode: "insensitive" } },
            {
              environment: {
                is: {
                  project: {
                    is: {
                      name: { contains: "Misaha", mode: "insensitive" },
                    },
                  },
                },
              },
            },
          ]),
        }),
      }),
    );
  });

  it("matches a numeric search against the execution record ID", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      jobExecution: {
        count: jest.fn().mockResolvedValue(0),
        findMany,
      },
    } as unknown as PrismaService;
    const repository = new JobExecutionsRepository(prisma);

    await repository.findPaginated({ search: "42" }, 1, 20);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ id: 42n }]),
        }),
      }),
    );
  });
});
