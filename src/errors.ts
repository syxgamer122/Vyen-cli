export interface RedactOptions {
  secretKeys?: string[];
  redactPatterns?: boolean;
}

export const COMMON_SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /glpat-[a-zA-Z0-9_-]{20,}/g,
  /Bearer\s+[a-zA-Z0-9_.-]{20,}/gi,
];

/**
 * Redacts configured secret keys and standard API token patterns from a string.
 */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  if (typeof text !== 'string' || !text) return text;
  let result = text;
  if (options.secretKeys) {
    for (const key of options.secretKeys) {
      if (typeof key === 'string' && key.length >= 4) {
        result = result.split(key).join('[REDACTED]');
      }
    }
  }
  if (options.redactPatterns !== false) {
    for (const pattern of COMMON_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.source.startsWith('Bearer\\s+')) {
        result = result.replace(pattern, 'Bearer [REDACTED]');
      } else {
        result = result.replace(pattern, '[REDACTED]');
      }
    }
  }
  return result;
}

/**
 * Recursively redacts sensitive strings within an object tree, preserving object structure
 * and property keys untouched.
 */
export function redactObject<T>(obj: T, options: RedactOptions = {}): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return redactSecrets(obj, options) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item, options)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      copy[key] = redactObject(value, options);
    }
    return copy as T;
  }
  return obj;
}

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
  const secretKeys = apiKey ? [apiKey] : [];
  message = redactSecrets(message, { secretKeys });
  return message.slice(0, 2000);
}
