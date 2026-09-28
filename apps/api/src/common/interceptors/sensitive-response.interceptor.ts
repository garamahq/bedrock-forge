import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { map, Observable } from "rxjs";

const ENCRYPTED_FIELD_PATTERN = /^(encrypted_.*|.*_encrypted|.*_enc)$/i;

function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key === "deploy_webhook_token") {
      result.has_deploy_webhook_token = Boolean(fieldValue);
      continue;
    }
    if (ENCRYPTED_FIELD_PATTERN.test(key)) continue;
    result[key] = redactSensitiveFields(fieldValue);
  }
  return result;
}

@Injectable()
export class SensitiveResponseInterceptor implements NestInterceptor<
  unknown,
  unknown
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map(redactSensitiveFields));
  }
}
