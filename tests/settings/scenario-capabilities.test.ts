/**
 * The settings capability catalogue: one row per named configuration key (every schema key plus the app keys that
 * live outside the schema), the phase-overlay gate built on it, and the serialized projection the renderer reads.
 */

import type * as settingsModule from '../../src/ts/core/settings';
import type * as scenarioSchemaModule from '../../src/ts/core/settings/scenarioSchema';
import type {
    ScenarioCapabilityRow,
    ScenarioScope,
    ScenarioValueDescriptor,
    SettingDisposition,
} from '../../src/ts/core/types/settings';

const settings = require('../../src/ts/core/settings') as typeof settingsModule;
const { validateScenario } = require('../../src/ts/core/settings/scenarioSchema') as typeof scenarioSchemaModule;

const { getScenarioCapabilities, scenarioCapability, getDefaultSettings, SETTINGS_SCHEMA } = settings;

const projection = getScenarioCapabilities();
const rows = projection.settings;
const byKey = (key: string): ScenarioCapabilityRow => {
    const row = rows.find((candidate) => candidate.key === key);
    if (!row) throw new Error(`no capability row for ${key}`);
    return row;
};

const writableIn = (scope: ScenarioScope) =>
    rows
        .filter((row) => row.phaseWrite.includes(scope))
        .map((row) => row.key)
        .sort();

const schemaKeys = Object.keys(SETTINGS_SCHEMA);
const extraAppKeys = Object.keys(getDefaultSettings().app);

describe('settings capability catalogue', () => {
    test('covers every schema key and every non-schema app key, and nothing else', () => {
        const capabilityKeys = rows.map((row) => row.key);
        expect(capabilityKeys).toEqual([...schemaKeys, ...extraAppKeys].sort());
        expect(capabilityKeys).toHaveLength(121);
        expect(new Set(capabilityKeys).size).toBe(121);
    });

    test('the 13 app keys outside the schema are exactly the app defaults', () => {
        expect(extraAppKeys).toHaveLength(13);
        expect(schemaKeys).toHaveLength(108);
        expect(extraAppKeys.filter((key) => schemaKeys.includes(key))).toEqual([]);
    });

    test('gives every key one disposition, with the planned class counts', () => {
        const count = (disposition: SettingDisposition) => rows.filter((row) => row.disposition === disposition).length;
        expect(count('challengePolicy')).toBe(79);
        expect(count('accountPolicy')).toBe(12);
        expect(count('appPreference')).toBe(14);
        expect(count('devicePreference')).toBe(6);
        expect(count('lifecycleControl')).toBe(5);
        expect(count('internalState')).toBe(5);
    });

    test('pins the scopes a phase may write for the keys that matter', () => {
        expect(byKey('manualPhotosOnly').phaseWrite).toEqual([]);
        expect(byKey('autoSubmitSchedule').phaseWrite).toEqual(['challenge']);
        expect(byKey('apiTimeout').phaseWrite).toEqual(['installation']);
        expect(byKey('compactCards').phaseWrite).toEqual(['challenge', 'installation']);
        expect(byKey('windowBounds')).toMatchObject({
            disposition: 'devicePreference',
            read: 'projection',
            phaseWrite: [],
            owner: 'window',
        });
    });

    test('names the owner of every lifecycle control and internal state key', () => {
        const owners = Object.fromEntries(
            rows
                .filter((row) => row.disposition === 'lifecycleControl' || row.disposition === 'internalState')
                .map((row) => [row.key, row.owner]),
        );
        expect(owners).toEqual({
            scenario: 'controller',
            manualPhotosOnly: 'controller',
            autovoteStartupDelay: 'controller',
            stayLoggedIn: 'authentication',
            mock: 'controller',
            autovoteRunning: 'controller',
            autovoteStartedLaunch: 'controller',
            skipUpdateVersion: 'updates',
            noticeAcknowledgedVersion: 'updates',
            onboardingCompleted: 'onboarding',
        });
    });

    test('a key with no writable scope carries a reason, and a writable key carries none', () => {
        for (const row of rows) {
            if (row.phaseWrite.length === 0) {
                expect(typeof row.restriction).toBe('string');
                expect(row.restriction).not.toBe('');
            } else {
                expect(row).not.toHaveProperty('restriction');
            }
        }
    });

    test('state keys are read through a projection, every other key by value (window geometry aside)', () => {
        for (const row of rows) {
            expect(row.read).toBe(
                row.disposition === 'internalState' || row.key === 'windowBounds' ? 'projection' : 'value',
            );
        }
    });

    test('a phase may write a key only when its capability says so', () => {
        const old = Object.entries(SETTINGS_SCHEMA)
            .filter(([key, entry]) => entry.perChallenge && key !== 'scenario' && key !== 'manualPhotosOnly')
            .map(([key]) => key)
            .sort();
        const accepted = writableIn('challenge');
        expect(accepted).toEqual(old);
        expect(accepted).toHaveLength(80);
        expect(writableIn('installation')).toHaveLength(31);
    });

    test('looks a key up, and answers undefined for an unknown key or an Object.prototype member', () => {
        expect(scenarioCapability('exposure')).toEqual({
            disposition: 'challengePolicy',
            read: 'value',
            phaseWrite: ['challenge'],
            owner: 'challenge',
            value: { kind: 'number', quantity: 'percent' },
        });
        expect(scenarioCapability('token')).toBeUndefined();
        expect(scenarioCapability('nonsense')).toBeUndefined();
        expect(scenarioCapability('constructor')).toBeUndefined();
        expect(scenarioCapability('__proto__')).toBeUndefined();
    });
});

describe('setting value descriptors', () => {
    const valueOf = (key: string) => byKey(key).value;
    /** The values of an enum descriptor (a mutable view, so a test can try to change the copy it was handed). */
    const enumValues = (value: ScenarioValueDescriptor | undefined): string[] => {
        if (value?.kind !== 'enum') throw new Error('not an enum descriptor');
        return value.values as string[];
    };

    test('every key has one descriptor of a known kind', () => {
        for (const row of rows) {
            expect(['boolean', 'number', 'string', 'enum', 'list', 'other']).toContain(row.value.kind);
        }
    });

    test('a number with a time unit is a duration in that unit; a time setting is a duration in seconds', () => {
        expect(valueOf('voteBeforeBoostLeadMin')).toEqual({ kind: 'number', quantity: 'duration', unit: 'minutes' });
        expect(valueOf('autoJoinAfterHoursFromStart')).toEqual({ kind: 'number', quantity: 'duration', unit: 'hours' });
        expect(valueOf('discoverUpcomingHours')).toEqual({ kind: 'number', quantity: 'duration', unit: 'hours' });
        expect(valueOf('autovoteStartupDelay')).toEqual({ kind: 'number', quantity: 'duration', unit: 'seconds' });
        expect(valueOf('boostTime')).toEqual({ kind: 'number', quantity: 'duration', unit: 'seconds' });
        expect(valueOf('finalWindowDuration')).toEqual({ kind: 'number', quantity: 'duration', unit: 'seconds' });
        const timeKeys = Object.entries(SETTINGS_SCHEMA)
            .filter(([, entry]) => (entry as { type?: string }).type === 'time')
            .map(([key]) => key);
        expect(timeKeys.length).toBeGreaterThan(0);
        for (const key of timeKeys)
            expect(valueOf(key)).toEqual({ kind: 'number', quantity: 'duration', unit: 'seconds' });
    });

    test('the unit of a number names its quantity', () => {
        expect(valueOf('exposure')).toEqual({ kind: 'number', quantity: 'percent' });
        expect(valueOf('autoSwapMaxVotes')).toEqual({ kind: 'number', quantity: 'votes' });
        expect(valueOf('autoSwapMax')).toEqual({ kind: 'number', quantity: 'swaps' });
        expect(valueOf('autoExposureFillMax')).toEqual({ kind: 'number', quantity: 'fills' });
        expect(valueOf('currencyReserveKeys')).toEqual({ kind: 'number', quantity: 'keys' });
        expect(valueOf('autoJoinMaxCoins')).toEqual({ kind: 'number', quantity: 'coins' });
        expect(valueOf('boostImageIndex')).toEqual({ kind: 'number', quantity: 'count' });
        expect(valueOf('noticeAcknowledgedVersion')).toEqual({ kind: 'number', quantity: 'count' });
    });

    test('keeps each setting zero sentinel: nothing about a descriptor changes the stored value', () => {
        expect(valueOf('exposureTarget')).toEqual({ kind: 'number', quantity: 'percent' });
        expect(valueOf('keyUnlockedBoostTime')).toEqual({ kind: 'number', quantity: 'duration', unit: 'seconds' });
    });

    test('booleans, strings, lists and the theme enum', () => {
        expect(valueOf('autoBoost')).toEqual({ kind: 'boolean' });
        expect(valueOf('mock')).toEqual({ kind: 'boolean' });
        expect(valueOf('autoJoinTypes')).toEqual({ kind: 'string' });
        expect(valueOf('scenario')).toEqual({ kind: 'string' });
        expect(valueOf('timezone')).toEqual({ kind: 'string' });
        expect(valueOf('language')).toEqual({ kind: 'string' });
        expect(valueOf('mustIncludeTags')).toEqual({ kind: 'list' });
        expect(valueOf('scheduledFillTime')).toEqual({ kind: 'list' });
        expect(valueOf('customTimezones')).toEqual({ kind: 'list' });
        expect(valueOf('theme')).toMatchObject({ kind: 'enum' });
        expect(enumValues(valueOf('theme'))).toContain('dark');
    });

    test('app keys outside the schema', () => {
        expect(valueOf('apiTimeout')).toEqual({ kind: 'number', quantity: 'duration', unit: 'seconds' });
        expect(valueOf('checkFrequencyMin')).toEqual({ kind: 'number', quantity: 'duration', unit: 'minutes' });
        expect(valueOf('checkFrequencyMax')).toEqual({ kind: 'number', quantity: 'duration', unit: 'minutes' });
        expect(valueOf('apiMaxRetries')).toEqual({ kind: 'number', quantity: 'count' });
    });

    test('values with no expression form are other: structured lists, photos, window geometry, milliseconds', () => {
        for (const key of [
            'autoSubmitSchedule',
            'chosenPhotos',
            'scheduledFillBeforeEnd',
            'windowBounds',
            'apiRetryBaseDelayMs',
            'autovoteStartedLaunch',
        ]) {
            expect(valueOf(key)).toEqual({ kind: 'other' });
        }
    });

    test('the descriptor of a looked-up key is the one the projection lists', () => {
        for (const row of rows) expect(scenarioCapability(row.key)?.value).toEqual(row.value);
    });

    test('hands out copies of an enum list too', () => {
        enumValues(valueOf('theme')).push('mutated');
        const fresh = getScenarioCapabilities().settings.find((row) => row.key === 'theme')?.value;
        expect(enumValues(fresh)).not.toContain('mutated');
        expect(enumValues(scenarioCapability('theme')?.value)).not.toContain('mutated');
    });
});

describe('capability projection', () => {
    test('is plain data that survives a JSON round trip unchanged', () => {
        expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
        expect(JSON.stringify(JSON.parse(JSON.stringify(projection)))).toBe(JSON.stringify(projection));
    });

    test('lists rows sorted by key and keeps remote access in its own field', () => {
        const keys = rows.map((row) => row.key);
        expect(keys).toEqual([...keys].sort());
        expect(keys).not.toContain('remoteEnabled');
        expect(Object.keys(projection).sort()).toEqual(['remoteEnabled', 'settings']);
        expect(projection.remoteEnabled).toEqual({
            disposition: 'lifecycleControl',
            read: 'projection',
            phaseWrite: [],
            owner: 'controller',
            restriction: 'Only the user enables remote access or rotates its key',
            value: { kind: 'other' },
        });
    });

    test('carries no key material', () => {
        const text = JSON.stringify(projection).toLowerCase();
        for (const word of ['token', 'secret', 'password', 'pairing', 'apiheaders']) expect(text).not.toContain(word);
        expect(Object.keys(projection.remoteEnabled).sort()).toEqual([
            'disposition',
            'owner',
            'phaseWrite',
            'read',
            'restriction',
            'value',
        ]);
    });

    test('hands out copies, so a caller cannot change the catalogue', () => {
        Array.prototype.push.call(byKey('exposure').phaseWrite, 'installation');
        expect(getScenarioCapabilities().settings.find((row) => row.key === 'exposure')?.phaseWrite).toEqual([
            'challenge',
        ]);
        expect(scenarioCapability('exposure')?.phaseWrite).toEqual(['challenge']);
    });
});

describe('phase overlay gate', () => {
    const issuesFor = (phaseSettings: Record<string, unknown>) => {
        const result = validateScenario(
            {
                name: 'Plan',
                version: 1,
                start: 'main',
                phases: { main: { settings: phaseSettings, rules: [{ do: [{ type: 'fillExposure' }] }] } },
            },
            {},
        );
        return result.ok ? [] : result.issues;
    };

    test('refuses a restricted key with its own reason', () => {
        expect(issuesFor({ scenario: 'x' })).toEqual([
            { path: 'phases.main.settings.scenario', message: 'A phase cannot change the scenario assignment itself' },
        ]);
        expect(issuesFor({ manualPhotosOnly: false })).toEqual([
            { path: 'phases.main.settings.manualPhotosOnly', message: 'A phase cannot change Manual Only' },
        ]);
        expect(scenarioCapability('scenario')?.restriction).toBe(
            'A phase cannot change the scenario assignment itself',
        );
        expect(scenarioCapability('manualPhotosOnly')?.restriction).toBe('A phase cannot change Manual Only');
    });

    test('refuses any other key a phase cannot write, and any unknown key, as not per-challenge', () => {
        for (const key of [
            'apiTimeout',
            'currencyReserveSwaps',
            'stayLoggedIn',
            'autovoteRunning',
            'windowBounds',
            'nonsense',
        ]) {
            expect(issuesFor({ [key]: 1 })).toEqual([
                { path: `phases.main.settings.${key}`, message: 'Not a per-challenge setting' },
            ]);
        }
    });

    test('accepts a key whose capability allows a challenge write', () => {
        expect(issuesFor({ autoSubmit: false })).toEqual([]);
        expect(issuesFor({ compactCards: true })).toEqual([]);
    });
});
