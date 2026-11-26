import {
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import {
  DownloadTicketKind,
  DownloadTicketService,
} from "../auth/download-ticket.service";

export const DOWNLOAD_TICKET_KIND_KEY = "download_ticket_kind";

export const AllowDownloadTicket = (kind: DownloadTicketKind) =>
  SetMetadata(DOWNLOAD_TICKET_KIND_KEY, kind);

@Injectable()
export class DownloadOrJwtAuthGuard extends AuthGuard("jwt") {
  constructor(
    private readonly reflector: Reflector,
    private readonly tickets: DownloadTicketService,
  ) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const ticketKind = this.reflector.getAllAndOverride<DownloadTicketKind | undefined>(
      DOWNLOAD_TICKET_KIND_KEY,
      [context.getHandler(), context.getClass()],
    );

    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
      query?: Record<string, unknown>;
      params?: Record<string, unknown>;
      user?: { id: number; email: string; roles: string[] };
    }>();

    if (!ticketKind || req.headers?.authorization) {
      return (await super.canActivate(context)) as boolean;
    }

    const rawTicket =
      typeof req.query?.ticket === "string" ? req.query.ticket : null;
    if (!rawTicket) {
      throw new UnauthorizedException("Authorization token or download ticket required");
    }

    const resourceId = Number(req.params?.id);
    if (!Number.isSafeInteger(resourceId) || resourceId <= 0) {
      throw new UnauthorizedException("Invalid download resource identifier");
    }

    const consumed = await this.tickets.consumeTicket(
      rawTicket,
      ticketKind,
      resourceId,
    );
    if (!consumed) {
      throw new UnauthorizedException("Invalid or expired download ticket");
    }

    req.user = {
      id: consumed.userId,
      email: "",
      roles: consumed.roles,
    };
    return true;
  }
}
