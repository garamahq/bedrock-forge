import {
  Controller,
  Post,
  Param,
  Query,
  Headers,
  Req,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from "@nestjs/common";
import { Request } from "express";
import { EnvironmentsService } from "./environments.service";

@Controller("webhooks")
export class DeployWebhookController {
  constructor(private readonly svc: EnvironmentsService) {}

  @Post("deploy/:envId")
  @HttpCode(HttpStatus.OK)
  async handleDeployWebhook(
    @Param("envId", ParseIntPipe) envId: number,
    @Req() req: Request,
    @Query("token") tokenQuery?: string,
    @Headers("x-webhook-token") tokenHeader?: string,
    @Headers("x-hub-signature-256") githubSignature?: string,
    @Headers("x-github-event") githubEvent?: string,
  ) {
    const token = tokenQuery || tokenHeader;
    const body = (req.body && typeof req.body === "object"
      ? req.body
      : {}) as Record<string, unknown>;

    if (!token && !githubSignature) {
      throw new BadRequestException("Deployment token or signature is required");
    }

    return this.svc.triggerDeployWebhook(envId, {
      token,
      signature: githubSignature,
      event: githubEvent,
      body,
    });
  }
}

