import { Test } from "@nestjs/testing";
import { createHash } from "crypto";
import { RemoteOpsService } from "./remote-ops.service";
import { RemoteOpsRepository } from "./remote-ops.repository";
import { ServersService } from "../servers/servers.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { BadRequestException, NotFoundException } from "@nestjs/common";

jest.mock("@bedrock-forge/remote-executor", () => ({
  createRemoteExecutor: jest.fn(),
}));

const mockExecutor = {
  execute: jest.fn(),
  pullFile: jest.fn(),
  pushFile: jest.fn(),
};

const makeRepo = () => ({
  createAuditLog: jest.fn(),
  findTemplatesByEnvType: jest.fn(),
  findProjectById: jest.fn(),
  findEnvironmentById: jest.fn(),
  findNotes: jest.fn(),
  createNote: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
  findAllTemplates: jest.fn(),
  createTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  findTemplatesForValidation: jest.fn(),
  findEnvironmentWithServerAndProject: jest.fn(),
  resourceExists: jest.fn(),
});

const makeServersService = () => ({
  getServerSshConfig: jest.fn().mockResolvedValue({}),
});

describe("RemoteOpsService", () => {
  let service: RemoteOpsService;
  let repo: ReturnType<typeof makeRepo>;
  let serversService: ReturnType<typeof makeServersService>;

  beforeEach(async () => {
    repo = makeRepo();
    serversService = makeServersService();
    (createRemoteExecutor as jest.Mock).mockReturnValue(mockExecutor);

    const module = await Test.createTestingModule({
      providers: [
        RemoteOpsService,
        { provide: RemoteOpsRepository, useValue: repo },
        { provide: ServersService, useValue: serversService },
      ],
    }).compile();

    service = module.get(RemoteOpsService);

    // Reset executor mocks
    mockExecutor.execute.mockReset();
    mockExecutor.pullFile.mockReset();
    mockExecutor.pushFile.mockReset();

    mockExecutor.execute.mockImplementation(async (cmd: string) => {
      if (cmd.includes("realpath")) {
        if (cmd.includes(".env")) {
          return { code: 0, stdout: "/var/www/.env", stderr: "" };
        }
        return { code: 0, stdout: "/var/www", stderr: "" };
      }
      if (cmd.includes("stat")) {
        return { code: 0, stdout: "100", stderr: "" };
      }
      if (cmd.includes("file -bi")) {
        return { code: 0, stdout: "text/plain", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
  });

  describe("readEnvFile", () => {
    it("throws NotFoundException if environment does not exist", async () => {
      repo.findEnvironmentWithServerAndProject.mockResolvedValue(null);
      await expect(service.readEnvFile(1)).rejects.toThrow(NotFoundException);
    });

    it("reads env file safely and reveals secrets if matching revealKey", async () => {
      const mockEnv = {
        id: BigInt(1),
        type: "production",
        root_path: "/var/www",
        server: { ip: "1.2.3.4", port: 22 },
        project: { name: "Test project" },
      };
      repo.findEnvironmentWithServerAndProject.mockResolvedValue(mockEnv);
      repo.findTemplatesByEnvType.mockResolvedValue([]);
      mockExecutor.pullFile.mockResolvedValue(Buffer.from("API_KEY=super-secret-key\nAPP_NAME=Bedrock"));

      const res = await service.readEnvFile(1, "API_KEY");
      expect(res.variables).toContainEqual(
        expect.objectContaining({
          key: "API_KEY",
          value: "super-secret-key",
          is_secret: true,
        }),
      );
    });

    it("fully masks secret values by default", async () => {
      const mockEnv = {
        id: BigInt(1),
        type: "production",
        root_path: "/var/www",
        server: { ip: "1.2.3.4", port: 22 },
        project: { name: "Test project" },
      };
      repo.findEnvironmentWithServerAndProject.mockResolvedValue(mockEnv);
      repo.findTemplatesByEnvType.mockResolvedValue([]);
      mockExecutor.pullFile.mockResolvedValue(
        Buffer.from("API_KEY=super-secret-key\nAPP_NAME=Bedrock"),
      );

      const res = await service.readEnvFile(1);
      expect(res.variables).toContainEqual(
        expect.objectContaining({
          key: "API_KEY",
          value: "",
          masked_value: "****",
          is_secret: true,
        }),
      );
      expect(res.content).toContain("API_KEY=****");
      expect(res.content).not.toContain("super-secret-key");
    });
  });

  describe("writeEnvFile", () => {
    it("writes env file and verifies validation rules", async () => {
      const mockEnv = {
        id: BigInt(1),
        type: "production",
        root_path: "/var/www",
        server: { ip: "1.2.3.4", port: 22 },
        project: { name: "Test project" },
      };
      repo.findEnvironmentWithServerAndProject.mockResolvedValue(mockEnv);
      repo.findTemplatesForValidation.mockResolvedValue([]);
      mockExecutor.pullFile.mockResolvedValue(Buffer.from("API_KEY=key\n"));

      const dto = {
        path: ".env",
        content: "API_KEY=new-key\n",
        checksum: createHash("sha256").update("API_KEY=key\n").digest("hex"),
        confirmation: "production",
      };

      const res = await service.writeEnvFile(1, dto);
      expect(res.success).toBe(true);
      expect(mockExecutor.pushFile).toHaveBeenCalledWith(
        expect.objectContaining({
          remotePath: "/var/www/.env",
          content: "API_KEY=new-key\n",
        }),
      );
    });
  });

  describe("getNotes", () => {
    it("fetches resource notes", async () => {
      repo.findNotes.mockResolvedValue([{ id: 1, body: "note" }]);
      const res = await service.getNotes("project", "1");
      expect(repo.findNotes).toHaveBeenCalledWith("project", "1");
      expect(res).toEqual([{ id: 1, body: "note" }]);
    });
  });

  describe("createNote", () => {
    it("creates resource note after checking existence", async () => {
      repo.resourceExists.mockResolvedValue(true);
      repo.createNote.mockResolvedValue({ id: 1 });

      const dto = {
        resource_type: "project" as const,
        resource_id: "2",
        body: "Hello note",
        pinned: true,
      };

      const res = await service.createNote(dto, 3);
      expect(repo.resourceExists).toHaveBeenCalledWith("project", "2");
      expect(repo.createNote).toHaveBeenCalledWith({
        resource_type: "project",
        resource_id: BigInt(2),
        body: "Hello note",
        pinned: true,
        created_by_id: BigInt(3),
      });
      expect(res).toBeDefined();
    });
  });
});
