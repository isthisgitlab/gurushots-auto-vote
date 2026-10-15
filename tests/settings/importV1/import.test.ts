/**
 * importV1Settings end to end: settings text in, the 2.x configuration (or the reason there is none) out, in memory
 * only.
 */

import * as logger from '../../../src/ts/logger';
import { V1_KEY_RENAMES, importV1Settings, renameV1ScenarioDocument } from '../../../src/ts/settings/importV1';
import { getV1Defaults } from '../../../src/ts/settings/importV1/defaults';
import { renameV1Keys } from '../../../src/ts/settings/importV1/renames';
import { TOP_LEVEL_ONLY_KEYS } from '../../../src/ts/settings/importV1/convert';
import { invalid } from '../../helpers/invalid';

type Result = ReturnType<typeof importV1Settings>;

const okOf = (result: Result) => {
    if (!result.ok) throw new Error(`import failed: ${result.code}: ${result.detail}`);
    return result;
};

describe('importV1Settings', () => {
    test('re-exports the rename table and the scenario renamer', () => {
        expect(V1_KEY_RENAMES.autoFill).toBe('autoSubmit');
        expect(renameV1ScenarioDocument(5)).toBe(5);
    });

    test('converts a settings file', () => {
        const result = okOf(
            importV1Settings(
                JSON.stringify({
                    theme: 'dark',
                    token: 'secret',
                    lastUsername: 'me',
                    challengeSettings: {
                        globalDefaults: { autoFill: true, exposure: 80 },
                        perChallenge: { '1': { emergencyFill: 600 } },
                        titleRules: [{ title: 'Macro', profile: 'Gone', autoFill: true }],
                        titlePins: { '1': 'Macro' },
                        entryPins: { '1': { boost: 'e1' } },
                        titleProfileSuppressions: { '1': true },
                    },
                }),
            ),
        );
        expect(result.config.app.theme).toBe('dark');
        expect(result.config.auth).toMatchObject({ token: 'secret', lastUsername: 'me' });
        expect(result.config.defaults).toMatchObject({ autoSubmit: true, exposure: 80 });
        expect(result.config.rules).toEqual([{ title: 'Macro', profile: 'Gone', autoSubmit: true }]);
        expect(result.config.challenges).toEqual({
            '1': { values: { emergencySubmit: 600 }, suppressRuleProfile: true, pins: { boost: 'e1' } },
        });
        expect(result.titlePins).toEqual({ '1': 'Macro' });
        expect(result.report).toEqual({ refsBlocked: ['rules[0].profile: "Gone"'] });
    });

    test('an empty object is the defaults', () => {
        const result = okOf(importV1Settings('{}'));
        const resolvable = Object.fromEntries(
            Object.entries(getV1Defaults().challengeSettings.globalDefaults).filter(
                ([key]) => !TOP_LEVEL_ONLY_KEYS.has(key),
            ),
        );
        expect(result.config.defaults).toEqual(renameV1Keys(resolvable, 'drop-targets'));
        expect(result.config.challenges).toEqual({});
        expect(result.config.rules).toEqual([]);
        expect(result.report.refsBlocked).toEqual([]);
    });

    test('carries the mock mode only when the file held a valid one', () => {
        expect(okOf(importV1Settings('{"mock":true}')).config.app.mock).toBe(true);
        expect(okOf(importV1Settings('{"mock":false}')).config.app.mock).toBe(false);
        expect(okOf(importV1Settings('{}')).config.app).not.toHaveProperty('mock');
        // A value of the wrong type was replaced by the build default when 1.x loaded it: nothing to carry.
        expect(okOf(importV1Settings('{"mock":"yes"}')).config.app).not.toHaveProperty('mock');
    });

    test('migrates and prunes in memory: legacy input is converted, obsolete keys are gone', () => {
        const result = okOf(
            importV1Settings(
                JSON.stringify({
                    boostConfig: { old: 1 },
                    challengeSettings: {
                        globalDefaults: { boostTime: 60, mystery: 1 },
                        perChallenge: { '1': { mystery: 2 } },
                        categoryRules: [{ pics: 2 }],
                    },
                }),
            ),
        );
        expect(result.config.defaults.boostTime).toBe(3600);
        expect(result.config.defaults).not.toHaveProperty('mystery');
        expect(result.config.app).not.toHaveProperty('boostConfig');
        expect(result.config.challenges).toEqual({});
        expect(result.config.rules).toEqual([{ title: '', mustIncludeTags: [], shouldIncludeTags: [], pics: 2 }]);
    });

    test('does not change its input text and is repeatable', () => {
        const raw = JSON.stringify({ challengeSettings: { globalDefaults: { autoFill: true } } });
        expect(importV1Settings(raw)).toEqual(importV1Settings(raw));
    });

    test('values dropped by the load validation are logged once, as a warning; a clean file logs nothing', () => {
        const warning = jest.fn<void, [string]>();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning }));
        importV1Settings(JSON.stringify({ theme: 7, challengeSettings: { globalDefaults: { exposure: 500 } } }));
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning.mock.calls[0][0]).toContain('theme, challengeSettings.globalDefaults.exposure');
        jest.clearAllMocks();
        importV1Settings('{}');
        expect(logger.withCategory).not.toHaveBeenCalled();
    });

    test.each([
        ['text that is not JSON', 'not json {', /^it is not valid JSON \(/],
        ['an empty text', '', /^it is not valid JSON \(/],
        ['an array root', '[1]', /^its root is not an object$/],
        ['a string root', '"x"', /^its root is not an object$/],
        ['a null root', 'null', /^its root is not an object$/],
    ])('%s is corrupt', (_name, raw, detail) => {
        const result = importV1Settings(raw);
        expect(result).toEqual({ ok: false, code: 'corrupt', detail: expect.stringMatching(detail) });
    });

    test('a file a migration cannot handle fails as migration-failed, with the reason', () => {
        const result = importV1Settings(JSON.stringify({ challengeSettings: { perChallenge: { '1': null } } }));
        expect(result).toEqual({ ok: false, code: 'migration-failed', detail: expect.stringContaining('null') });
    });

    test('a thrown value that carries no message is reported as unknown', () => {
        const hostile = {
            get challengeSettings(): never {
                throw 'boom';
            },
        };
        const spy = jest.spyOn(JSON, 'parse').mockReturnValueOnce(hostile);
        try {
            expect(importV1Settings('{}')).toEqual({ ok: false, code: 'migration-failed', detail: 'unknown error' });
        } finally {
            spy.mockRestore();
        }
    });
});
