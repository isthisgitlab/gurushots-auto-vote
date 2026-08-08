// @ts-check
/**
 * Defaults for the app-level (non-schema) settings the GUI's Settings
 * form edits. These keys live outside SETTINGS_SCHEMA (they are not
 * per-challenge values), so the schema can't supply their defaults —
 * this module is the single source of truth shared by the settings
 * facade's getDefaultSettings() and the renderer's useSettingsForm
 * (which previously hand-mirrored the values).
 *
 * Dependency-free on purpose: it is bundled into the renderer, so it
 * must not pull in the storage transport or logger.
 */

/**
 * Fresh object per call so callers can never share (and mutate) the
 * same nested array reference.
 *
 * @returns {{
 *   theme: string,
 *   language: string,
 *   timezone: string,
 *   customTimezones: string[],
 *   stayLoggedIn: boolean,
 *   apiTimeout: number,
 *   checkFrequencyMin: number,
 *   checkFrequencyMax: number,
 *   apiMaxRetries: number,
 *   apiRetryBaseDelayMs: number,
 * }}
 */
const getUiDefaultSettings = () => ({
    theme: 'light',
    language: 'en',
    timezone: 'Europe/Riga',
    customTimezones: [],
    stayLoggedIn: false,
    // Stored as seconds — api-client.js multiplies by 1000 before handing
    // to axios. (A pre-refactor modal used 30000 here, which silently
    // corrupted the stored timeout to ~8h on the first Save.)
    apiTimeout: 30, // API request timeout in seconds (default: 30 seconds)
    checkFrequencyMin: 3, // Lower bound (minutes). Equal to max → fixed-cadence behavior.
    checkFrequencyMax: 3, // Upper bound (minutes). Each cycle picks a random delay in [min, max].
    // Resilience: retries on transient API failures (network/timeout/429/5xx)
    // with exponential backoff.
    apiMaxRetries: 3, // 0 disables.
    apiRetryBaseDelayMs: 1000, // Base for exponential backoff between retries (ms).
});

module.exports = { getUiDefaultSettings };
