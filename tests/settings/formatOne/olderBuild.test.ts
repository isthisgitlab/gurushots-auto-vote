/**
 * An older build (the 1.12.2 build on `master`, frozen in tests/helpers/olderBuild) loading the mirror: it stays signed
 * in, it resets none of the top-level values, it migrates nothing, it keeps every key it knows in the global defaults
 * and the per-challenge values, and it prunes exactly the keys it never defined, which the new build writes again at
 * its next save or start.
 */

jest.mock('electron', () => ({}));

import { V1_KEY_RENAMES } from '../../../src/ts/settings/importV1';
import { toFormatOne } from '../../../src/ts/settings/formatOneMirror';
import { MASTER_KEYS, MASTER_MIGRATION_FLAGS, loadLikeMaster } from '../../helpers/olderBuild/master1122';
import { V1_MIGRATION_FLAGS } from '../../../src/ts/settings/importV1/migrations';
import { APP_STATE_KEYS, SCHEMA_KEYS, randomLiveConfig } from '../../helpers/liveConfig';
import { parseJsonObject } from '../../helpers/parseJson';

import type { ConfigV2 } from '../../../src/ts/types/config';

const SEEDS = Array.from({ length: 30 }, (_, index) => index + 1);

const mirrorText = (config: ConfigV2, titlePins: Record<string, string>): string =>
    JSON.stringify(toFormatOne(config, titlePins), null, 2);

const asRecord = (value: unknown): Record<string, unknown> => parseJsonObject(JSON.stringify(value));

// The format-1 key of a live key: the name an older build knows it by.
const formatOneName = (key: string): string =>
    Object.entries(V1_KEY_RENAMES).find(([, current]) => current === key)?.[0] ?? key;

describe('the 1.12.2 build that loads the mirror', () => {
    test('knows the migrations the mirror marks done, and every key it does not know is a live key', () => {
        expect([...MASTER_MIGRATION_FLAGS].sort()).toEqual([...V1_MIGRATION_FLAGS].sort());
        const liveNames = SCHEMA_KEYS.map(formatOneName);
        expect(MASTER_KEYS.filter((key) => !liveNames.includes(key))).toEqual([]);
    });

    test.each(SEEDS.map((seed) => [seed]))(
        'seed %i: stays signed in, resets and migrates nothing, keeps what it knows',
        (seed) => {
            const { config, titlePins } = randomLiveConfig(seed);
            const text = mirrorText(config, titlePins);
            const mirror = parseJsonObject(text);

            const { blob, reset, pruned, dropped, migrations } = loadLikeMaster(text);

            // Still signed in, and every top-level value stays.
            expect(blob.token).toBe(config.auth.token);
            expect(blob.apiHeaders).toEqual(config.auth.apiHeaders);
            expect(blob.lastUsername).toBe(config.auth.lastUsername);
            expect(reset).toEqual([]);
            // Every value the mirror holds is one its own validators accept.
            expect(dropped).toEqual([]);
            expect(migrations).toEqual([]);
            expect(blob.theme).toBe(config.app.theme);
            expect(blob.checkFrequencyMin).toBe(config.app.checkFrequencyMin);

            const before = asRecord(mirror.challengeSettings);
            const after = asRecord(blob.challengeSettings);
            const globalBefore = asRecord(before.globalDefaults);
            const globalAfter = asRecord(after.globalDefaults);
            for (const [key, value] of Object.entries(globalBefore)) {
                if (MASTER_KEYS.includes(key)) expect(globalAfter[key]).toEqual(value);
                else expect(globalAfter).not.toHaveProperty(key);
            }
            const perBefore = asRecord(before.perChallenge);
            const perAfter = asRecord(after.perChallenge);
            for (const [id, values] of Object.entries(perBefore)) {
                const known = Object.entries(asRecord(values)).filter(([key]) => MASTER_KEYS.includes(key));
                if (known.length === 0) expect(perAfter).not.toHaveProperty(id);
                else expect(asRecord(perAfter[id])).toEqual(Object.fromEntries(known));
            }
            // Everything it keeps beside them is as written: rules, profiles, scenarios, pins, suppressions.
            for (const key of [
                'titleRules',
                'titleProfileSuppressions',
                'entryPins',
                'profiles',
                'seededProfiles',
                'scenarios',
                'titlePins',
            ]) {
                expect(after[key]).toEqual(before[key]);
            }
            // What it prunes is only what its schema never had.
            for (const path of pruned) expect(MASTER_KEYS).not.toContain(path.split('.').at(-1));
        },
    );

    test('prunes exactly the settings added after it, of the keys the mirror carries', () => {
        // The keys that sit in the global defaults: all but the app state and the sign-in state.
        const defaultKeys = SCHEMA_KEYS.filter(
            (key) => !APP_STATE_KEYS.includes(key) && key !== 'chosenPhotosMemberId',
        );
        const everyKey = Object.fromEntries(defaultKeys.map((key) => [key, 1]));
        const config = randomLiveConfig(1).config;
        config.defaults = everyKey;
        const text = mirrorText(config, {});

        const { pruned } = loadLikeMaster(text);

        const prunedKeys = pruned
            .filter((path) => path.startsWith('globalDefaults.'))
            .map((path) => path.slice('globalDefaults.'.length));
        const newer = defaultKeys.map(formatOneName).filter((key) => !MASTER_KEYS.includes(key));
        expect(newer.length).toBeGreaterThan(0);
        expect(prunedKeys.sort()).toEqual(newer.sort());
    });

    test('removes a value outside what it accepts, so the default applies, and prunes the map that leaves empty', () => {
        const text = JSON.stringify({
            challengeSettings: {
                globalDefaults: { exposure: 500, boostTime: -1, theme: 'ignored: not a setting', autoFill: true },
                perChallenge: { '1': { exposure: 0 }, '2': { exposure: 90, chosenPhotos: ['p1'] } },
            },
        });

        const { blob, dropped, pruned } = loadLikeMaster(text);

        expect(dropped.sort()).toEqual([
            'globalDefaults.boostTime',
            'globalDefaults.exposure',
            'perChallenge.1.exposure',
        ]);
        const challengeSettings = asRecord(blob.challengeSettings);
        expect(challengeSettings.globalDefaults).toEqual({ autoFill: true });
        expect(challengeSettings.perChallenge).toEqual({ '2': { exposure: 90 } });
        expect(pruned).toEqual(['globalDefaults.theme', 'perChallenge.2.chosenPhotos']);
    });

    test('makes no range check of its own on the top-level numbers the live load bounds', () => {
        const { reset, blob } = loadLikeMaster(
            JSON.stringify({ apiTimeout: -5, apiMaxRetries: 99, checkFrequencyMin: 0 }),
        );

        expect(reset).toEqual([]);
        expect(blob).toMatchObject({ apiTimeout: -5, apiMaxRetries: 99, checkFrequencyMin: 0 });
    });

    test('a mirror that lost a flag would be migrated again: the fixture sees it', () => {
        const { config } = randomLiveConfig(2);
        const mirror = toFormatOne(config, {});
        delete mirror._timeUnitMigratedV1;

        expect(loadLikeMaster(JSON.stringify(mirror)).migrations).toEqual(['_timeUnitMigratedV1']);
    });

    test('resets a top-level value of the wrong type, as it does for any file', () => {
        const { config } = randomLiveConfig(2);
        const mirror = toFormatOne(config, {});
        mirror.theme = 7;

        expect(loadLikeMaster(JSON.stringify(mirror)).reset).toEqual(['theme']);
    });

    test('fills the containers a file lacks, and drops the legacy boostConfig', () => {
        const { blob } = loadLikeMaster(
            JSON.stringify({ boostConfig: {}, challengeSettings: { globalDefaults: [], titleRules: 'x' } }),
        );

        expect(blob).not.toHaveProperty('boostConfig');
        expect(blob.challengeSettings).toMatchObject({
            globalDefaults: {},
            perChallenge: {},
            titleRules: [],
            titleProfileSuppressions: {},
        });
        expect(() => loadLikeMaster('[1]')).toThrow('one JSON object');
    });
});
