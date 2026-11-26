import { Reflector } from "@nestjs/core";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { ROLES } from "@bedrock-forge/shared";
import { DownloadTicketService } from "../../common/auth/download-ticket.service";
import {
  DownloadOrJwtAuthGuard,
  DOWNLOAD_TICKET_KIND_KEY,
} from "../../common/guards/download-auth.guard";
import { SystemBackupsController } from "./system-backups.controller";

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    ...actual,
    spawn: jest.fn(),
  };
});

class MockChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = jest.fn();
}

describe("SystemBackupsController download tickets & single-use guard (#23, #24)", () => {
  it("issues single-use Redis download ticket scoped to kind+id and prevents replay or cross-resource use (#23)", async () => {
    const store = new Map<string, string>();
    const redisClient = {
      setex: jest.fn(async (k: string, _ttl: number, v: string) => {
        store.set(k, v);
        return "OK";
      }),
      getdel: jest.fn(async (k: string) => {
        const val = store.get(k) ?? null;
        store.delete(k);
        return val;
      }),
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    };

    const tickets = new DownloadTicketService({
      client: Promise.resolve(redisClient),
    } as never);

    const gdrive = {
      ensureRcloneConfig: jest.fn().mockResolvedValue({
        configPath: "/tmp/rclone.conf",
        remoteName: "gdrive",
        dbValueSnapshot: "enc:conf",
      }),
      syncRefreshedRcloneConfig: jest.fn().mockResolvedValue(undefined),
    };

    const sysSvc = {
      findOne: jest.fn().mockResolvedValue({
        id: BigInt(77),
        status: "completed",
        file_path: "gdrive:1AbCdEfGhIjK/forge_sys.dump",
        size_bytes: BigInt(12),
      }),
    };

    const controller = new SystemBackupsController(
      sysSvc as never,
      {} as never,
      { get: jest.fn() } as unknown as ConfigService,
      gdrive as never,
      tickets,
    );

    const { ticket } = await controller.createDownloadTicket(77, {
      id: 1,
      email: "admin@example.test",
      roles: [ROLES.ADMIN],
    });
    expect(ticket).toMatch(/^[a-f0-9]{64}$/);
    // Must not resemble a JWT token
    expect(ticket).not.toContain(".");

    const reflector = {
      getAllAndOverride: jest.fn((key: string) =>
        key === DOWNLOAD_TICKET_KIND_KEY ? "system-backup" : undefined,
      ),
    } as unknown as Reflector;
    const guard = new DownloadOrJwtAuthGuard(reflector, tickets);

    const makeCtx = (params: { id: string }, query: Record<string, string>) => {
      const req = { headers: {}, params, query, user: undefined as unknown };
      return {
        req,
        ctx: {
          getHandler: () => ({}),
          getClass: () => ({}),
          switchToHttp: () => ({ getRequest: () => req }),
        } as unknown as ExecutionContext,
      };
    };

    // Wrong resource ID rejects and consumes ticket
    const wrongId = makeCtx({ id: "999" }, { ticket });
    await expect(guard.canActivate(wrongId.ctx)).rejects.toThrow(
      UnauthorizedException,
    );

    // Issue fresh ticket for right resource ID (#77)
    const { ticket: freshTicket } = await controller.createDownloadTicket(77, {
      id: 1,
      email: "admin@example.test",
      roles: [ROLES.ADMIN],
    });
    const okReq = makeCtx({ id: "77" }, { ticket: freshTicket });
    await expect(guard.canActivate(okReq.ctx)).resolves.toBe(true);
    expect(okReq.req.user).toEqual({ id: 1, email: "", roles: [ROLES.ADMIN] });

    // Replay of consumed ticket is rejected
    const replayReq = makeCtx({ id: "77" }, { ticket: freshTicket });
    await expect(guard.canActivate(replayReq.ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("streams system backup completely and invokes syncRefreshedRcloneConfig afterward (#24, #36, #58)", async () => {
    const gdrive = {
      ensureRcloneConfig: jest.fn().mockResolvedValue({
        configPath: "/tmp/rclone.conf",
        remoteName: "gdrive",
        dbValueSnapshot: "enc:conf",
      }),
      syncRefreshedRcloneConfig: jest.fn().mockResolvedValue(undefined),
    };
    const sysSvc = {
      findOne: jest.fn().mockResolvedValue({
        id: BigInt(77),
        status: "completed",
        file_path: "gdrive:1AbCdEfGhIjK/forge_sys.dump",
        size_bytes: BigInt(5),
      }),
    };
    const controller = new SystemBackupsController(
      sysSvc as never,
      {} as never,
      { get: jest.fn() } as unknown as ConfigService,
      gdrive as never,
    );

    const child = new MockChild();
    (spawn as jest.Mock).mockReturnValueOnce(child);

    const headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      writableFinished: false,
      destroyed: false,
      setHeader: jest.fn((k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      }),
      status: jest.fn(function (this: { statusCode: number }, c: number) {
        this.statusCode = c;
        return this;
      }),
      json: jest.fn(),
      write: jest.fn(function (this: { headersSent: boolean }, d: Buffer) {
        this.headersSent = true;
        chunks.push(d);
        return true;
      }),
      end: jest.fn(function (this: { writableEnded: boolean; writableFinished: boolean }) {
        this.writableEnded = true;
        this.writableFinished = true;
        return this;
      }),
      destroy: jest.fn(),
    });

    const dl = controller.download(77, req as never, res as never);
    await new Promise((r) => setTimeout(r, 10));
    child.stdout.write(Buffer.from("hello"));
    child.stdout.end();
    child.emit("close", 0);
    await dl;

    expect(headers["content-length"]).toBe("5");
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
    expect(res.end).toHaveBeenCalled();
    expect(gdrive.syncRefreshedRcloneConfig).toHaveBeenCalledWith("enc:conf");
  });
});
