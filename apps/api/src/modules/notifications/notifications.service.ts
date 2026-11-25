import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { createHmac } from "crypto";
import { NotificationsRepository } from "./notifications.repository";
import { CreateChannelDto, UpdateChannelDto } from "./dto/notification.dto";
import { EncryptionService } from "../../common/encryption/encryption.service";
import {
  QUEUES,
  JOB_TYPES,
  NotificationEventType,
  buildWebhookRequest,
} from "@bedrock-forge/shared";
import { normalizePage, normalizePageSize } from "../../common/pagination";

@Injectable()
export class NotificationsService {
  constructor(
    private readonly repo: NotificationsRepository,
    private readonly encryption: EncryptionService,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly notifQueue: Queue,
  ) {}

  /* ── Channels ─────────────────────────────────────────────────────────── */

  async findAllChannels() {
    const channels = await this.repo.findAllChannels();
    return channels.map((c) => this.sanitise(c));
  }

  async findChannelById(id: number) {
    const ch = await this.repo.findChannelById(id);
    if (!ch)
      throw new NotFoundException(`Notification channel #${id} not found`);
    return this.sanitise(ch);
  }

  async createChannel(dto: CreateChannelDto) {
    this.validateCreateChannelConfig(dto.type ?? "slack", dto);

    const slackTokenEnc = dto.slack_bot_token
      ? this.encryption.encrypt(dto.slack_bot_token)
      : null;
    const googleChatWebhookEnc = dto.google_chat_webhook_url
      ? this.encryption.encrypt(dto.google_chat_webhook_url)
      : null;
    const webhookUrlEnc = dto.webhook_url
      ? this.encryption.encrypt(dto.webhook_url)
      : null;
    const webhookSecretEnc = dto.webhook_secret
      ? this.encryption.encrypt(dto.webhook_secret)
      : null;

    const ch = await this.repo.createChannel({
      name: dto.name,
      type: dto.type ?? "slack",
      slack_bot_token_enc: slackTokenEnc,
      slack_channel_id: dto.slack_channel_id ?? null,
      google_chat_webhook_url_enc: googleChatWebhookEnc,
      webhook_url_enc: webhookUrlEnc,
      webhook_secret_enc: webhookSecretEnc,
      events: dto.events,
      active: dto.active ?? true,
    });

    return this.sanitise(ch);
  }


  async updateChannel(id: number, dto: UpdateChannelDto) {
    const existing = await this.repo.findChannelById(id);
    if (!existing)
      throw new NotFoundException(`Notification channel #${id} not found`);

    const updateData: Parameters<typeof this.repo.updateChannel>[1] = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.type !== undefined) updateData.type = dto.type;
    if (dto.slack_channel_id !== undefined)
      updateData.slack_channel_id = dto.slack_channel_id;
    if (dto.google_chat_webhook_url !== undefined) {
      updateData.google_chat_webhook_url_enc = dto.google_chat_webhook_url
        ? this.encryption.encrypt(dto.google_chat_webhook_url)
        : null;
    }
    if (dto.webhook_url !== undefined) {
      updateData.webhook_url_enc = dto.webhook_url
        ? this.encryption.encrypt(dto.webhook_url)
        : null;
    }
    if (dto.webhook_secret !== undefined) {
      updateData.webhook_secret_enc = dto.webhook_secret
        ? this.encryption.encrypt(dto.webhook_secret)
        : null;
    }
    if (dto.events !== undefined) updateData.events = dto.events;

    if (dto.active !== undefined) updateData.active = dto.active;
    if (dto.slack_bot_token !== undefined) {
      updateData.slack_bot_token_enc = dto.slack_bot_token
        ? this.encryption.encrypt(dto.slack_bot_token)
        : null;
    }

    this.validateStoredChannelConfig({
      type: updateData.type ?? existing.type,
      active:
        updateData.active !== undefined ? updateData.active : existing.active,
      slack_bot_token_enc:
        updateData.slack_bot_token_enc !== undefined
          ? updateData.slack_bot_token_enc
          : existing.slack_bot_token_enc,
      slack_channel_id:
        updateData.slack_channel_id !== undefined
          ? updateData.slack_channel_id
          : existing.slack_channel_id,
      google_chat_webhook_url_enc:
        updateData.google_chat_webhook_url_enc !== undefined
          ? updateData.google_chat_webhook_url_enc
          : existing.google_chat_webhook_url_enc,
      webhook_url_enc:
        updateData.webhook_url_enc !== undefined
          ? updateData.webhook_url_enc
          : (existing as Record<string, unknown>).webhook_url_enc as string | null,
    });


    const ch = await this.repo.updateChannel(id, updateData);
    return this.sanitise(ch);
  }

  async removeChannel(id: number) {
    await this.findChannelById(id);
    return this.repo.removeChannel(id);
  }

  /* ── Dispatch ─────────────────────────────────────────────────────────── */

  /**
   * Enqueue a notification job. The worker processes it and calls providers.
   * Fire-and-forget — never awaited in the hot path.
   */
  dispatch(
    eventType: NotificationEventType | string,
    payload: Record<string, unknown>,
  ): void {
    this.notifQueue
      .add(
        JOB_TYPES.NOTIFICATION_SEND,
        { eventType, payload },
        { attempts: 3, removeOnFail: 100 },
      )
      .catch(() => {
        // Silently swallow — notification failures must never break primary ops
      });
  }

  /* ── Test ─────────────────────────────────────────────────────────────── */

  async testChannel(
    id: number,
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    const ch = await this.repo.findChannelById(id);
    if (!ch)
      throw new NotFoundException(`Notification channel #${id} not found`);

    try {
      if (ch.type === "google_chat") {
        if (!ch.google_chat_webhook_url_enc) {
          return {
            ok: false,
            error: "Missing Google Chat webhook URL",
            message: "Missing Google Chat webhook URL",
          };
        }

        const webhookUrl = this.encryption.decrypt(
          ch.google_chat_webhook_url_enc,
        );
        await this.postGoogleChatMessage(
          webhookUrl,
          `Bedrock Forge - test notification from channel ${ch.name}`,
        );
      } else if (ch.type === "webhook") {
        const webhookUrlEnc = (ch as Record<string, unknown>).webhook_url_enc as string | null;
        if (!webhookUrlEnc) {
          return { ok: false, error: "Missing webhook URL", message: "Missing webhook URL" };
        }
        const webhookUrl = this.encryption.decrypt(webhookUrlEnc);
        const webhookSecretEnc = (ch as Record<string, unknown>)
          .webhook_secret_enc as string | null | undefined;
        const secret = webhookSecretEnc
          ? this.encryption.decrypt(webhookSecretEnc)
          : null;
        const { body, headers } = buildWebhookRequest({
          event: "test",
          payload: { message: `Test from channel ${ch.name}` },
          signBody: secret
            ? (rawBody) => createHmac("sha256", secret).update(rawBody).digest("hex")
            : undefined,
        });
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers,
          body,
        });
        if (!res.ok) {
          const respBody = await res.text().catch(() => "");
          throw new Error(`Webhook returned ${res.status}: ${respBody}`);
        }
      } else {
        const { WebClient } = await import("@slack/web-api");
        if (!ch.slack_bot_token_enc || !ch.slack_channel_id) {
          return {
            ok: false,
            error: "Missing bot token or channel ID",
            message: "Missing bot token or channel ID",
          };
        }

        const token = this.encryption.decrypt(ch.slack_bot_token_enc);
        const slack = new WebClient(token);
        await slack.chat.postMessage({
          channel: ch.slack_channel_id,
          text: `Bedrock Forge - test notification from channel *${ch.name}*`,
        });
      }


      await this.repo.createLog({
        channel_id: Number(ch.id),
        event_type: "test",
        payload: { message: "Test notification" },
        status: "sent",
      });

      return { ok: true };
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.includes("channel_not_found")
        ? `Channel not found. If this is a private channel, invite the bot first: /invite @BotName in Slack.`
        : raw;
      await this.repo.createLog({
        channel_id: Number(ch.id),
        event_type: "test",
        payload: { message: "Test notification" },
        status: "failed",
        error: msg,
      });
      return { ok: false, error: msg, message: msg };
    }
  }

  /* ── Logs ─────────────────────────────────────────────────────────────── */

  findRecentLogs(limit?: number) {
    return this.repo.findRecentLogs(normalizePageSize(limit, 50));
  }

  /* ── Private ─────────────────────────────────────────────────────────── */

  private sanitise(ch: {
    id: bigint;
    name: string;
    type: string;
    slack_bot_token_enc: string | null;
    slack_channel_id: string | null;
    google_chat_webhook_url_enc: string | null;
    events: string[];
    active: boolean;
    created_at: Date;
    updated_at: Date;
  } & Record<string, unknown>) {
    return {
      id: Number(ch.id),
      name: ch.name,
      type: ch.type,
      has_token: !!ch.slack_bot_token_enc,
      has_webhook: !!ch.google_chat_webhook_url_enc,
      has_webhook_url: !!ch.webhook_url_enc,
      google_chat_configured: !!ch.google_chat_webhook_url_enc,
      slack_channel_id: ch.slack_channel_id,
      events: ch.events,
      active: ch.active,
      created_at: ch.created_at,
      updated_at: ch.updated_at,
    };
  }


  private validateCreateChannelConfig(type: string, dto: CreateChannelDto) {
    if (type === "slack") {
      if (!dto.slack_bot_token || !dto.slack_channel_id)
        throw new BadRequestException(
          "Slack bot token and channel ID are required",
        );
      return;
    }

    if (type === "google_chat") {
      if (!dto.google_chat_webhook_url)
        throw new BadRequestException("Google Chat webhook URL is required");
      return;
    }

    if (type === "webhook") {
      if (!dto.webhook_url)
        throw new BadRequestException("Webhook URL is required for webhook type channels");
      return;
    }

    throw new BadRequestException(
      `Unsupported notification channel type: ${type}`,
    );
  }


  private validateStoredChannelConfig(ch: {
    type: string;
    active: boolean;
    slack_bot_token_enc: string | null;
    slack_channel_id: string | null;
    google_chat_webhook_url_enc: string | null;
    webhook_url_enc?: string | null;
  }) {
    if (!ch.active) return;

    if (ch.type === "google_chat" && !ch.google_chat_webhook_url_enc) {
      throw new BadRequestException("Google Chat webhook URL is required");
    }
    if (
      ch.type === "slack" &&
      (!ch.slack_bot_token_enc || !ch.slack_channel_id)
    ) {
      throw new BadRequestException(
        "Slack bot token and channel ID are required",
      );
    }
    if (ch.type === "webhook" && !ch.webhook_url_enc) {
      throw new BadRequestException("Webhook URL is required");
    }
  }


  private async postGoogleChatMessage(webhookUrl: string, text: string) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google Chat returned ${res.status}: ${body}`);
    }
  }

  /* ── Inbox ─────────────────────────────────────────────────────────── */

  async getUnreadCount(userId: number): Promise<{ count: number }> {
    const count = await this.repo.countUnread(userId);
    return { count };
  }

  async findInbox(
    userId: number,
    opts: { page: number; limit: number; unread?: boolean },
  ) {
    const page = normalizePage(opts.page);
    const limit = normalizePageSize(opts.limit);
    const [items, total] = await this.repo.findForUser(userId, {
      ...opts,
      page,
      limit,
    });
    return {
      data: items.map((n) => ({
        ...n,
        id: Number(n.id),
        user_id: Number(n.user_id),
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async markRead(id: number, userId: number) {
    await this.repo.markRead(id, userId);
    return { ok: true };
  }

  async markAllRead(userId: number) {
    await this.repo.markAllRead(userId);
    return { ok: true };
  }
}
