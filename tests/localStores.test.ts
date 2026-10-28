/**
 * Tests for localStores.ts — the boot registry behind the Capacitor page:
 * the settings facade hydrates first and alone, the caller's step (the page's
 * bridge-profile seeding) runs between it and the other stores, the other
 * stores hydrate together, and the teardown flush fires every store's flush in
 * boot order without waiting on the answers.
 */

import { invalid } from './helpers/invalid';
import { flushLocalStores, initializeLocalStores } from '../src/ts/localStores';
import * as logger from '../src/ts/logger';
import * as settings from '../src/ts/settings';
import * as metadata from '../src/ts/metadata';
import * as joinStateStore from '../src/ts/joinStateStore';
import * as swapBackStore from '../src/ts/swapBackStore';
import * as currencyAutoStore from '../src/ts/currencyAutoStore';
import * as entryAgeStore from '../src/ts/entryAgeStore';
import * as scenarioStateStore from '../src/ts/scenarioStateStore';
import * as diagnostics from '../src/ts/services/semantic/diagnostics';
import * as photoStats from '../src/ts/services/photoStats';

jest.mock('../src/ts/settings', () => ({
    __esModule: true,
    initializeAsync: jest.fn<Promise<void>, []>(),
    flushPendingWrites: jest.fn<Promise<void>, []>(),
}));
jest.mock('../src/ts/metadata', () => ({
    __esModule: true,
    initializeMetadataAsync: jest.fn<Promise<void>, []>(),
    flushMetadataWrites: jest.fn<Promise<void>, []>(),
}));
jest.mock('../src/ts/joinStateStore', () => ({
    __esModule: true,
    initializeJoinStateAsync: jest.fn<Promise<void>, []>(),
    flushJoinStateWrites: jest.fn<Promise<void>, []>(),
}));
jest.mock('../src/ts/swapBackStore', () => ({
    __esModule: true,
    initializeSwapBackAsync: jest.fn<Promise<void>, []>(),
    flushSwapBackWrites: jest.fn<Promise<void>, []>(),
}));
jest.mock('../src/ts/currencyAutoStore', () => ({
    __esModule: true,
    initializeAutoSpendAsync: jest.fn<Promise<void>, []>(),
    flushAutoSpendWrites: jest.fn<Promise<void>, []>(),
}));
jest.mock('../src/ts/entryAgeStore', () => ({
    __esModule: true,
    initializeEntryAgesAsync: jest.fn<Promise<void>, []>(),
    flushEntryAgeWrites: jest.fn<Promise<void>, []>(),
}));
jest.mock('../src/ts/scenarioStateStore', () => ({
    __esModule: true,
    initializeScenarioStateAsync: jest.fn<Promise<void>, []>(),
    flushScenarioStateWrites: jest.fn<Promise<void>, []>(),
}));
jest.mock('../src/ts/services/semantic/diagnostics', () => ({
    __esModule: true,
    initializeDiagnosticsAsync: jest.fn<Promise<void>, []>(),
    flushDiagnosticsWrites: jest.fn<Promise<void>, []>(),
}));
jest.mock('../src/ts/services/photoStats', () => ({
    __esModule: true,
    initializePhotoStatsAsync: jest.fn<Promise<void>, []>(),
    flushPhotoStatsWrites: jest.fn<Promise<void>, []>(),
}));

// Lets every microtask the boot chain has queued run before the assertions.
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
    jest.clearAllMocks();
});

describe('initializeLocalStores', () => {
    test('the settings hydrate first and alone, the caller step runs, then the rest hydrate in boot order', async () => {
        const order: string[] = [];
        const recording = (name: string) => (): Promise<void> => {
            order.push(name);
            return Promise.resolve();
        };
        jest.mocked(settings.initializeAsync).mockImplementation(recording('settings'));
        jest.mocked(metadata.initializeMetadataAsync).mockImplementation(recording('metadata'));
        jest.mocked(joinStateStore.initializeJoinStateAsync).mockImplementation(recording('joinState'));
        jest.mocked(swapBackStore.initializeSwapBackAsync).mockImplementation(recording('swapBack'));
        jest.mocked(currencyAutoStore.initializeAutoSpendAsync).mockImplementation(recording('autoSpend'));
        jest.mocked(entryAgeStore.initializeEntryAgesAsync).mockImplementation(recording('entryAges'));
        jest.mocked(scenarioStateStore.initializeScenarioStateAsync).mockImplementation(recording('scenarioState'));
        jest.mocked(diagnostics.initializeDiagnosticsAsync).mockImplementation(recording('diagnostics'));
        jest.mocked(photoStats.initializePhotoStatsAsync).mockImplementation(recording('photoStats'));

        await initializeLocalStores(() => order.push('seed'));

        expect(order).toEqual([
            'settings',
            'seed',
            'metadata',
            'joinState',
            'swapBack',
            'autoSpend',
            'entryAges',
            'scenarioState',
            'diagnostics',
            'photoStats',
        ]);
    });

    test('the stores after the caller step start together: none is awaited before the next is started', async () => {
        const started: string[] = [];
        const gates: Array<() => void> = [];
        const pending = (name: string) => (): Promise<void> => {
            started.push(name);
            return new Promise<void>((resolve) => gates.push(resolve));
        };
        jest.mocked(metadata.initializeMetadataAsync).mockImplementation(pending('metadata'));
        jest.mocked(joinStateStore.initializeJoinStateAsync).mockImplementation(pending('joinState'));
        jest.mocked(swapBackStore.initializeSwapBackAsync).mockImplementation(pending('swapBack'));
        jest.mocked(currencyAutoStore.initializeAutoSpendAsync).mockImplementation(pending('autoSpend'));
        jest.mocked(entryAgeStore.initializeEntryAgesAsync).mockImplementation(pending('entryAges'));
        jest.mocked(scenarioStateStore.initializeScenarioStateAsync).mockImplementation(pending('scenarioState'));
        jest.mocked(diagnostics.initializeDiagnosticsAsync).mockImplementation(pending('diagnostics'));
        jest.mocked(photoStats.initializePhotoStatsAsync).mockImplementation(pending('photoStats'));

        const boot = initializeLocalStores(() => {});
        await flushMicrotasks();

        expect(started).toEqual([
            'metadata',
            'joinState',
            'swapBack',
            'autoSpend',
            'entryAges',
            'scenarioState',
            'diagnostics',
            'photoStats',
        ]);

        for (const release of gates) release();
        await boot;
    });

    test('a store whose hydration rejects rejects the boot, as the page awaited it before', async () => {
        jest.mocked(joinStateStore.initializeJoinStateAsync).mockRejectedValue(new Error('read failed'));
        await expect(initializeLocalStores(() => {})).rejects.toThrow('read failed');
    });
});

describe('flushLocalStores', () => {
    test("fires every store's flush, in boot order, without waiting on the answers", async () => {
        const order: string[] = [];
        const recording = (name: string) => (): Promise<void> => {
            order.push(name);
            return Promise.resolve();
        };
        jest.mocked(settings.flushPendingWrites).mockImplementation(recording('settings'));
        jest.mocked(metadata.flushMetadataWrites).mockImplementation(() => {
            // A flush that never settles must not hold the teardown back.
            order.push('metadata');
            return new Promise<void>(() => {});
        });
        jest.mocked(joinStateStore.flushJoinStateWrites).mockImplementation(recording('joinState'));
        jest.mocked(swapBackStore.flushSwapBackWrites).mockImplementation(recording('swapBack'));
        jest.mocked(currencyAutoStore.flushAutoSpendWrites).mockImplementation(recording('autoSpend'));
        jest.mocked(entryAgeStore.flushEntryAgeWrites).mockImplementation(recording('entryAges'));
        jest.mocked(scenarioStateStore.flushScenarioStateWrites).mockImplementation(recording('scenarioState'));
        jest.mocked(diagnostics.flushDiagnosticsWrites).mockImplementation(recording('diagnostics'));
        jest.mocked(photoStats.flushPhotoStatsWrites).mockImplementation(recording('photoStats'));

        await expect(flushLocalStores()).resolves.toBeUndefined();

        expect(order).toEqual([
            'settings',
            'metadata',
            'joinState',
            'swapBack',
            'autoSpend',
            'entryAges',
            'scenarioState',
            'diagnostics',
            'photoStats',
        ]);
    });

    test('a scenario flush that did not persist is logged, not left as a rejection', async () => {
        const error = jest.fn<void, [string, unknown]>();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ error }));
        const failure = new Error('not persisted');
        jest.mocked(scenarioStateStore.flushScenarioStateWrites).mockRejectedValueOnce(failure);

        await expect(flushLocalStores()).resolves.toBeUndefined();
        await flushMicrotasks();

        expect(logger.withCategory).toHaveBeenCalledWith('general');
        expect(error).toHaveBeenCalledWith('Scenario state not persisted', failure);
    });

    test('a flush that throws synchronously is contained, and the stores after it are not flushed', async () => {
        jest.mocked(settings.flushPendingWrites).mockImplementation(() => {
            throw new Error('io');
        });

        await expect(flushLocalStores()).resolves.toBeUndefined();

        expect(joinStateStore.flushJoinStateWrites).not.toHaveBeenCalled();
    });
});
