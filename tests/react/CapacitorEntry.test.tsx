/**
 * Capacitor entry (pages/Capacitor.tsx) — runs its bootstrap at module load:
 * on a native platform installs the bridge and hydrates every write-behind
 * store, wires flush-on-background, clears a leftover token with Stay Logged
 * In off (skipping it while background auto-vote is armed), then mounts Login
 * or App by token and re-mounts on login-success / logout. Each test loads the
 * module in an isolated registry with its collaborators doMock'ed, so the
 * bootstrap can be driven per case.
 */

import type { RendererGlobals } from '../../src/ts/types/capacitor';
import type { CategoryLogger } from '../../src/ts/logger';

const SRC = '../../src/ts';

/**
 * What the native bridge's getStatus answers (services/NativeAutovoteBridge's
 * callPlugin union): no plugin, a plugin success, or a plugin call the plugin
 * rejected — that last one carries `error`, present whatever the rejection
 * said (a message-less rejection reads undefined).
 */
type BridgeStatus =
    | { running: false; available: false }
    | { running: boolean; available: true; cycleCount: number; lastRunAt: number; lastError: string }
    | { running: false; available: true; error: string | undefined };

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
        stayLoggedIn = false,
        getSettingThrows = false,
        initSettingsRejects = null,
        deferHydrations = false,
        status = { running: false, available: false },
        clears = false,
        clearRejection = null,
    }: {
        native?: boolean;
        token?: string;
        stayLoggedIn?: boolean;
        getSettingThrows?: boolean;
        initSettingsRejects?: Error | null;
        deferHydrations?: boolean;
        status?: BridgeStatus;
        /** When true the mocked clear helper empties the token and reports it cleared, like the real one. */
        clears?: boolean;
        /** A value the mocked clear helper rejects with (the settings refusing the write). */
        clearRejection?: unknown;
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
            // The stored stay/token pair the settings mock answers from; the
            // mocked clear writes it, so a mount after a clear reads the
            // cleared value like the real stores would.
            auth: { token, stayLoggedIn },
            installBridge: jest.fn(),
            seedBridgeProfiles: jest.fn(),
            subscribe: jest.fn((event: string, cb: () => void): void => {
                m.subscribers[event] = cb;
            }),
            initSettings: initSettingsRejects
                ? jest.fn().mockRejectedValue(initSettingsRejects)
                : jest.fn().mockResolvedValue(undefined),
            flushPendingWrites: jest.fn(),
            getSetting: jest.fn((key: string): string | boolean | undefined => {
                if (getSettingThrows) throw new Error('not hydrated');
                return key === 'stayLoggedIn' ? m.auth.stayLoggedIn : m.auth.token;
            }),
            getStatus: jest.fn((): Promise<BridgeStatus> => Promise.resolve(status)),
            clearTokenUnlessStayingLoggedIn: jest.fn(async (): Promise<boolean> => {
                if (clearRejection !== null) throw clearRejection;
                if (!clears) return false;
                m.auth.token = '';
                return true;
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
            categoryInfo: jest.fn(),
            withCategory: jest.fn(
                (): Pick<CategoryLogger, 'error' | 'info'> => ({ error: m.categoryError, info: m.categoryInfo }),
            ),
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
            jest.doMock(`${SRC}/services/auth`, () => ({
                clearTokenUnlessStayingLoggedIn: m.clearTokenUnlessStayingLoggedIn,
            }));
            jest.doMock(`${SRC}/services/NativeAutovoteBridge`, () => ({ getStatus: m.getStatus }));
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
        // The fallback mounts on token presence with the clear skipped (stay off, token on
        // disk): App mounts, and the token survives until the next launch — one member of
        // the retention-until-next-launch residual class.
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('with stay off, a leftover token is cleared before the mount decision', async () => {
        const m = load({
            clears: true,
            status: { running: false, available: true, cycleCount: 0, lastRunAt: 0, lastError: '' },
        });
        await flush();
        // Stay and token are read first; the plugin is asked only after them.
        expect(m.getStatus).toHaveBeenCalledTimes(1);
        expect(m.clearTokenUnlessStayingLoggedIn).toHaveBeenCalledTimes(1);
        expect(m.clearTokenUnlessStayingLoggedIn.mock.invocationCallOrder[0]).toBeGreaterThan(
            m.getStatus.mock.invocationCallOrder[0],
        );
        expect(m.categoryInfo).toHaveBeenCalledWith(
            'Cleared a saved token left by an earlier run (Stay Logged In is off)',
            null,
        );
        // The clear settled before the mount decision read the token: Login mounts.
        expect(m.mountLogin.mock.invocationCallOrder[0]).toBeGreaterThan(
            m.clearTokenUnlessStayingLoggedIn.mock.invocationCallOrder[0],
        );
        expect(m.mountLogin).toHaveBeenCalledTimes(1);
        expect(m.mountApp).not.toHaveBeenCalled();
    });

    test('clears when the plugin is absent: no plugin means no service could have been armed', async () => {
        // available:false is an availability-only answer that errs toward clearing — the safe
        // direction for this finding, so the clear runs on it.
        const m = load({ clears: true, status: { running: false, available: false } });
        await flush();
        expect(m.clearTokenUnlessStayingLoggedIn).toHaveBeenCalledTimes(1);
        expect(m.mountLogin).toHaveBeenCalledTimes(1);
    });

    test('clears a stopped service with an error history: the gate reads the rejected call, never lastError', async () => {
        // `lastError` is the plugin's own field, which survives a stop; the gate's `error`
        // is the bridge's rejected-call field, absent on this success shape — so a stopped
        // service with an error history still clears, as the design promises.
        const m = load({
            clears: true,
            status: { running: false, available: true, cycleCount: 3, lastRunAt: 42, lastError: 'earlier failure' },
        });
        await flush();
        expect(m.clearTokenUnlessStayingLoggedIn).toHaveBeenCalledTimes(1);
        expect(m.mountLogin).toHaveBeenCalledTimes(1);
    });

    test('keeps the token while background auto-vote is armed, and says so', async () => {
        // `running` is the persisted armed flag of the background service (it holds across
        // force-stop and reboot), not process liveness: the armed service is the token's
        // designed consumer, so retention here is by design.
        const m = load({
            status: { running: true, available: true, cycleCount: 1, lastRunAt: 2, lastError: '' },
        });
        await flush();
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();
        expect(m.categoryInfo).toHaveBeenCalledWith(
            'Kept the saved login token because background auto-vote is armed',
            null,
        );
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('keeps the token when the getStatus call was rejected with a message', async () => {
        // callPlugin answers a rejected plugin call with the `error` field — present whatever
        // the rejection carried — so the field-presence gate skips. The state it would have
        // read is unknown: retention until a launch where the call succeeds.
        const m = load({ status: { running: false, available: true, error: 'getStatus failed' } });
        await flush();
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();
        expect(m.categoryInfo).toHaveBeenCalledWith(
            'Kept the saved login token because background auto-vote state could not be read',
            null,
        );
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('keeps the token on a message-less getStatus rejection too', async () => {
        // A message-less rejection still carries the `error` key (errorMessage of a nullish
        // rejection is undefined): the field-presence test skips either way.
        const m = load({ status: { running: false, available: true, error: undefined } });
        await flush();
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();
        expect(m.categoryInfo).toHaveBeenCalledWith(
            'Kept the saved login token because background auto-vote state could not be read',
            null,
        );
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('stay on skips the clear before the plugin is asked', async () => {
        const m = load({ stayLoggedIn: true });
        await flush();
        expect(m.getStatus).not.toHaveBeenCalled();
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('no token: the gate skips silently', async () => {
        const m = load({ token: '' });
        await flush();
        expect(m.getStatus).not.toHaveBeenCalled();
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();
        expect(m.categoryInfo).not.toHaveBeenCalled();
        expect(m.mountLogin).toHaveBeenCalledTimes(1);
    });

    test('a refused clear is caught and logged, never a bootstrap failure, and the subscribes still land', async () => {
        const m = load({
            clearRejection: new Error('refused'),
            status: { running: false, available: true, cycleCount: 0, lastRunAt: 0, lastError: '' },
        });
        await flush();
        expect(m.categoryError).toHaveBeenCalledWith('Failed to clear a leftover token at startup:', expect.any(Error));
        expect(m.withCategory).not.toHaveBeenCalledWith('general');
        expect(m.subscribers['login-success']).toBeDefined();
        expect(m.subscribers.logout).toBeDefined();
        // A refused clear leaves the login in place: the mount still reads the token.
        expect(m.mountApp).toHaveBeenCalledTimes(1);
        expect(m.mountLogin).not.toHaveBeenCalled();
    });

    test('a login-success remount never clears the fresh login', async () => {
        const m = load({ token: '' });
        await flush();
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();

        m.auth.token = 'fresh-token';
        m.subscribers['login-success']();
        expect(m.mountApp).toHaveBeenCalledTimes(1);
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();
    });

    test('off-native the unhydrated stores read as defaults and the clear skips silently', async () => {
        // getSetting never throws off this entry's native platform: a store that has not been
        // read is answered with the defaults, so the gate sees no token and returns before the
        // plugin is asked — the launch never lands in the catch.
        const m = load({ native: false, token: '' });
        await flush();
        expect(m.getStatus).not.toHaveBeenCalled();
        expect(m.clearTokenUnlessStayingLoggedIn).not.toHaveBeenCalled();
        expect(m.categoryError).not.toHaveBeenCalled();
        expect(m.categoryInfo).not.toHaveBeenCalled();
        expect(m.mountLogin).toHaveBeenCalledTimes(1);
    });
});
