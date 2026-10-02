/**
 * CLI string-to-value coercion shared between the in-app CLI
 * (`src/ts/cli/cli.ts`) and the standalone `scripts/settings-cli.ts`.
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

/**
 * @param raw - the argv token
 * @returns the parsed JSON value, a number, or `raw` itself
 */
function parseSettingValue(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        // isNaN() coerces with Number() itself; the explicit call only types the argument.
        if (!isNaN(Number(raw)) && !isNaN(parseFloat(raw))) return parseFloat(raw);
        return raw;
    }
}

export { parseSettingValue };
