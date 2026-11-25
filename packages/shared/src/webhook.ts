export interface WebhookEnvelope {
  event: string;
  payload: Record<string, unknown>;
  timestamp: string;
  source: string;
}

export interface BuildWebhookRequestOptions {
  event: string;
  payload: Record<string, unknown>;
  source?: string;
  timestamp?: string;
  signBody?: (body: string) => string | null | undefined;
}

/**
 * Build canonical JSON payload and headers for outgoing Forge webhooks,
 * ensuring API test deliveries and worker dispatches share the exact contract.
 */
export function buildWebhookRequest(options: BuildWebhookRequestOptions): {
  body: string;
  headers: Record<string, string>;
} {
  const envelope: WebhookEnvelope = {
    event: options.event,
    payload: options.payload,
    timestamp: options.timestamp ?? new Date().toISOString(),
    source: options.source ?? "bedrock-forge",
  };

  const body = JSON.stringify(envelope);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Forge-Event": options.event,
  };

  const signature = options.signBody?.(body);
  if (signature) {
    headers["X-Forge-Signature"] = signature.startsWith("sha256=")
      ? signature
      : `sha256=${signature}`;
  }

  return { body, headers };
}
