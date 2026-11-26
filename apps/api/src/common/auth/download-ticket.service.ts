import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomBytes } from "node:crypto";
import { QUEUES } from "@bedrock-forge/shared";

export type DownloadTicketKind = "backup" | "system-backup";

export interface ConsumedDownloadTicket {
  kind: DownloadTicketKind;
  resourceId: number;
  userId: number;
  roles: string[];
}

interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  getdel?(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  setex?(key: string, seconds: number, value: string): Promise<unknown>;
  eval?(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const TICKET_PREFIX = "forge:dl-ticket:";
const TICKET_TTL_SECONDS = 60;
const TICKET_HEX_RE = /^[a-f0-9]{64}$/;

@Injectable()
export class DownloadTicketService {
  constructor(
    @InjectQueue(QUEUES.BACKUPS) private readonly backupsQueue: Queue,
  ) {}

  async issueTicket(opts: {
    kind: DownloadTicketKind;
    resourceId: number;
    userId: number;
    roles: string[];
  }): Promise<string> {
    const ticket = randomBytes(32).toString("hex");
    const key = `${TICKET_PREFIX}${ticket}`;
    const payload = JSON.stringify({
      kind: opts.kind,
      resourceId: opts.resourceId,
      userId: opts.userId,
      roles: opts.roles,
    });

    const client = (await this.backupsQueue.client) as unknown as RedisLikeClient;
    if (typeof client.setex === "function") {
      await client.setex(key, TICKET_TTL_SECONDS, payload);
    } else {
      await client.set(key, payload, "EX", TICKET_TTL_SECONDS);
    }
    return ticket;
  }

  async consumeTicket(
    ticket: string,
    expectedKind: DownloadTicketKind,
    expectedResourceId: number,
  ): Promise<ConsumedDownloadTicket | null> {
    if (!TICKET_HEX_RE.test(ticket)) {
      return null;
    }

    const key = `${TICKET_PREFIX}${ticket}`;
    const client = (await this.backupsQueue.client) as unknown as RedisLikeClient;

    let raw: string | null = null;
    if (typeof client.getdel === "function") {
      raw = await client.getdel(key);
    } else if (typeof client.eval === "function") {
      const lua =
        "local v=redis.call('get',KEYS[1]); if v then redis.call('del',KEYS[1]); end; return v;";
      const res = await client.eval(lua, 1, key);
      raw = typeof res === "string" ? res : null;
    } else {
      raw = await client.get(key);
      if (raw !== null) {
        await client.del(key);
      }
    }

    if (!raw) return null;

    let parsed: ConsumedDownloadTicket;
    try {
      parsed = JSON.parse(raw) as ConsumedDownloadTicket;
    } catch {
      return null;
    }

    if (
      parsed.kind !== expectedKind ||
      parsed.resourceId !== expectedResourceId ||
      !Array.isArray(parsed.roles) ||
      typeof parsed.userId !== "number"
    ) {
      return null;
    }

    return parsed;
  }
}
