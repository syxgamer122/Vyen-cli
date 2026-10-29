export interface RedactOptions {
  secretKeys?: string[];
  redactPatterns?: boolean;
}

export const COMMON_SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /glpat-[a-zA-Z0-9_-]{20,}/g,
  /\bA[SK]IA[0-9A-Z]{16}\b/g,
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
export function redactObject<T>(obj: T, options: RedactOptions = {}, seen: WeakSet<object> = new WeakSet()): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return redactSecrets(obj, options) as unknown as T;
  }
  if (typeof obj !== 'object') return obj;
  if (
    obj instanceof Date ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(obj)) ||
    ArrayBuffer.isView(obj) ||
    obj instanceof RegExp ||
    obj instanceof Error ||
    obj instanceof Map ||
    obj instanceof Set
  ) {
    return obj;
  }
  if (seen.has(obj as object)) {
    return obj;
  }
  seen.add(obj as object);
  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item, options, seen)) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    copy[key] = redactObject(value, options, seen);
  }
  return copy as T;
}

/**
 * A thrown value that is not an `Error` still has to say something useful. The
 * AI SDK re-throws the provider's raw JSON payload when a stream fails, so
 * `String(value)` printed `[object Object]` exactly when the user needed the
 * upstream reason.
 */
function describeNonError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return String(error);
  const record = error as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'reason'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const nested = describeNonError(value);
      if (nested && nested !== '[object Object]') return nested;
    }
  }
  const body = typeof record.responseBody === 'string' ? record.responseBody.trim() : '';
  if (body) return body;
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json;
  } catch {
    // fall through: a cyclic payload has no printable form
  }
  return 'Unknown provider error.';
}

export function safeError(error: unknown, apiKey?: string): string {
  let message = error instanceof Error ? error.message : describeNonError(error);
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
