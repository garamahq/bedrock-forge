import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const raw =
      exception instanceof HttpException
        ? exception.getResponse()
        : "Internal server error";

    const message =
      typeof raw === "string"
        ? raw
        : ((raw as Record<string, unknown>).message ?? raw);

    if (status >= 400) {
      this.logger.warn(
        `HTTP ${status} on ${request.method} ${request.path}: ${JSON.stringify(message)}`,
      );
      if (status >= 500) {
        this.logger.error(
          exception instanceof Error ? exception.stack : String(exception),
        );
      }
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.path,
      message,
    });
  }
}
