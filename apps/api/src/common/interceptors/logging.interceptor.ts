import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { Request, Response } from "express";

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();

    const { method, ip, path } = request;
    const userAgent = request.get("user-agent") || "";

    // Attempt to extract user info from request (populated by guards/auth)
    const user = (
      request as Request & { user?: { id?: number; email?: string } }
    ).user;
    const userStr = user ? `user=${user.id ?? user.email}` : "user=anonymous";

    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          const statusCode = response.statusCode;
          this.logger.log(
            `${method} ${path} ${statusCode} - ${userAgent} - ${ip} - ${userStr} - ${duration}ms`,
          );
        },
        error: (err: unknown) => {
          const duration = Date.now() - startTime;
          const statusCode =
            err &&
            typeof err === "object" &&
            "status" in err &&
            typeof err.status === "number"
              ? err.status
              : 500;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `${method} ${path} ${statusCode} - ${userAgent} - ${ip} - ${userStr} - ${duration}ms - error: ${message}`,
          );
        },
      }),
    );
  }
}
