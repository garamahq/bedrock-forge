import { SecurityIncidentsService } from "./security-incidents.service";
import { SecurityRepository } from "./security.repository";
import { NotFoundException } from "@nestjs/common";

describe("SecurityIncidentsService", () => {
  let service: SecurityIncidentsService;
  let repoMock: any;

  beforeEach(() => {
    repoMock = {
      listIncidents: jest.fn().mockResolvedValue({
        data: [{ id: 1, title: "Webshell Backdoor", status: "open" }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      }),
      findIncidentById: jest.fn(),
      updateIncidentStatus: jest.fn().mockResolvedValue({ id: 1, status: "contained" }),
    };

    service = new SecurityIncidentsService(repoMock as SecurityRepository);
  });

  it("lists security incidents with filters", async () => {
    const result = await service.listIncidents({ status: "open", serverId: 5 });
    expect(result.total).toBe(1);
    expect(repoMock.listIncidents).toHaveBeenCalledWith({
      status: "open",
      serverId: BigInt(5),
      page: undefined,
      limit: undefined,
    });
  });

  it("throws NotFoundException when incident not found", async () => {
    repoMock.findIncidentById.mockResolvedValue(null);
    await expect(service.getIncidentById(999)).rejects.toThrow(NotFoundException);
  });

  it("updates incident status", async () => {
    repoMock.findIncidentById.mockResolvedValue({ id: BigInt(1), status: "open" });
    const result = await service.updateIncidentStatus(1, "contained");
    expect(result.status).toBe("contained");
    expect(repoMock.updateIncidentStatus).toHaveBeenCalledWith(BigInt(1), "contained");
  });
});
