/**
 * Capacitor entry (pages/Capacitor.jsx) — runs its bootstrap at module load:
 * installs the translation globals, on a native platform installs the bridge
 * and hydrates every write-behind store, wires flush-on-background, loads the
 * language, then mounts Login or App by token and re-mounts on
 * login-success / logout. Each test loads the module in an isolated registry
 * with its collaborators doMock'ed, so the bootstrap can be driven per case.
 */

const SRC = '../../src/js';

const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const GLOBALS = [
    '__capacitorBootstrap',
    'translationManager',
    'translations',
    'englishTranslations',
    'latvianTranslations',
];

describe('Capacitor entry', () => {
    let savedGlobals;
    let docListeners;
    let winListeners;
    let docSpy;
    let winSpy;

    beforeEach(() => {
        savedGlobals = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
        // Capture (don't attach) the lifecycle listeners so nothing leaks
        // between isolated module loads.
        docListeners = {};
        winListeners = {};
        docSpy = jest.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
            docListeners[type] = fn;
        });
        winSpy = jest.spyOn(globalThis, 'addEventListener').mockImplementation((type, fn) => {
            winListeners[type] = fn;
        });
    });

    afterEach(() => {
        docSpy.mockRestore();
        winSpy.mockRestore();
        for (const k of GLOBALS) {
            if (savedGlobals[k] === undefined) delete globalThis[k];
            else globalThis[k] = savedGlobals[k];
        }
        document.body.innerHTML = '';
    });

    /**
     * Load Capacitor.jsx with mocked collaborators.
     * @param {object} opts
     */
    const load = ({
        native = true,
        token = 'tok',
        getSettingThrows = false,
        initSettingsRejects = null,
        translationsModule = null,
        englishModule = { hello: 'Hello' },
        latvianModule = { hello: 'Sveiki' },
    } = {}) => {
        const tm = { loadLanguageFromSettings: jest.fn().mockResolvedValue(undefined) };
        const m = {
            tm,
            subscribers: {},
            installBridge: jest.fn(),
            subscribe: jest.fn((event, cb) => {
                m.subscribers[event] = cb;
            }),
            initSettings: initSettingsRejects
                ? jest.fn().mockRejectedValue(initSettingsRejects)
                : jest.fn().mockResolvedValue(undefined),
            flushPendingWrites: jest.fn(),
            getSetting: jest.fn(() => {
                if (getSettingThrows) throw new Error('not hydrated');
                return token;
            }),
            initializeMetadataAsync: jest.fn().mockResolvedValue(undefined),
            flushMetadataWrites: jest.fn(),
            initializeJoinStateAsync: jest.fn().mockResolvedValue(undefined),
            flushJoinStateWrites: jest.fn(),
            initializeSwapBackAsync: jest.fn().mockResolvedValue(undefined),
            flushSwapBackWrites: jest.fn(),
            initializeAutoSpendAsync: jest.fn().mockResolvedValue(undefined),
            flushAutoSpendWrites: jest.fn(),
            initializeDiagnosticsAsync: jest.fn().mockResolvedValue(undefined),
            flushDiagnosticsWrites: jest.fn(),
            isCapacitor: jest.fn(() => native),
            categoryError: jest.fn(),
            withCategory: jest.fn(() => ({ error: m.categoryError })),
            mountApp: jest.fn(),
            mountLogin: jest.fn(),
        };
        jest.isolateModules(() => {
            jest.doMock(`${SRC}/bridge/capacitor`, () => ({ installBridge: m.installBridge, subscribe: m.subscribe }));
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
            jest.doMock(`${SRC}/services/semantic/diagnostics`, () => ({
                initializeDiagnosticsAsync: m.initializeDiagnosticsAsync,
                flushDiagnosticsWrites: m.flushDiagnosticsWrites,
            }));
            jest.doMock(`${SRC}/runtime`, () => ({ isCapacitor: m.isCapacitor }));
            jest.doMock(`${SRC}/logger`, () => ({ withCategory: m.withCategory }));
            jest.doMock(
                `${SRC}/translations`,
                () => translationsModule ?? { translationManager: tm, translations: {} },
            );
            jest.doMock(`${SRC}/translations/english`, () => englishModule);
            jest.doMock(`${SRC}/translations/latvian`, () => latvianModule);
            jest.doMock('@/pages/App', () => ({ mountApp: m.mountApp }));
            jest.doMock('@/pages/Login', () => ({ mountLogin: m.mountLogin }));
            require('@/pages/Capacitor');
        });
        return m;
    };

    const addRoot = (...children) => {
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

    test('native bootstrap: globals, bridge, store hydration in order, language, then App mount', async () => {
        const root = addRoot('stale-a', 'stale-b');
        const m = load();
        await flush();

        expect(globalThis.__capacitorBootstrap).toBe(true);
        expect(globalThis.translationManager).toBe(m.tm);
        expect(globalThis.translations).toEqual({});
        expect(globalThis.englishTranslations).toEqual({ hello: 'Hello' });
        expect(globalThis.latvianTranslations).toEqual({ hello: 'Sveiki' });

        const order = [
            m.installBridge,
            m.initSettings,
            m.initializeMetadataAsync,
            m.initializeJoinStateAsync,
            m.initializeSwapBackAsync,
            m.initializeAutoSpendAsync,
            m.initializeDiagnosticsAsync,
            m.tm.loadLanguageFromSettings,
            m.mountApp,
        ].map((fn) => fn.mock.invocationCallOrder[0]);
        expect(order).toEqual([...order].sort((a, b) => a - b));
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
            m.flushDiagnosticsWrites,
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

    test('off-native skips the bridge and stores but still loads the language', async () => {
        const m = load({ native: false });
        await flush();
        expect(m.installBridge).not.toHaveBeenCalled();
        expect(m.initSettings).not.toHaveBeenCalled();
        expect(docListeners.visibilitychange).toBeUndefined();
        expect(m.tm.loadLanguageFromSettings).toHaveBeenCalledTimes(1);
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('a failed language load is logged and the app still mounts', async () => {
        const tmOverride = { loadLanguageFromSettings: jest.fn().mockRejectedValue(new Error('no lang')) };
        const m = load({ native: false, translationsModule: { translationManager: tmOverride, translations: {} } });
        await flush();
        expect(m.withCategory).toHaveBeenCalledWith('translation');
        expect(m.categoryError).toHaveBeenCalledWith('Translation load failed', expect.any(Error));
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('ES-module-shaped translations without a manager leave the globals alone and skip loading', async () => {
        globalThis.translationManager = undefined;
        const m = load({
            native: false,
            translationsModule: { __esModule: true },
            englishModule: { __esModule: true, default: { en: 1 } },
            latvianModule: { __esModule: true, default: { lv: 1 } },
        });
        await flush();
        expect(globalThis.translationManager).toBeUndefined();
        expect(globalThis.englishTranslations).toEqual({ en: 1 });
        expect(globalThis.latvianTranslations).toEqual({ lv: 1 });
        expect(m.mountApp).toHaveBeenCalledTimes(1);
    });

    test('a manager without loadLanguageFromSettings is not driven', async () => {
        // Default-less ES-module language files fall back to the namespace.
        const en = { __esModule: true, hi: 'Hi' };
        const lv = { __esModule: true, hi: 'Sveiki' };
        const m = load({
            native: false,
            translationsModule: { translationManager: {}, translations: {} },
            englishModule: en,
            latvianModule: lv,
        });
        await flush();
        expect(globalThis.englishTranslations.hi).toBe('Hi');
        expect(globalThis.latvianTranslations.hi).toBe('Sveiki');
        expect(m.categoryError).not.toHaveBeenCalled();
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
