export function safeError(error: unknown, apiKey?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    const body = typeof err.responseBody === 'string' ? err.responseBody.trim() : undefined;
    if (body && (message === 'Provider returned error' || !message.trim())) {
      let detailed: string | undefined;
      try {
        const json = JSON.parse(body);
        const extracted = json?.error?.metadata?.raw ?? json?.error?.message ?? json?.message;
        if (typeof extracted === 'string' && extracted.trim()) {
          detailed = extracted.trim();
        }
      } catch {
        if (body.length < 500 && !body.includes('<html')) {
          detailed = body;
        }
      }
      if (detailed) {
        const code = err.statusCode ?? ('status' in err && typeof err.status === 'number' ? err.status : undefined);
        message = code ? `[${code}] ${detailed}` : detailed;
      }
    }
  }
  if (apiKey) message = message.split(apiKey).join('[REDACTED]');
  return message.slice(0, 2000);
}
