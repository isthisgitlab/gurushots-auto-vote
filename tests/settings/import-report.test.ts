/**
 * The import report that follows the import of a `settings.json`, against a real temp directory: its completeness, its
 * acknowledgement and that it stays readable.
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
import type * as storageModule from '../../src/ts/settings/storage';
import type * as loggerModule from '../../src/ts/logger';
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

// A settings.json with a reference of every kind the report lists: a profile that is not stored, a profile that fails
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

describe('after the import of a settings.json (real fs)', () => {
    let root: string;
    let userData: string;
    let configFile: string;
    let legacyFile: string;
    let settings: typeof settingsModule;
    let storage: typeof storageModule;
    let cat: CatDouble;

    // Each test gets its own module graph: the recovery state lives in the settings module.
    const loadFresh = () => {
        jest.isolateModules(() => {
            const actualRuntime = jest.requireActual<typeof runtimeModule>('../../src/ts/runtime');
            jest.doMock('../../src/ts/runtime', () => ({
                __esModule: true,
                ...actualRuntime,
                getAppUserDataPath: () => userData,
            }));
            settings = require('../../src/ts/settings') as typeof settingsModule;
            storage = require('../../src/ts/settings/storage') as typeof storageModule;
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
    };
    const stored = (file: string) => parseJsonObject(fs.readFileSync(file, 'utf8'));

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-report-'));
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
            // The parser's message can quote the stored text: the log says only that it is not JSON.
            expect(cat.error).toHaveBeenCalledWith(
                'Could not update the import record: the stored settings are not valid JSON',
            );

            fs.writeFileSync(configFile, '[]');
            expect(settings.acknowledgeImportReport()).toBe(false);
        });

        test('acknowledging with no marker to keep a copy in still records it in the configuration', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            fs.rmSync(path.join(userData, 'v2-import.json'));

            expect(settings.acknowledgeImportReport()).toBe(true);

            expect(stored(configFile).imported).toMatchObject({ acknowledged: true });
            expect(fs.existsSync(path.join(userData, 'v2-import.json'))).toBe(false);
        });

        test('an acknowledgement the configuration refuses is not recorded in the marker either', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            jest.spyOn(storage.storage, 'writeRaw').mockReturnValue(false);

            expect(settings.acknowledgeImportReport()).toBe(false);

            expect(stored(path.join(userData, 'v2-import.json')).importedRecord).toMatchObject({ acknowledged: false });
        });

        test.each([
            ['an Error', () => new Error('EACCES: denied'), 'EACCES: denied'],
            ['a value that carries no message', () => 'weird', 'unknown error'],
        ])('a record that cannot be written (%s) says why, and answers false', (_name, thrown, said) => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            jest.spyOn(storage.storage, 'writeRaw').mockImplementation(() => {
                throw thrown();
            });

            expect(settings.acknowledgeImportReport()).toBe(false);

            expect(cat.error).toHaveBeenCalledWith(`Could not update the import record: ${said}`);
        });
    });
});
