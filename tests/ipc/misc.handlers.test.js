/**
 * Guards the security-relevant wiring in misc.handlers: the open-external-url
 * scheme gate. A regression that dropped the isSafeExternalUrl guard, inverted
 * it, or broke the import would otherwise pass the suite unnoticed — the
 * manifest test only collects channel NAMES, it never invokes the handler.
 */

const openExternalMock = jest.fn().mockResolvedValue(undefined);

jest.mock('electron', () => ({
    shell: { openExternal: openExternalMock },
}));
jest.mock('../../src/js/ui/applicationMenu', () => ({
    updateMenuTranslations: jest.fn(),
}));
const mockTranslationManager = { loadLanguageFromSettings: jest.fn() };
jest.mock('../../src/js/translations/index', () => ({ translationManager: mockTranslationManager }));
jest.mock('../../src/js/logger', () => {
    const cat = { warning: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { withCategory: jest.fn(() => cat) };
});

const { buildHandlers } = require('../../src/js/ipc/misc.handlers');

describe('misc.handlers open-external-url scheme gate', () => {
    let handler;
    beforeEach(() => {
        openExternalMock.mockClear();
        handler = buildHandlers({ getMainWindow: jest.fn(), getLoginWindow: jest.fn() })['open-external-url'];
    });

    test('opens a well-formed https URL', async () => {
        const res = await handler({}, 'https://gurushots.com/challenges');
        expect(openExternalMock).toHaveBeenCalledWith('https://gurushots.com/challenges');
        expect(res).toEqual({ success: true });
    });

    test.each([
        ['http (insecure)', 'http://gurushots.com'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['file scheme', 'file:///etc/passwd'],
        ['embedded credentials', 'https://gurushots.com@evil.com/'],
        ['non-string', 42],
        ['empty', ''],
    ])('refuses %s and never calls shell.openExternal', async (_label, url) => {
        const res = await handler({}, url);
        expect(openExternalMock).not.toHaveBeenCalled();
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/https/i);
    });

    test('reports a failure when shell.openExternal throws', async () => {
        openExternalMock.mockRejectedValueOnce(new Error('boom'));
        const res = await handler({}, 'https://example.com');
        expect(res.success).toBe(false);
        expect(res.error).toBe('boom');
    });

    test('falls back to a fixed message when shell.openExternal rejects with null', async () => {
        openExternalMock.mockRejectedValueOnce(null);
        await expect(handler({}, 'https://example.com')).resolves.toEqual({
            success: false,
            error: 'Failed to open external URL',
        });
    });
});

describe('misc.handlers reload-window', () => {
    const win = (destroyed = false) => ({ isDestroyed: jest.fn(() => destroyed), reload: jest.fn() });

    test('reloads the main window when it is alive', async () => {
        const main = win();
        const login = win();
        const handlers = buildHandlers({ getMainWindow: () => main, getLoginWindow: () => login });
        await expect(handlers['reload-window']()).resolves.toEqual({ success: true });
        expect(main.reload).toHaveBeenCalledTimes(1);
        expect(login.reload).not.toHaveBeenCalled();
    });

    test.each([
        ['absent', null],
        ['destroyed', true],
    ])('falls back to the login window when the main window is %s', async (_label, mainState) => {
        const main = mainState === null ? null : win(true);
        const login = win();
        const handlers = buildHandlers({ getMainWindow: () => main, getLoginWindow: () => login });
        await expect(handlers['reload-window']()).resolves.toEqual({ success: true });
        expect(login.reload).toHaveBeenCalledTimes(1);
        if (main) expect(main.reload).not.toHaveBeenCalled();
    });

    test('reports failure when no live window exists', async () => {
        const login = win(true);
        const handlers = buildHandlers({ getMainWindow: () => null, getLoginWindow: () => login });
        await expect(handlers['reload-window']()).resolves.toEqual({
            success: false,
            error: 'No active window to reload',
        });
        expect(login.reload).not.toHaveBeenCalled();
    });

    test('returns the error envelope when reload throws', async () => {
        const main = win();
        main.reload.mockImplementation(() => {
            throw new Error('crashed');
        });
        const handlers = buildHandlers({ getMainWindow: () => main, getLoginWindow: () => null });
        await expect(handlers['reload-window']()).resolves.toEqual({ success: false, error: 'crashed' });
    });

    test('falls back to a fixed message when reload throws null', async () => {
        const main = win();
        main.reload.mockImplementation(() => {
            throw null;
        });
        const handlers = buildHandlers({ getMainWindow: () => main, getLoginWindow: () => null });
        await expect(handlers['reload-window']()).resolves.toEqual({
            success: false,
            error: 'Failed to reload window',
        });
    });
});

describe('misc.handlers refresh-menu', () => {
    const { updateMenuTranslations } = require('../../src/js/ui/applicationMenu');
    const { loadLanguageFromSettings } = mockTranslationManager;

    beforeEach(() => {
        updateMenuTranslations.mockClear();
        loadLanguageFromSettings.mockReset();
    });

    test('reloads the language from settings before rebuilding the menu', async () => {
        loadLanguageFromSettings.mockResolvedValue(undefined);
        const handlers = buildHandlers({ getMainWindow: jest.fn(), getLoginWindow: jest.fn() });

        await expect(handlers['refresh-menu']()).resolves.toEqual({ success: true });
        expect(loadLanguageFromSettings).toHaveBeenCalledTimes(1);
        expect(updateMenuTranslations).toHaveBeenCalledTimes(1);
        expect(loadLanguageFromSettings.mock.invocationCallOrder[0]).toBeLessThan(
            updateMenuTranslations.mock.invocationCallOrder[0],
        );
    });

    test('does not rebuild the menu when the language load fails', async () => {
        loadLanguageFromSettings.mockRejectedValue(new Error('io'));
        const handlers = buildHandlers({ getMainWindow: jest.fn(), getLoginWindow: jest.fn() });

        await expect(handlers['refresh-menu']()).resolves.toEqual({ success: false, error: 'io' });
        expect(updateMenuTranslations).not.toHaveBeenCalled();
    });

    test('falls back to a fixed message when the language load rejects with null', async () => {
        loadLanguageFromSettings.mockRejectedValue(null);
        const handlers = buildHandlers({ getMainWindow: jest.fn(), getLoginWindow: jest.fn() });

        await expect(handlers['refresh-menu']()).resolves.toEqual({ success: false, error: 'Failed to refresh menu' });
    });
});

describe('misc.handlers register', () => {
    test('registers every channel with the injected window accessors', async () => {
        const { register } = require('../../src/js/ipc/misc.handlers');
        const channels = new Map();
        const main = { isDestroyed: () => false, reload: jest.fn() };
        register(
            { handle: (channel, impl) => channels.set(channel, impl) },
            { getMainWindow: () => main, getLoginWindow: () => null },
        );

        expect([...channels.keys()].sort()).toEqual(['open-external-url', 'refresh-menu', 'reload-window']);
        await expect(channels.get('reload-window')(undefined)).resolves.toEqual({ success: true });
        expect(main.reload).toHaveBeenCalled();
    });
});
