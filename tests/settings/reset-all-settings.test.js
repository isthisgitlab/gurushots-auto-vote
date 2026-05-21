/**
 * Guards the credential-preservation invariant of the settings facade's
 * resetAllSettings(): it must reset everything to defaults EXCEPT the
 * user-essential keys token / mock / apiHeaders. The CLI `reset-all-settings`
 * command and the GUI/IPC `reset-all-settings` handler both delegate here, so
 * this invariant is what stops a reset from silently logging the user out.
 *
 * Drives the in-memory headless-store seam (the same one storage.test.js uses)
 * so the facade's loadSettings/saveSettings round-trip without touching fs.
 */

const { storage } = require('../../src/js/settings/storage');
const settings = require('../../src/js/settings');

jest.mock('../../src/js/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    api: jest.fn(),
    startOperation: jest.fn(),
    endOperation: jest.fn(),
    apiRequest: jest.fn(),
    apiResponse: jest.fn(),
    isDevMode: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
    getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
    })),
}));

describe('settings facade — resetAllSettings', () => {
    let store;

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
    });

    test('preserves token / mock / apiHeaders and resets other settings to defaults', () => {
        store.value = JSON.stringify({
            token: 'secret-token',
            mock: true,
            apiHeaders: { 'X-Test': '1' },
            theme: 'dark', // non-preserved app setting, changed from default 'light'
            apiTimeout: 99, // non-preserved app setting, changed from default 30
        });

        const ok = settings.resetAllSettings();
        expect(ok).toBe(true);

        const after = JSON.parse(store.value);
        // Essential user data survives the reset.
        expect(after.token).toBe('secret-token');
        expect(after.mock).toBe(true);
        expect(after.apiHeaders).toEqual({ 'X-Test': '1' });
        // Everything else returns to its default.
        expect(after.theme).toBe('light');
        expect(after.apiTimeout).toBe(30);
    });
});
