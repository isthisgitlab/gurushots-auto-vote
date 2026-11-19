/**
 * The effective projections of the installation's settings and their events (services/effectiveEvents.ts): what each carries
 * (and never carries), where a value comes from, the monotonic revision, an event only for what changed, and a failure that
 * never fails the change that caused it.
 */

jest.mock('../../src/ts/core/settings', () => ({
    getScenarioCapabilities: jest.fn(),
    getScenarioBaseSettings: jest.fn(),
    readInstallationSetting: jest.fn(),
    installationGeneration: jest.fn(),
}));
jest.mock('../../src/ts/core/logger', () => ({
    withCategory: jest.fn(() => ({ warning: mockWarning })),
}));

const mockWarning = jest.fn();

import { installTestPlatform } from '../helpers/platform';
import { invalid } from '../helpers/invalid';

import type { PlatformWindows } from '../../src/ts/core/platform/port';
import type * as effectiveEventsModule from '../../src/ts/core/services/effectiveEvents';

import settingsModule = require('../../src/ts/core/settings');
const settings = jest.mocked(settingsModule);

type Known = {
    state: 'known';
    value: { kind: 'string'; value: string } | { kind: 'number'; value: number; quantity: 'count' };
};
const text = (value: string): Known => ({ state: 'known', value: { kind: 'string', value } });
const count = (value: number): Known => ({ state: 'known', value: { kind: 'number', value, quantity: 'count' } });

const ROWS = [
    { key: 'theme', read: 'value', phaseWrite: ['installation'] },
    { key: 'language', read: 'value', phaseWrite: ['installation'] },
    { key: 'apiMaxRetries', read: 'value', phaseWrite: ['installation'] },
    { key: 'boostTime', read: 'value', phaseWrite: ['challenge'] },
    { key: 'windowBounds', read: 'projection', phaseWrite: ['installation'] },
];

/** What the settings facade answers now: the saved values and the effective ones, by key. */
let saved: Record<string, unknown> = {};
let effective: Record<string, unknown> = {};

const load = () => {
    let module: typeof effectiveEventsModule | undefined;
    jest.isolateModules(() => {
        module = require('../../src/ts/core/services/effectiveEvents') as typeof effectiveEventsModule;
    });
    return module as typeof effectiveEventsModule;
};

let broadcast: jest.Mock<void, [string, unknown]>;

beforeEach(() => {
    jest.clearAllMocks();
    saved = { theme: text('light'), language: text('en'), apiMaxRetries: count(3) };
    effective = { ...saved };
    settings.getScenarioCapabilities.mockReturnValue(invalid({ settings: ROWS }));
    settings.getScenarioBaseSettings.mockImplementation(() => invalid(saved));
    settings.readInstallationSetting.mockImplementation((key) => invalid(effective[key]));
    settings.installationGeneration.mockReturnValue(2);
    broadcast = jest.fn<void, [string, unknown]>();
    const windows: PlatformWindows = {
        broadcastSettingsChanged: jest.fn(),
        broadcastEvent: broadcast,
        afterWipe: jest.fn(),
    };
    installTestPlatform({ windows });
});

describe('the complete projection', () => {
    test('has every installation-owned key readable as a value, with its source, and nothing else', () => {
        const { readEffective } = load();
        const { settings: projection } = readEffective();
        expect(Object.keys(projection.values).sort()).toEqual(['apiMaxRetries', 'language', 'theme']);
        expect(projection).toMatchObject({
            subject: 'installation',
            generation: 2,
            values: { theme: { available: true, source: 'saved', value: text('light').value } },
        });
        expect(Object.keys(projection).sort()).toEqual(['generation', 'revision', 'subject', 'values']);
    });

    test('a value the published phase changed is from the scenario; one it leaves is from the saved settings', () => {
        effective = { ...saved, theme: text('dark') };
        const { readEffective } = load();
        const { values } = readEffective().settings;
        expect(values.theme).toMatchObject({ available: true, source: 'scenario', value: text('dark').value });
        expect(values.language).toMatchObject({ source: 'saved' });
    });

    test('a value whose saved form cannot be read is from the scenario', () => {
        saved = { ...saved, theme: { state: 'unknown', reason: 'x', dependencies: [] } };
        const { readEffective } = load();
        expect(readEffective().settings.values.theme).toMatchObject({ available: true, source: 'scenario' });
    });

    test('a value that cannot be read is unavailable, with the reason, never the saved value', () => {
        effective = {
            ...saved,
            language: { state: 'unknown', reason: 'no-publication', dependencies: [] },
            apiMaxRetries: { state: 'absent', reason: 'not-present' },
        };
        const { readEffective } = load();
        const { values } = readEffective().settings;
        expect(values.language).toEqual({ available: false, reason: 'no-publication' });
        expect(values.apiMaxRetries).toEqual({ available: false, reason: 'not-present' });
    });

    test('carries no token, header or key: only the keys the catalogue lets a phase write', () => {
        settings.getScenarioCapabilities.mockReturnValue(
            invalid({
                settings: [
                    ...ROWS,
                    { key: 'token', read: 'value', phaseWrite: [] },
                    { key: 'apiHeaders', read: 'value', phaseWrite: [] },
                ],
            }),
        );
        const { readEffective } = load();
        const text = JSON.stringify(readEffective());
        for (const word of ['token', 'apiHeaders', 'pairing', 'secret', 'auth']) expect(text).not.toContain(word);
    });
});

describe('the presentation projection', () => {
    test('is the theme, the language, availability and the revision, and nothing else', () => {
        const { readEffective } = load();
        const { presentation } = readEffective();
        expect(presentation).toEqual({
            revision: expect.any(Number),
            available: true,
            theme: 'light',
            language: 'en',
            reason: null,
        });
        expect(Object.keys(presentation).sort()).toEqual(['available', 'language', 'reason', 'revision', 'theme']);
    });

    test('says which of the two cannot be read, and gives the other', () => {
        effective = { ...saved, theme: { state: 'unknown', reason: 'no-publication', dependencies: [] } };
        const { readEffective } = load();
        expect(readEffective().presentation).toMatchObject({
            available: false,
            theme: null,
            language: 'en',
            reason: 'no-publication',
        });
        effective = { ...saved, language: { state: 'unknown', reason: 'expired', dependencies: [] } };
        expect(readEffective().presentation).toMatchObject({
            available: false,
            theme: 'light',
            language: null,
            reason: 'expired',
        });
    });

    test('a key the catalogue does not give, or one that is not a string, is unavailable', () => {
        settings.getScenarioCapabilities.mockReturnValue(invalid({ settings: [ROWS[2]] }));
        const { readEffective } = load();
        expect(readEffective().presentation).toMatchObject({
            available: false,
            theme: null,
            language: null,
            reason: 'theme-unavailable',
        });
        settings.getScenarioCapabilities.mockReturnValue(invalid({ settings: ROWS }));
        effective = { ...saved, theme: count(1) };
        const again = load();
        expect(again.readEffective().presentation).toMatchObject({
            available: false,
            theme: null,
            reason: 'theme-unavailable',
        });
    });
});

describe('announcing a change', () => {
    test('the first work-out tells both projections, with one revision', () => {
        const { announceEffectiveChange } = load();
        announceEffectiveChange();
        expect(broadcast.mock.calls.map(([channel]) => channel)).toEqual([
            'effective-settings-changed',
            'effective-presentation-changed',
        ]);
        const [[, settingsPayload], [, presentationPayload]] = broadcast.mock.calls;
        expect((settingsPayload as { revision: number }).revision).toBe(
            (presentationPayload as { revision: number }).revision,
        );
    });

    test('nothing that changed nothing is told again, and the revision stays', () => {
        const { announceEffectiveChange, readEffective } = load();
        announceEffectiveChange();
        const before = readEffective().settings.revision;
        broadcast.mockClear();
        announceEffectiveChange();
        announceEffectiveChange();
        expect(broadcast).not.toHaveBeenCalled();
        expect(readEffective().settings.revision).toBe(before);
    });

    test('a presentation change tells both and raises the revision; a setting that is not presentation tells only the settings', () => {
        const { announceEffectiveChange, readEffective } = load();
        announceEffectiveChange();
        const first = readEffective().settings.revision;
        broadcast.mockClear();

        effective = { ...effective, apiMaxRetries: count(5) };
        announceEffectiveChange();
        expect(broadcast.mock.calls.map(([channel]) => channel)).toEqual(['effective-settings-changed']);
        const second = (broadcast.mock.calls[0][1] as { revision: number }).revision;
        expect(second).toBeGreaterThan(first);
        broadcast.mockClear();

        effective = { ...effective, theme: text('dark') };
        announceEffectiveChange();
        expect(broadcast.mock.calls.map(([channel]) => channel)).toEqual([
            'effective-settings-changed',
            'effective-presentation-changed',
        ]);
        const third = (broadcast.mock.calls[0][1] as { revision: number }).revision;
        expect(third).toBeGreaterThan(second);
        expect((broadcast.mock.calls[1][1] as { revision: number }).revision).toBe(third);
    });

    test('a change of the owner generation tells the settings only', () => {
        const { announceEffectiveChange } = load();
        announceEffectiveChange();
        broadcast.mockClear();
        settings.installationGeneration.mockReturnValue(3);
        announceEffectiveChange();
        expect(broadcast.mock.calls.map(([channel]) => channel)).toEqual(['effective-settings-changed']);
        expect(broadcast.mock.calls[0][1]).toMatchObject({ generation: 3 });
    });

    test('a read that finds a change nobody announced tells the windows, and gives the new revision', () => {
        const { announceEffectiveChange, readEffective } = load();
        announceEffectiveChange();
        const before = readEffective().presentation.revision;
        broadcast.mockClear();
        effective = { ...effective, language: text('lv') };
        const read = readEffective();
        expect(read.presentation).toMatchObject({ language: 'lv' });
        expect(read.presentation.revision).toBeGreaterThan(before);
        expect(broadcast).toHaveBeenCalledTimes(2);
    });

    test('the revision is monotonic across a run of changes', () => {
        const { announceEffectiveChange, readEffective } = load();
        const seen: number[] = [];
        for (const theme of ['dark', 'light', 'dark', 'light']) {
            effective = { ...effective, theme: text(theme) };
            announceEffectiveChange();
            seen.push(readEffective().settings.revision);
        }
        expect([...seen].sort((a, b) => a - b)).toEqual(seen);
        expect(new Set(seen).size).toBe(seen.length);
    });

    test('a window that cannot be sent to does not fail the announcement or the read', () => {
        broadcast.mockImplementation(() => {
            throw new Error('window gone');
        });
        const { announceEffectiveChange, readEffective } = load();
        expect(() => announceEffectiveChange()).not.toThrow();
        expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('could not be sent: window gone'), null);
        effective = { ...effective, theme: text('dark') };
        expect(readEffective().presentation.theme).toBe('dark');
        broadcast.mockImplementation(() => {
            throw 'not an error';
        });
        effective = { ...effective, theme: text('light') };
        load().announceEffectiveChange();
        expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('could not be sent: unknown'), null);
    });

    test('projections that cannot be worked out are logged by an announcement, and thrown by a read', () => {
        settings.getScenarioCapabilities.mockImplementation(() => {
            throw new Error('no catalogue');
        });
        const { announceEffectiveChange, readEffective } = load();
        expect(() => announceEffectiveChange()).not.toThrow();
        expect(mockWarning).toHaveBeenCalledWith(
            expect.stringContaining('could not be worked out: no catalogue'),
            null,
        );
        expect(() => readEffective()).toThrow('no catalogue');
        settings.getScenarioCapabilities.mockImplementation(() => {
            throw 'plain';
        });
        load().announceEffectiveChange();
        expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('could not be worked out: unknown'), null);
    });
});
