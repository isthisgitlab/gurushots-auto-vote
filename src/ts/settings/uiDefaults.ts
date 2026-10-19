/**
 * Defaults for the app-level (non-schema) settings the GUI's Settings
 * form edits. These keys live outside SETTINGS_SCHEMA (they are not
 * per-challenge values), so the schema can't supply their defaults —
 * this module is the single source of truth shared by the settings
 * facade's getDefaultSettings() and the renderer's useSettingsForm.
 *
 * Dependency-free on purpose: it is bundled into the renderer, so it
 * must not pull in the storage transport or logger.
 */

/**
 * Canonical default timezone — what a missing `timezone` setting means.
 * Every reader resolves the setting through `effectiveTimezone`, never
 * `|| DEFAULT_TIMEZONE`, so an empty value means UTC and changing the
 * default means changing exactly one line.
 */
const DEFAULT_TIMEZONE = 'Europe/Riga';

/** The zones the timezone picker always offers; they are never added to `customTimezones` or removed from the picker. */
const BUILT_IN_TIMEZONES: readonly string[] = [DEFAULT_TIMEZONE, 'UTC'];

/** The zone a `timezone` value means: missing → DEFAULT_TIMEZONE, empty/blank → 'UTC', else the value trimmed ('local' included). */
const effectiveTimezone = (value: string | null | undefined): string =>
    value == null ? DEFAULT_TIMEZONE : value.trim() || 'UTC';

/**
 * Every DaisyUI theme, in DaisyUI's own order — styles.css compiles them all
 * (`themes: all`), and the theme pickers offer this list. A test keeps it in
 * step with the installed daisyui package.
 */
const THEMES = [
    'light',
    'dark',
    'cupcake',
    'bumblebee',
    'emerald',
    'corporate',
    'synthwave',
    'retro',
    'cyberpunk',
    'valentine',
    'halloween',
    'garden',
    'forest',
    'aqua',
    'lofi',
    'pastel',
    'fantasy',
    'wireframe',
    'black',
    'luxury',
    'dracula',
    'cmyk',
    'autumn',
    'business',
    'acid',
    'lemonade',
    'night',
    'coffee',
    'winter',
    'dim',
    'nord',
    'sunset',
    'caramellatte',
    'abyss',
    'silk',
] as const;

/**
 * Fresh object per call so callers can never share (and mutate) the
 * same nested array reference.
 */
const getUiDefaultSettings = (): {
    theme: string;
    language: string;
    timezone: string;
    customTimezones: string[];
    stayLoggedIn: boolean;
    apiTimeout: number;
    checkFrequencyMin: number;
    checkFrequencyMax: number;
    apiMaxRetries: number;
    apiRetryBaseDelayMs: number;
} => ({
    theme: 'light',
    language: 'en',
    timezone: DEFAULT_TIMEZONE,
    customTimezones: [],
    stayLoggedIn: false,
    // Stored as seconds — api-client.ts multiplies by 1000 before handing
    // to axios. (A millisecond value like 30000 here would silently
    // corrupt the stored timeout to ~8h on the first Save.)
    apiTimeout: 30, // API request timeout in seconds (default: 30 seconds)
    checkFrequencyMin: 3, // Lower bound (minutes). Equal to max → fixed-cadence behavior.
    checkFrequencyMax: 3, // Upper bound (minutes). Each cycle picks a random delay in [min, max].
    // Resilience: retries on transient API failures (network/timeout/429/5xx)
    // with exponential backoff.
    apiMaxRetries: 3, // 0 disables.
    apiRetryBaseDelayMs: 1000, // Base for exponential backoff between retries (ms).
});

export { getUiDefaultSettings, DEFAULT_TIMEZONE, BUILT_IN_TIMEZONES, effectiveTimezone, THEMES };
