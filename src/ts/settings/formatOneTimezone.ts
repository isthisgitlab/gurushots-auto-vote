/**
 * What an empty `timezone` means across the settings format 1 boundary. A format-1 build read `timezone || 'Europe/Riga'`,
 * so `''` meant Riga there; in the configuration an empty value means UTC (`effectiveTimezone`, uiDefaults.ts). The import
 * and the mirror translate, so the same stored zone keeps its meaning on either side.
 */

import { DEFAULT_TIMEZONE } from './uiDefaults';

import type { StoredConfigV2 } from '../types/config';

/** The configuration a format-1 import made, with an empty `timezone` (exactly `''`) as Europe/Riga. Whitespace stays: format 1 took it for an invalid zone. */
const withImportedTimezone = (config: StoredConfigV2): StoredConfigV2 =>
    config.app.timezone === '' ? { ...config, app: { ...config.app, timezone: DEFAULT_TIMEZONE } } : config;

/** The app preferences as the mirror writes them: a blank `timezone` as UTC, which is what the configuration means by it. */
const mirroredTimezone = (app: Record<string, unknown>): Record<string, unknown> =>
    typeof app.timezone === 'string' && app.timezone.trim() === '' ? { ...app, timezone: 'UTC' } : app;

export { withImportedTimezone, mirroredTimezone };
