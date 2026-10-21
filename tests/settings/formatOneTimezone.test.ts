/**
 * What an empty `timezone` means across the settings format 1 boundary: the import reads exactly `''` as Europe/Riga
 * (what format 1 meant by it), the mirror writes a blank one as UTC (what the configuration means by it).
 */

import { mirroredTimezone, withImportedTimezone } from '../../src/ts/settings/formatOneTimezone';

import type { StoredConfigV2 } from '../../src/ts/types/config';

const configWith = (app: Record<string, unknown>): StoredConfigV2 => ({
    version: 2,
    app,
    auth: { token: '', apiHeaders: {}, lastUsername: '' },
    defaults: {},
    profiles: {},
    seededProfiles: [],
    scenarios: {},
    rules: [],
    challenges: {},
});

describe('withImportedTimezone', () => {
    test("turns exactly '' into Europe/Riga, leaving the rest of the configuration as it is", () => {
        const config = configWith({ timezone: '', theme: 'dark' });

        const imported = withImportedTimezone(config);

        expect(imported.app).toEqual({ timezone: 'Europe/Riga', theme: 'dark' });
        expect(imported).toMatchObject({ version: 2, rules: [] });
        expect(config.app.timezone).toBe('');
    });

    test.each([['  '], ['Asia/Tokyo'], ['local'], [undefined]])('leaves %j as it is', (timezone) => {
        const config = configWith({ timezone });

        expect(withImportedTimezone(config)).toBe(config);
    });
});

describe('mirroredTimezone', () => {
    test.each([[''], ['  ']])('writes %j as UTC, leaving the rest as it is', (timezone) => {
        const app = { timezone, theme: 'dark' };

        expect(mirroredTimezone(app)).toEqual({ timezone: 'UTC', theme: 'dark' });
        expect(app.timezone).toBe(timezone);
    });

    test.each([['Asia/Tokyo'], [' Asia/Tokyo '], ['local'], [undefined], [5]])('leaves %j as it is', (timezone) => {
        const app = { timezone };

        expect(mirroredTimezone(app)).toBe(app);
    });
});
