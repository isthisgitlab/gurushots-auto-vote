/**
 * CLI string-to-value coercion shared between the in-app CLI
 * (`src/js/cli/cli.js`) and the standalone `scripts/settings-cli.js`.
 *
 * Tries JSON first, then numeric, else returns the raw string unchanged.
 * JSON-first is intentional: it correctly parses `null`, `true`/`false`,
 * quoted strings, arrays, objects, and JSON-ish primitives in one pass;
 * the numeric fallback only catches non-JSON numerics like `.5` / `5.`.
 *
 * Per-command schema validation (e.g. checking that the parsed value
 * is valid for SETTINGS_SCHEMA[key]) lives with each caller — only
 * the parsing layer is shared.
 */

function parseSettingValue(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        if (!isNaN(raw) && !isNaN(parseFloat(raw))) return parseFloat(raw);
        return raw;
    }
}

module.exports = { parseSettingValue };
