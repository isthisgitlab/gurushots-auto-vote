/**
 * Capacitor entry (pages/Capacitor.tsx) — runs its bootstrap at module load:
 * on a native platform installs the bridge and hydrates every write-behind
 * store, wires flush-on-background, then mounts Login or App by token and
 * re-mounts on login-success / logout. Each test loads the module in an isolated registry
 * with its collaborators doMock'ed, so the bootstrap can be driven per case.
 */

import type { RendererGlobals } from '../../src/ts/types/capacitor';
import type { CategoryLogger } from '../../src/ts/logger';

const SRC = '../../src/ts';

const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const GLOBALS = ['__capacitorBootstrap'] as const;

describe('Capacitor entry', () => {
    let savedGlobals: Record<string, boolean | undefined>;
    let docListeners: Record<string, () => void>;
    let winListeners: Record<string, () => void>;
    let docSpy: jest.SpiedFunction<typeof document.addEventListener>;
    let winSpy: jest.SpiedFunction<typeof globalThis.addEventListener>;

    beforeEach(() => {
        savedGlobals = Object.fromEntries(GLOBALS.map((k) => [k, (globalThis as RendererGlobals)[k]]));
        // Capture (don't attach) the lifecycle listeners so nothing leaks
        // between isolated module loads.
        docListeners = {};
        winListeners = {};
        docSpy = jest.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
            docListeners[type] = fn as () => void;
        });
        winSpy = jest.spyOn(globalThis, 'addEventListener').mockImplementation((type, fn) => {
            winListeners[type] = fn as () => void;
        });
    });

    afterEach(() => {
        docSpy.mockRestore();
        winSpy.mockRestore();
        for (const k of GLOBALS) {
            if (savedGlobals[k] === undefined) delete (globalThis as RendererGlobals)[k];
            else (globalThis as RendererGlobals)[k] = savedGlobals[k];
        }
        document.body.innerHTML = '';
    });

    /**
     * Load Capacitor.tsx with mocked collaborators.
     */
    const load = ({
        native = true,
        token = 'tok',
        getSettingThrows = false,
        initSettingsRejects = null,
        deferHydrations = false,
    }: {
        native?: boolean;
        token?: string;
        getSettingThrows?: boolean;
        initSettingsRejects?: Error | null;
        deferHydrations?: boolean;
    } = {}) => {
        // With deferHydrations the eight store hydrations stay pending until a test calls the resolver they leave here.
        const releases: Array<() => void> = [];
        const hydration = () =>
            deferHydrations
                ? jest.fn(() => new Promise<void>((resolve) => releases.push(resolve)))
                : jest.fn().mockResolvedValue(undefined);
        const m = {
            releases,
            subscribers: {} as Record<string, () => void>,
            installBridge: jest.fn(),
            seedBridgeProfiles: jest.fn(),
            subscribe: jest.fn((event: string, cb: () => void): void => {
                m.subscribers[event] = cb;
            }),
            initSettings: initSettingsRejects
                ? jest.fn().mockRejectedValue(initSettingsRejects)
                : jest.fn().mockResolvedValue(undefined),
            flushPendingWrites: jest.fn(),
            getSetting: jest.fn((): string | undefined => {
                if (getSettingThrows) throw new Error('not hydrated');
                return token;
            }),
            initializeMetadataAsync: hydration(),
            flushMetadataWrites: jest.fn(),
            initializeJoinStateAsync: hydration(),
            flushJoinStateWrites: jest.fn(),
            initializeSwapBackAsync: hydration(),
            flushSwapBackWrites: jest.fn(),
            initializeAutoSpendAsync: hydration(),
            flushAutoSpendWrites: jest.fn(),
            initializeEntryAgesAsync: hydration(),
            flushEntryAgeWrites: jest.fn(),
            initializeScenarioStateAsync: hydration(),
            flushScenarioStateWrites: jest.fn(async () => {}),
            initializeDiagnosticsAsync: hydration(),
            flushDiagnosticsWrites: jest.fn(),
            initializePhotoStatsAsync: hydration(),
            flushPhotoStatsWrites: jest.fn(),
            isCapacitor: jest.fn(() => native),
            categoryError: jest.fn(),
            withCategory: jest.fn((): Pick<CategoryLogger, 'error'> => ({ error: m.categoryError })),
            mountApp: jest.fn(),
            mountLogin: jest.fn(),
        };
        jest.isolateModules(() => {
            jest.doMock(`${SRC}/bridge/capacitor`, () => ({
                installBridge: m.installBridge,
                seedBridgeProfiles: m.seedBridgeProfiles,
                subscribe: m.subscribe,
            }));
            jest.doMock(`${SRC}/settings`, () => ({
                initializeAsync: m.initSettings,
                flushPendingWrites: m.flushPendingWrites,
                getSetting: m.getSetting,
            }));
            jest.doMock(`${SRC}/metadata`, () => ({
                initializeMetadataAsync: m.initializeMetadataAsync,
                flushMetadataWrites: m.flushMetadataWrites,
            }));
            jest.doMock(`${SRC}/joinStateStore`, () => ({
                initializeJoinStateAsync: m.initializeJoinStateAsync,
                flushJoinStateWrites: m.flushJoinStateWrites,
            }));
            jest.doMock(`${SRC}/swapBackStore`, () => ({
                initializeSwapBackAsync: m.initializeSwapBackAsync,
                flushSwapBackWrites: m.flushSwapBackWrites,
            }));
            jest.doMock(`${SRC}/currencyAutoStore`, () => ({
                initializeAutoSpendAsync: m.initializeAutoSpendAsync,
                flushAutoSpendWrites: m.flushAutoSpendWrites,
            }));
            jest.doMock(`${SRC}/entryAgeStore`, () => ({
                initializeEntryAgesAsync: m.initializeEntryAgesAsync,
                flushEntryAgeWrites: m.flushEntryAgeWrites,
            }));
            jest.doMock(`${SRC}/scenarioStateStore`, () => ({
                initializeScenarioStateAsync: m.initializeScenarioStateAsync,
                flushScenarioStateWrites: m.flushScenarioStateWrites,
            }));
            jest.doMock(`${SRC}/services/semantic/diagnostics`, () => ({
                initializeDiagnosticsAsync: m.initializeDiagnosticsAsync,
                flushDiagnosticsWrites: m.flushDiagnosticsWrites,
            }));
            jest.doMock(`${SRC}/services/photoStats`, () => ({
                initializePhotoStatsAsync: m.initializePhotoStatsAsync,
                flushPhotoStatsWrites: m.flushPhotoStatsWrites,
            }));
            jest.doMock(`${SRC}/runtime`, () => ({ isCapacitor: m.isCapacitor }));
            jest.doMock(`${SRC}/logger`, () => ({ withCategory: m.withCategory }));
            jest.doMock('@/pages/App', () => ({ mountApp: m.mountApp }));
            jest.doMock('@/pages/Login', () => ({ mountLogin: m.mountLogin }));
            require('@/pages/Capacitor');
        });
        return m;
    };

    const addRoot = (...children: string[]) => {
        const root = document.createElement('div');
        root.id = 'root';
        for (const text of children) {
            const child = document.createElement('span');
            child.textContent = text;
            root.appendChild(child);
        }
        document.body.appendChild(root);
        return root;
    };

    test('native bootstrap: bridge, settings, then the stores hydrate together, then App mounts', async () => {
        const root = addRoot('stale-a', 'stale-b');
        const m = load({ deferHydrations: true });
        await flush();

        expect((globalThis as RendererGlobals).__capacitorBootstrap).toBe(true);

        // The settings come first, and seeding reads and writes them: only after they are hydrated.
        const first = [m.installBridge, m.initSettings, m.seedBridgeProfiles].map(
            (fn) => fn.mock.invocationCallOrder[0],
        );
        expect(first).toEqual([...first].sort((a, b) => a - b));

        // All eight hydrations have started while none has resolved, so the App has not mounted.
        const hydrations = [
            m.initializeMetadataAsync,
            m.initializeJoinStateAsync,
            m.initializeSwapBackAsync,
            m.initializeAutoSpendAsync,
            m.initializeEntryAgesAsync,
            m.initializeScenarioStateAsync,
            m.initializeDiagnosticsAsync,
            m.initializePhotoStatsAsync,
        ];
        for (const fn of hydrations) {
            expect(fn).toHaveBeenCalledTimes(1);
            expect(fn.mock.invocationCallOrder[0]).toBeGreaterThan(m.seedBridgeProfiles.mock.invocationCallOrder[0]);
        }
        expect(m.releases).toHaveLength(8);
        expect(m.mountApp).not.toHaveBeenCalled();

        // It mounts only once the last of them has resolved.
        for (const release of m.releases.slice(0, -1)) release();
        await flush();
        expect(m.mountApp).not.toHaveBeenCalled();
        m.releases.at(-1)!();
        await flush();
        expect(m.mountApp).toHaveBeenCalledTimes(1);
        expect(m.mountLogin).not.toHaveBeenCalled();
        // Stale DOM from a previous tree is cleared before mounting.
        expect(root.childNodes).toHaveLength(0);
    });

    test('flushes every store when the page is hidden or torn down, never throwing', async () => {
        const m = load();
        await flush();
        const flushers = [
            m.flushPendingWrites,
            m.flushMetadataWrites,
            m.flushJoinStateWrites,
            m.flushSwapBackWrites,
            m.flushAutoSpendWrites,
            m.flushEntryAgeWrites,
            m.flushScenarioStateWrites,
            m.flushDiagnosticsWrites,
            m.flushPhotoStatsWrites,
        ];

        const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        docListeners.visibilitychange();
        for (const fn of flushers) expect(fn).not.toHaveBeenCalled();

        hidden.mockReturnValue(true);
        docListeners.visibilitychange();
        for (const fn of flushers) expect(fn).toHaveBeenCalledTimes(1);
        hidden.mockRestore();

        winListeners.pagehide();
        for (const fn of flushers) expect(fn).toHaveBeenCalledTimes(2);

        m.flushMetadataWrites.mockImplementation(() => {
            throw new Error('io');
        });
        expect(() => winListeners.pagehide()).not.toThrow();
    });

    test('a scenario write that did not persist is logged by the teardown flush, not left as an unhandled rejection', async () => {
        const m = load();
        await flush();
        m.flushScenarioStateWrites.mockRejectedValueOnce(new Error('not persisted'));
        winListeners.pagehide();
        await flush();
        expect(m.categoryError).toHaveBeenCalledWith('Scenario state not persisted', expect.any(Error));
    });

    test('login-success and logout re-mount by the current token', async () => {
        const m = load({ token: '' });
        await flush();
        expect(m.mountLogin).toHaveBeenCalledTimes(1);

        m.getSetting.mockReturnValue('new-token');
        m.subscribers['login-success']();
        expect(m.mountApp).toHaveBeenCalledTimes(1);

        m.getSetting.mockReturnValue(undefined);
        m.subscribers.logout();
        expect(m.mountLogin).toHaveBeenCalledTimes(2);
    });

    test('an unreadable token mounts Login (no #root present)', async () => {
        const m = load({ getSettingThrows: true });
        await flush();
        expect(m.mountLogin).toHaveBeenCalledTimes(1);
        expect(m.mountApp).not.toHaveBeenCalled();
    });

    test('off-native skips the bridge and stores but still mounts', async () => {
        const m = load({ native: false });
        await flush();
        expect(m.installBridge).not.toHaveBeenCalled();
        expect(m.initSettings).not.toHaveBeenCalled();
        expect(m.seedBridgeProfiles).not.toHaveBeenCalled();
        expect(docListeners.visibilitychange).toBeUndefined();
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('a bootstrap failure is logged and still mounts', async () => {
        const m = load({ initSettingsRejects: new Error('prefs down') });
        await flush();
        expect(m.withCategory).toHaveBeenCalledWith('general');
        expect(m.categoryError).toHaveBeenCalledWith('Capacitor bootstrap failed', expect.any(Error));
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });
});
