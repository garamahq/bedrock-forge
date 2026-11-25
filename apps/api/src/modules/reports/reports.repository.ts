import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { QUEUES } from "@bedrock-forge/shared";

@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findHistory() {
    const rows = await this.prisma.jobExecution.findMany({
      where: { queue_name: QUEUES.REPORTS },
      orderBy: { created_at: "desc" },
      take: 50,
      select: {
        id: true,
        bull_job_id: true,
        job_type: true,
        status: true,
        progress: true,
        last_error: true,
        payload: true,
        execution_log: true,
        started_at: true,
        completed_at: true,
        created_at: true,
      },
    });
    // BigInt IDs need to be serialised
    return rows.map((r) => ({ ...r, id: String(r.id) }));
  }

  async findAvailableChannels() {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    });
    return channels.map((c) => ({
      id: Number(c.id),
      name: c.name,
      type: c.type,
      slack_channel_id: c.slack_channel_id,
      has_token: !!c.slack_bot_token_enc,
      has_webhook: !!c.google_chat_webhook_url_enc,
      has_webhook_url: !!c.webhook_url_enc,
      active: c.active,
      subscribed: c.events.includes("report.weekly"),
    }));
  }

  async findChannelById(id: number) {
    return this.prisma.notificationChannel.findUnique({
      where: { id: BigInt(id) },
    });
  }

  async updateChannelEvents(id: number, events: string[]) {
    const updated = await this.prisma.notificationChannel.update({
      where: { id: BigInt(id) },
      data: { events },
    });
    return {
      id: Number(updated.id),
      name: updated.name,
      subscribed: updated.events.includes("report.weekly"),
    };
  }
}
