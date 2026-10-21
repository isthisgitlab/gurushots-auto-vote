/**
 * What an empty `timezone` means across the settings format 1 boundary. A format-1 build read `timezone || 'Europe/Riga'`,
 * so `''` meant Riga there; in the configuration an empty value means UTC (`effectiveTimezone`, uiDefaults.ts). The
 * import translates, so the same stored zone keeps its meaning across the boundary.
 */

import { DEFAULT_TIMEZONE } from './uiDefaults';

import type { StoredConfigV2 } from '../types/config';

/** The configuration a format-1 import made, with an empty `timezone` (exactly `''`) as Europe/Riga. Whitespace stays: format 1 took it for an invalid zone. */
const withImportedTimezone = (config: StoredConfigV2): StoredConfigV2 =>
    config.app.timezone === '' ? { ...config, app: { ...config.app, timezone: DEFAULT_TIMEZONE } } : config;

export { withImportedTimezone };
