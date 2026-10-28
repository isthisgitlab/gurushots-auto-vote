/**
 * What an empty `timezone` means across the settings format 1 boundary: the import reads exactly `''` as Europe/Riga
 * (what format 1 meant by it).
 */

import { withImportedTimezone } from '../../src/ts/settings/formatOneTimezone';

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
