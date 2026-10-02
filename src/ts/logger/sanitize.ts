// Keys whose values must never reach disk in plaintext. Match is case-
// insensitive and covers the OAuth-style underscored names the GuruShots
// auth response actually uses (access_token, auth_token, refresh_token)
// alongside the camelCase + standard HTTP credential header names.
// Bounded recursion depth + a seen-set prevent pathological inputs.
const SENSITIVE_KEY_RE =
    /^(token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|api[_-]?key|secret|cookie|authorization|x[_-]auth[_-]token|x[_-]token)$/i;
const REDACTED = '[REDACTED]';
const MAX_SANITIZE_DEPTH = 6;

/**
 * Copy of `value` with sensitive keys redacted, depth-bounded and cycle-safe.
 * A top-level plain object comes back as a plain object.
 */
function sanitizeForLog(value: Record<string, unknown>): Record<string, unknown>;
function sanitizeForLog(value: unknown, depth?: number, seen?: WeakSet<object>): unknown;
function sanitizeForLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_SANITIZE_DEPTH) return '[Object]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForLog(item, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            out[key] = REDACTED;
        } else {
            out[key] = sanitizeForLog(record[key], depth + 1, seen);
        }
    }
    return out;
}

// Bounds an untrusted string before it is interpolated into a log line:
// CR/LF/tab collapse to spaces (a newline would otherwise forge a synthetic
// log line in the plain-text file) and the result is truncated. Shared by the
// IPC shell (actions.handlers) and the core services (challengeTitlePin) so
// both sides sanitize identically.
const sanitizeLogString = (value: unknown, maxLength: number = 200): string =>
    String(value ?? '')
        .replace(/[\r\n\t]/g, ' ')
        .slice(0, maxLength);

// Message-level counterpart to sanitizeForLog. sanitizeForLog only sees the
// structured `data` object; it never touches the free-form message string.
// Callers that fold a credential into the message via positional args (e.g.
// a `login with: <user> <password>` line) would
// otherwise leak plaintext to disk. This scrubs the value after any
// sensitive key written as `key: value` or `key=value` (quotes optional)
// and runs on every writeLog message. The key set mirrors SENSITIVE_KEY_RE;
// \b anchors keep `tokenizer` etc. from matching.
const SENSITIVE_MSG_RE =
    /\b(token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|api[_-]?key|secret|cookie|authorization|x[_-]?auth[_-]?token|x[_-]?token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

function redactMessage(message: string): string;
function redactMessage(message: unknown): unknown;
function redactMessage(message: unknown): unknown {
    if (typeof message !== 'string') return message;
    return message.replace(SENSITIVE_MSG_RE, (_match, key, sep) => `${key}${sep}${REDACTED}`);
}

export { sanitizeForLog, sanitizeLogString, redactMessage, REDACTED };
