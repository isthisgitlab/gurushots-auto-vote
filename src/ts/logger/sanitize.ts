// Keys whose values must never reach disk in plaintext: credentials and account identifiers (email,
// login, username, phone). Match is case-insensitive and covers the OAuth-style underscored names the
// GuruShots auth response actually uses (access_token, auth_token, refresh_token) alongside the camelCase
// + standard HTTP credential header names.
// Bounded recursion depth + a seen-set prevent pathological inputs.
const SENSITIVE_KEY_RE =
    /^(token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|api[_-]?key|secret|(?:set[_-]?)?cookie|authorization|x[_-]auth[_-]token|x[_-]token|email|login|user[_-]?name|phone)$/i;
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
// \b anchors keep `tokenizer` etc. from matching, a run of `=` is no value, so a banner line such as
// `=== Login ===` is left alone, and a key may be quoted (`"email":"a@b.c"`, as in JSON text). A credential's value may
// follow an auth scheme (`Authorization: Bearer abc`: the token is what is secret, so it goes with the scheme) and ends
// at whitespace; a quoted value ends at its closing quote, an escaped quote inside it (`"a\"b c"`) included. An account
// identifier's (email, login, username, phone) runs to the end of the field (`;` `)` or the end of the line, not a
// comma), because such a value may hold spaces (`+371 20000000`, `alice b`) and a part left behind would still identify
// the account.
const CREDENTIAL_MSG_RE =
    /\b(token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|password|api[_-]?key|secret|authorization|x[_-]?auth[_-]?token|x[_-]?token)\b(["']?\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+(?=\S))?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!=+(?:\s|$))\S+)/gi;
const IDENTITY_MSG_RE =
    /\b(email|login|user[_-]?name|phone)\b(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!=+(?:\s|$))[^;)\r\n]*[^;)\s])/gi;
// A cookie header holds several `name=value` pairs split by `;` and spaces, so its value runs to the end of the line
// (a quoted one, as in JSON text, to its closing quote).
const COOKIE_MSG_RE =
    /\b((?:set[_-]?)?cookie)\b(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?!=+(?:\s|$))[^\r\n]*[^\s])/gi;

function redactMessage(message: string): string;
function redactMessage(message: unknown): unknown;
function redactMessage(message: unknown): unknown {
    if (typeof message !== 'string') return message;
    const redact = (_match: string, key: string, sep: string) => `${key}${sep}${REDACTED}`;
    return message.replace(COOKIE_MSG_RE, redact).replace(CREDENTIAL_MSG_RE, redact).replace(IDENTITY_MSG_RE, redact);
}

export { sanitizeForLog, sanitizeLogString, redactMessage, SENSITIVE_KEY_RE, REDACTED };
