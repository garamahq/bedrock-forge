import { Request } from "express";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditInterceptor } from "./audit.interceptor";

describe("AuditInterceptor", () => {
  const createAuditLog = jest.fn().mockResolvedValue({});
  const prisma = {
    auditLog: { create: createAuditLog },
  } as unknown as PrismaService;
  const interceptor = new AuditInterceptor(prisma);
  const privateApi = interceptor as unknown as {
    buildAction(method: string, path: string): string;
    parseResource(path: string): {
      resourceType: string | null;
      resourceId: number | null;
    };
    writeLog(req: Request, outcome: "success" | "failure"): Promise<void>;
  };

  beforeEach(() => createAuditLog.mockClear());

  it("records endpoint-specific actions and the nested resource", () => {
    expect(
      privateApi.buildAction("POST", "/api/projects/12/drift/set-baseline"),
    ).toBe("project.drift.set-baseline");
    expect(
      privateApi.parseResource("/api/security/servers/42/baseline/compare"),
    ).toEqual({ resourceType: "server", resourceId: 42 });
  });

  it("does not copy user email or raw error details into metadata", async () => {
    const request = {
      method: "POST",
      path: "/api/servers/42/test-connection",
      headers: { "x-real-ip": "203.0.113.8" },
      socket: { remoteAddress: "127.0.0.1" },
      user: { id: 7, email: "operator@example.test" },
    } as unknown as Request;

    await privateApi.writeLog(request, "failure");

    expect(createAuditLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "server.test-connection",
        resource_type: "server",
        resource_id: BigInt(42),
        metadata: {
          method: "POST",
          path: "/api/servers/42/test-connection",
          outcome: "failure",
        },
      }),
    });
  });
});
