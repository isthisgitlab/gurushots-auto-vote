/**
 * What follows the one-time import of a 1.x `settings.json`, against a real temp directory: the hash of the file the
 * configuration was imported from and the check that compares it at the next start (a changed file raises a notice that
 * never blocks saves; re-import or keeping the settings clears it), and the import report (its completeness, its
 * acknowledgement and that it stays readable).
 */

jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
        __cat: cat,
    };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as runtimeModule from '../../src/ts/runtime';
import type * as settingsModule from '../../src/ts/settings';
import type * as loggerModule from '../../src/ts/logger';
import type * as importedRecordModule from '../../src/ts/settings/importedRecord';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import { parseJsonObject } from '../helpers/parseJson';

type CatDouble = jest.Mocked<Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'>>;

const ONE_X = {
    theme: 'dark',
    token: 'tok-secret',
    apiHeaders: { 'x-a': 'b' },
    lastUsername: 'me@example.com',
    chosenPhotosMemberId: 'm-1',
    challengeSettings: {
        globalDefaults: { exposure: 80 },
        titleRules: [{ title: 'Macro', profile: 'Gone' }],
    },
};
const RAW = `${JSON.stringify(ONE_X, null, 2)}\n`;

// A 1.x file with a reference of every kind the report lists: a profile that is not stored, a profile that fails
// whole-set validation, and a scenario that is not stored or is stored without being valid, in each layer.
const REFS = {
    challengeSettings: {
        profiles: {
            Nulls: { exposure: 60, exposureTarget: null },
            Armed: { scenario: 'Broken' },
        },
        titleRules: [
            { title: 'Night Sky', profile: 'Nulls', scenario: 'Broken' },
            { title: 'Street Life', profile: 'Ghost' },
            { title: 'Plain', profile: 'Armed' },
        ],
        perChallenge: { '101': { scenario: 'Broken' }, 'a b': { scenario: 'broken' }, '102': { scenario: 'Ghost' } },
        scenarios: { Broken: { name: 'Broken' } },
    },
};

describe('after the 1.x import (real fs)', () => {
    let root: string;
    let userData: string;
    let configFile: string;
    let legacyFile: string;
    let settings: typeof settingsModule;
    let cat: CatDouble;

    // Each test gets its own module graph: the recovery and drift state live in the settings module.
    const loadFresh = () => {
        jest.isolateModules(() => {
            const actualRuntime = jest.requireActual<typeof runtimeModule>('../../src/ts/runtime');
            jest.doMock('../../src/ts/runtime', () => ({
                __esModule: true,
                ...actualRuntime,
                getAppUserDataPath: () => userData,
            }));
            settings = require('../../src/ts/settings') as typeof settingsModule;
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
    };
    const stored = (file: string) => parseJsonObject(fs.readFileSync(file, 'utf8'));
    const storedHash = () => {
        const { imported } = stored(configFile);
        return typeof imported === 'object' && imported !== null && 'sha256' in imported ? imported.sha256 : undefined;
    };
    // The hash is filled once the digest settles, after the load that imported.
    const hashFilled = async () => {
        for (let attempt = 0; attempt < 200 && storedHash() === ''; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return storedHash();
    };
    // What a later start sees: a new process over the same directory.
    const restart = () => loadFresh();

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-drift-'));
        userData = path.join(root, 'userData');
        fs.mkdirSync(userData);
        configFile = path.join(userData, 'config.json');
        legacyFile = path.join(userData, 'settings.json');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.dontMock('../../src/ts/runtime');
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('the hash of the imported file', () => {
        test('is recorded once the import is stored, and is the same whatever the sign-in state or formatting', async () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();

            const hash = await hashFilled();

            expect(hash).toMatch(/^[0-9a-f]{64}$/);
            // The blanking of the sign-in state, a reformat and a different key order leave it as it was.
            const { canonicalLegacyHash } =
                require('../../src/ts/settings/importedRecord') as typeof importedRecordModule;
            const reordered = JSON.stringify({
                challengeSettings: { titleRules: ONE_X.challengeSettings.titleRules, globalDefaults: { exposure: 80 } },
                theme: 'dark',
                token: 'another',
                lastUsername: 'x',
            });
            await expect(canonicalLegacyHash(reordered)).resolves.toBe(hash);
            await expect(canonicalLegacyHash(fs.readFileSync(legacyFile, 'utf8'))).resolves.toBe(hash);
            await expect(canonicalLegacyHash(JSON.stringify({ ...ONE_X, theme: 'light' }))).resolves.not.toBe(hash);
        });

        test('reads arrays, nested objects and every kind of value in a stable order', async () => {
            loadFresh();
            const { canonicalLegacyHash } =
                require('../../src/ts/settings/importedRecord') as typeof importedRecordModule;
            const one = await canonicalLegacyHash('{"b":[1,{"y":null,"x":true}],"a":"s","n":1.5}');
            const two = await canonicalLegacyHash('{"n":1.5,"a":"s","b":[1,{"x":true,"y":null}]}');
            expect(one).toBe(two);
            await expect(canonicalLegacyHash('{"b":[{"x":true,"y":null},1],"a":"s","n":1.5}')).resolves.not.toBe(one);
        });

        test.each([
            ['text that is not JSON', 'nope{'],
            ['JSON that is not an object', '[1]'],
        ])('of %s is null', async (_name, raw) => {
            loadFresh();
            const { canonicalLegacyHash } =
                require('../../src/ts/settings/importedRecord') as typeof importedRecordModule;
            await expect(canonicalLegacyHash(raw)).resolves.toBeNull();
        });

        test('recording the hash of text that is no JSON object, or twice, changes nothing', async () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            const hash = await hashFilled();
            const { recordImportHash } = require('../../src/ts/settings/importedRecord') as typeof importedRecordModule;

            await recordImportHash('nope{');
            await recordImportHash(JSON.stringify({ theme: 'light' }));

            expect(storedHash()).toBe(hash);
        });

        test('a digest that fails leaves the record without it and says so', async () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            jest.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('no subtle'));

            settings.loadSettings();
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(storedHash()).toBe('');
            expect(cat.error).toHaveBeenCalledWith('Could not record the hash of settings.json:', 'no subtle');
        });
    });

    describe('the check at start', () => {
        const importThenRestart = async (raw = RAW) => {
            fs.writeFileSync(legacyFile, raw);
            loadFresh();
            settings.loadSettings();
            await hashFilled();
            restart();
        };

        test('an unchanged settings.json raises nothing', async () => {
            await importThenRestart();

            await settings.checkLegacyDrift();

            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test('the blanking of the sign-in state is no change, and neither is a 1.x login after a downgrade', async () => {
            await importThenRestart();
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, token: 'logged-in-by-1x', lastUsername: 'u' }));

            await settings.checkLegacyDrift();

            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test('a settings.json edited after the import raises a notice that does not block saves', async () => {
            await importThenRestart();
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light' }));

            await settings.checkLegacyDrift();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-v1-changed',
                path: legacyFile,
                blocking: false,
            });
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            expect(settings.getSetting('theme')).toBe('dark');
        });

        test('a damaged config.json keeps its own notice ahead of it', async () => {
            await importThenRestart();
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light' }));
            await settings.checkLegacyDrift();
            fs.writeFileSync(configFile, '{broken');

            settings.loadSettings();

            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
        });

        test.each([
            ['missing', () => fs.rmSync(legacyFile)],
            ['not JSON', () => fs.writeFileSync(legacyFile, 'nope{')],
            ['not an object', () => fs.writeFileSync(legacyFile, '[1]')],
        ])('a settings.json that is now %s is no drift', async (_name, change) => {
            await importThenRestart();
            change();

            await settings.checkLegacyDrift();

            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test('a record without a hash takes the hash of the file as it is, silently', async () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            await hashFilled();
            const config = stored(configFile);
            fs.writeFileSync(
                configFile,
                JSON.stringify({
                    ...config,
                    imported: { ...parseJsonObject(JSON.stringify(config.imported)), sha256: '' },
                }),
            );
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light' }));
            restart();

            await settings.checkLegacyDrift();

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(storedHash()).toMatch(/^[0-9a-f]{64}$/);
            restart();
            await settings.checkLegacyDrift();
            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test('nothing to compare with when the settings were not imported from a file', async () => {
            loadFresh();

            await settings.checkLegacyDrift();

            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test('nothing is compared while the import failed', async () => {
            fs.writeFileSync(legacyFile, 'nope{');
            loadFresh();

            await settings.checkLegacyDrift();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-failed', blocking: true });
        });

        test('a check that cannot run says so and raises nothing', async () => {
            await importThenRestart();
            jest.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('no subtle'));

            await expect(settings.checkLegacyDrift()).resolves.toBeUndefined();

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(cat.error).toHaveBeenCalledWith(
                'Could not compare settings.json with the import:',
                expect.objectContaining({ message: 'no subtle' }),
            );
        });

        test('a notice is not carried to the next check when the file is back as it was', async () => {
            await importThenRestart();
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light' }));
            await settings.checkLegacyDrift();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-v1-changed');

            fs.writeFileSync(legacyFile, RAW);
            await settings.checkLegacyDrift();

            expect(settings.getSettingsRecovery()).toBeNull();
        });
    });

    describe('clearing the notice', () => {
        const drifted = async () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            await hashFilled();
            restart();
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light' }));
            await settings.checkLegacyDrift();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-v1-changed');
        };

        test('keepCurrentConfig records the file as it is: the notice goes, and the next start finds no drift', async () => {
            await drifted();

            await expect(settings.keepCurrentConfig()).resolves.toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            restart();
            await settings.checkLegacyDrift();
            expect(settings.getSettingsRecovery()).toBeNull();
            // Changed once more: offered again.
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'dark', language: 'lv' }));
            await settings.checkLegacyDrift();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-v1-changed');
        });

        test('keepCurrentConfig keeps every other setting as it is', async () => {
            await drifted();
            settings.setSetting('theme', 'light');

            await settings.keepCurrentConfig();

            expect(settings.getSetting('theme')).toBe('light');
        });

        test('keepCurrentConfig with no settings.json left only clears the notice', async () => {
            await drifted();
            fs.rmSync(legacyFile);

            await expect(settings.keepCurrentConfig()).resolves.toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test('keepCurrentConfig answers false when the record cannot be written, and the notice stays', async () => {
            await drifted();
            const withoutRecord = Object.fromEntries(
                Object.entries(stored(configFile)).filter(([key]) => key !== 'imported'),
            );
            fs.writeFileSync(configFile, JSON.stringify(withoutRecord));

            await expect(settings.keepCurrentConfig()).resolves.toBe(false);

            expect(settings.getSettingsRecovery()?.code).toBe('settings-v1-changed');
        });

        test('keepCurrentConfig answers false when the hash cannot be computed', async () => {
            await drifted();
            jest.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('no subtle'));

            await expect(settings.keepCurrentConfig()).resolves.toBe(false);

            expect(cat.error).toHaveBeenCalledWith(
                'Could not record the current settings.json:',
                expect.objectContaining({ message: 'no subtle' }),
            );
            expect(settings.getSettingsRecovery()?.code).toBe('settings-v1-changed');
        });

        test('importing again clears it, with a new hash for the new import', async () => {
            await drifted();
            const before = storedHash();

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.getSetting('theme')).toBe('light');
            expect(await hashFilled()).toMatch(/^[0-9a-f]{64}$/);
            expect(storedHash()).not.toBe(before);
            restart();
            await settings.checkLegacyDrift();
            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test('a re-import that fails leaves the notice', async () => {
            await drifted();
            fs.writeFileSync(legacyFile, 'nope{');

            expect(settings.reimportFromV1()).toBe(false);

            expect(settings.getSettingsRecovery()?.code).toBe('settings-v1-changed');
        });
    });

    describe('the import report', () => {
        test('is null while the settings were not imported from a file', () => {
            loadFresh();

            expect(settings.getImportReport()).toBeNull();
            expect(settings.acknowledgeImportReport()).toBe(false);
        });

        test('lists the references that are missing and the ones the live settings refuse, names only', () => {
            fs.writeFileSync(legacyFile, `${JSON.stringify(REFS)}\n`);
            loadFresh();

            const report = settings.getImportReport();

            expect(report).toEqual({ at: expect.any(String), refsBlocked: expect.any(Array), acknowledged: false });
            expect(report?.refsBlocked).toEqual([
                // what the importer finds: names that are not stored
                'rules[0].profile: "Ghost"',
                'challenges.102.values.scenario: "Ghost"',
                // what the live validators refuse: a profile that fails whole-set validation, and stored scenarios that are not valid
                'profiles["Armed"].scenario: "Broken"',
                'rules[1].scenario: "Broken"',
                'rules[1].profile: "Nulls"',
                'challenges.101.values.scenario: "Broken"',
                'challenges["a b"].values.scenario: "broken"',
            ]);
            // The document is stored as listed, and nothing of the values is in it.
            expect(JSON.stringify(stored(configFile).imported)).not.toContain('exposureTarget');
        });

        test('is empty when every reference resolves', () => {
            fs.writeFileSync(
                legacyFile,
                RAW.replace('"Gone"', '"Day"').replace(
                    '"titleRules"',
                    '"profiles": {"Day": {"exposure": 70}}, "titleRules"',
                ),
            );
            loadFresh();

            expect(settings.getImportReport()?.refsBlocked).toEqual([]);
        });

        test('stays readable once acknowledged, and acknowledging again is fine', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();

            expect(settings.acknowledgeImportReport()).toBe(true);
            expect(settings.getImportReport()).toEqual({
                at: expect.any(String),
                refsBlocked: ['rules[0].profile: "Gone"'],
                acknowledged: true,
            });
            expect(settings.acknowledgeImportReport()).toBe(true);
            expect(stored(configFile)).toMatchObject({ imported: { acknowledged: true } });
            // The acknowledgement is one write: the rest of the configuration is as stored.
            expect(settings.getSetting('theme')).toBe('dark');
        });

        test('an acknowledgement that cannot be read or written says so and answers false', () => {
            fs.writeFileSync(configFile, 'nope{');
            loadFresh();

            expect(settings.acknowledgeImportReport()).toBe(false);
            expect(cat.error).toHaveBeenCalledWith('Could not update the import record:', expect.any(String));

            fs.writeFileSync(configFile, '[]');
            expect(settings.acknowledgeImportReport()).toBe(false);
        });
    });
});
