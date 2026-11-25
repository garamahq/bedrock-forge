export type ApiErrorDetails =
  | Record<string, unknown>
  | unknown[]
  | string
  | null;

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code?: string;
  readonly details?: ApiErrorDetails;

  constructor(params: {
    message: string;
    status: number;
    statusText: string;
    code?: string;
    details?: ApiErrorDetails;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.code = params.code;
    this.details = params.details;
  }
}
