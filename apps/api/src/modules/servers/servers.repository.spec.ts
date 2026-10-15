import { ServersRepository } from "./servers.repository";
import { CreateServerDto } from "./dto/server.dto";
import { PrismaService } from "../../prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";

describe("ServersRepository", () => {
  it("allows a server record without a per-server SSH key", async () => {
    const prisma = {
      server: {
        create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
      },
    };
    const encryption = { encrypt: jest.fn() };
    const repository = new ServersRepository(
      prisma as unknown as PrismaService,
      encryption as unknown as EncryptionService,
    );
    const dto: CreateServerDto = {
      name: "Example server",
      ip_address: "192.0.2.1",
      ssh_user: "root",
    };

    await repository.create(dto);

    expect(prisma.server.create).toHaveBeenCalledWith({
      data: {
        name: "Example server",
        ip_address: "192.0.2.1",
        ssh_user: "root",
      },
    });
    expect(encryption.encrypt).not.toHaveBeenCalled();
  });
});
