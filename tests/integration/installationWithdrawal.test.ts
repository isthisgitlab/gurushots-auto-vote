/**
 * A full Stop withdraws the installation's publication (settings/scenarioLifecycle.ts withdrawInstallationPublication): the
 * installation's settings read their saved values at once (no write to the configuration), the phase and the progress are
 * kept, nothing is published while the withdrawal stands, and only an explicit user re-arm lifts it, before the next
 * publication. Over the real settings, the real progress ledger and the in-memory headless store.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        api: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        withCategory: jest.fn(() => category),
    };
});

import settings = require('../../src/ts/core/settings');
import storageModule = require('../../src/ts/core/settings/storage');
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as installationModule from '../../src/ts/core/services/scenarioRunner/installation';
import type * as nodeSeamsModule from '../../src/ts/core/autovote/nodeSeams';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import { invalid } from '../helpers/invalid';
import { isRecordOf, isUnknown, parseJsonAs } from '../helpers/parseJson';

const { scenarioStateLedger, INSTALLATION_KEY } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { publishInstallationOverlay } =
    require('../../src/ts/core/services/scenarioRunner/installation') as typeof installationModule;
const { withdrawInstallation, reArmInstallation } =
    require('../../src/ts/core/autovote/nodeSeams') as typeof nodeSeamsModule;

const NOW = Math.floor(Date.now() / 1000);

const plan = {
    name: 'Inst',
    version: 1,
    scope: 'installation',
    start: 'main',
    phases: { main: { settings: { notifyOnBoost: true, apiMaxRetries: 7 } } },
};

let store: MemoryStore;
const pass = () =>
    invalid<Parameters<typeof publishInstallationOverlay>[0]>({
        token: 'tok',
        ledger: scenarioStateLedger,
        reads: {
            getBankroll: jest.fn(async () => null),
            getMyMissions: jest.fn(),
            getMyCompletedChallenges: jest.fn(),
        },
    });
const record = () => scenarioStateLedger.get(INSTALLATION_KEY).state!;
/** What the installation's consumers read now: a notification flag and one of the three transport values. */
const reads = () => ({
    notifyOnBoost: settings.getInstallationSetting('notifyOnBoost'),
    apiMaxRetries: settings.getInstallationSetting('apiMaxRetries'),
});

beforeEach(async () => {
    store = installHeadlessStore();
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
    expect(settings.saveScenario(invalid(plan)).ok).toBe(true);
    expect(settings.setInstallationScenario('Inst', 'android-service', 0).ok).toBe(true);
});

afterEach(() => {
    removeHeadlessStore();
});

describe('a full Stop and an explicit re-arm', () => {
    // The saved values (the defaults, here): what the consumers read with no publication.
    const baseline = () => ({ notifyOnBoost: false, apiMaxRetries: 3 });

    test('the published values, then the saved ones at once after the Stop, then the published ones again after the re-arm', async () => {
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
        expect(reads()).toEqual({ notifyOnBoost: true, apiMaxRetries: 7 });
        expect(baseline()).not.toEqual(reads());
        const config = store.value;

        expect(withdrawInstallation(1)).toBe('withdrawn');
        // Baseline transport and notification values, with nothing written to the configuration.
        expect(reads()).toEqual(baseline());
        expect(store.value).toBe(config);

        // Re-armed by the user: the withdrawal is lifted, and the next publication brings the values back.
        expect(reArmInstallation()).toBe('restored');
        expect(record().withdrawn).toBeUndefined();
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
        expect(reads()).toEqual({ notifyOnBoost: true, apiMaxRetries: 7 });
    });

    test('phase and progress are untouched: only the marker is added and the publication dropped', async () => {
        await publishInstallationOverlay(pass());
        scenarioStateLedger.change(INSTALLATION_KEY, (current) => ({
            ...current!,
            memory: { held: 'p' },
            fired: { r: { at: 3 } },
            spent: { swaps: 1, keys: 2, fills: 3 },
        }));
        const before = record();
        expect(before.published).toBeDefined();
        expect(withdrawInstallation(4)).toBe('withdrawn');
        const after = record();
        expect(after.withdrawn).toEqual({ at: expect.any(Number), epoch: 4 });
        expect(after.published).toBeUndefined();
        for (const key of [
            'phase',
            'phaseEnteredAt',
            'memory',
            'fired',
            'spent',
            'generation',
            'scenario',
            'inFlight',
        ] as const) {
            expect(after[key]).toEqual(before[key]);
        }
    });

    test('it is no pause: nothing publishes while it stands, and the account rules run again once it is lifted', async () => {
        await publishInstallationOverlay(pass());
        withdrawInstallation(1);
        await expect(publishInstallationOverlay(pass())).resolves.toBe('held');
        expect(record().published).toBeUndefined();
        expect(record().paused).toBeUndefined();
        reArmInstallation();
        await expect(publishInstallationOverlay(pass())).resolves.toBe('published');
    });

    test('a repeated Stop re-marks it under the newer epoch; an unneeded re-arm changes nothing', async () => {
        await publishInstallationOverlay(pass());
        expect(reArmInstallation()).toBe('none');
        expect(withdrawInstallation(1)).toBe('withdrawn');
        expect(withdrawInstallation(2)).toBe('withdrawn');
        expect(record().withdrawn?.epoch).toBe(2);
        expect(reArmInstallation()).toBe('restored');
        expect(reArmInstallation()).toBe('none');
    });
});

describe('what cannot be written or read', () => {
    test('a withdrawal whose write does not land is failed, and the record is as it was', async () => {
        await publishInstallationOverlay(pass());
        const before = store.keys.get('gs_scenario_state');
        const real = store.writeKey;
        store.writeKey = () => false;
        expect(withdrawInstallation(1)).toBe('failed');
        store.writeKey = real;
        expect(store.keys.get('gs_scenario_state')).toBe(before);
        expect(record().withdrawn).toBeUndefined();
    });

    test('a re-arm whose write does not land is failed, and the withdrawal stands', async () => {
        await publishInstallationOverlay(pass());
        withdrawInstallation(1);
        const real = store.writeKey;
        store.writeKey = () => false;
        expect(reArmInstallation()).toBe('failed');
        store.writeKey = real;
        expect(record().withdrawn).toBeDefined();
    });

    test('a record that is gone by the time the change is made is not written to', async () => {
        await publishInstallationOverlay(pass());
        withdrawInstallation(1);
        const change = jest.spyOn(scenarioStateLedger, 'change');
        // The change is decided on what is there when it is made: a vanished record, and one with no withdrawal, refuse it.
        change.mockImplementation((_key, make) => {
            expect(make(null)).toEqual({ refuse: expect.any(String) });
            return { ok: false, reason: 'refused' };
        });
        expect(withdrawInstallation(2)).toBe('failed');
        expect(reArmInstallation()).toBe('failed');
        change.mockImplementation((_key, make) => {
            expect(make({ ...record(), withdrawn: null })).toEqual({ refuse: expect.any(String) });
            return { ok: false, reason: 'refused' };
        });
        expect(reArmInstallation()).toBe('failed');
        change.mockRestore();
    });

    test('progress that cannot be read can be neither withdrawn nor restored', () => {
        store.keys.set('gs_scenario_state', 'not json');
        expect(withdrawInstallation(1)).toBe('failed');
        expect(reArmInstallation()).toBe('failed');
    });

    test('a record that has no installation progress reads as nothing to withdraw', async () => {
        await scenarioStateLedger.removeAll();
        expect(settings.withdrawInstallationPublication(1)).toEqual({ ok: true, changed: false });
        expect(settings.restoreInstallationPublication()).toEqual({ ok: true, changed: false });
    });
});

describe('the marker is strictly validated', () => {
    const base = () => parseJsonAs(store.keys.get('gs_scenario_state') ?? '', isRecordOf(isRecordOf(isUnknown)));

    test.each([
        ['an extra key', { at: 1, epoch: 1, x: 1 }],
        ['a text time', { at: '1', epoch: 1 }],
        ['a fractional epoch', { at: 1, epoch: 1.5 }],
        ['a negative epoch', { at: 1, epoch: -1 }],
        ['no epoch', { at: 1 }],
        ['a text value', 'yes'],
    ])('%s makes the record unreadable', async (_label, withdrawn) => {
        await publishInstallationOverlay(pass());
        const stored = base();
        stored[INSTALLATION_KEY] = { ...stored[INSTALLATION_KEY], withdrawn };
        store.keys.set('gs_scenario_state', JSON.stringify(stored));
        expect(scenarioStateLedger.get(INSTALLATION_KEY)).toMatchObject({ corrupt: 'record', state: null });
    });

    test('a null marker and a valid one are read', async () => {
        await publishInstallationOverlay(pass());
        for (const withdrawn of [null, { at: NOW, epoch: 0 }]) {
            const stored = base();
            stored[INSTALLATION_KEY] = { ...stored[INSTALLATION_KEY], withdrawn };
            store.keys.set('gs_scenario_state', JSON.stringify(stored));
            expect(scenarioStateLedger.get(INSTALLATION_KEY).corrupt).toBe(false);
        }
    });
});
