type LogFields = Record<string, unknown>;

const SENSITIVE = /password|token|cookie|authorization|secret|api[_-]?key|session/i;

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function logInfo(message: string, fields: LogFields = {}): void {
  console.log(
    JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      message,
      ...sanitize(fields),
    }),
  );
}

export function logError(message: string, fields: LogFields = {}): void {
  console.error(
    JSON.stringify({
      level: "error",
      timestamp: new Date().toISOString(),
      message,
      ...sanitize(fields),
    }),
  );
}
