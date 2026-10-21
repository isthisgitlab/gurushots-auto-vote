/**
 * The saved user name goes with the choice to stay logged in, in the settings facade's own write path: turning the
 * choice off forgets the name in the same write, whoever makes the change (the settings form, `set-setting`,
 * `pnpm settings:set`), and turning it on or changing anything else leaves it.
 */

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import settings = require('../../src/ts/settings');
import { isConfig } from '../helpers/storedShapes';
import { parseJsonAs } from '../helpers/parseJson';

jest.mock('../../src/ts/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
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

describe('the saved user name and Stay Logged In', () => {
    let store: MemoryStore;

    const stored = () => parseJsonAs(store.value ?? '{}', isConfig);

    beforeEach(() => {
        store = installHeadlessStore();
        store.value = JSON.stringify({
            app: { stayLoggedIn: true },
            auth: { token: 'tok', apiHeaders: {}, lastUsername: 'me@example.com' },
        });
    });

    afterEach(() => {
        removeHeadlessStore();
    });

    test('setSetting turning it off forgets the name in the same write, and keeps the rest of the sign-in', () => {
        expect(settings.setSetting('stayLoggedIn', false)).toBe(true);

        expect(stored().app.stayLoggedIn).toBe(false);
        expect(stored().auth).toEqual({ token: 'tok', apiHeaders: {}, lastUsername: '' });
        expect(store.write).toHaveBeenCalledTimes(1);
    });

    test('the settings form saving it off does the same', () => {
        expect(settings.saveAppSettings({ stayLoggedIn: false, theme: 'dark' })).toBe(true);

        expect(stored().app).toMatchObject({ stayLoggedIn: false, theme: 'dark' });
        expect(stored().auth.lastUsername).toBe('');
    });

    test('turning it on, or changing something else, leaves the name', () => {
        expect(settings.setSetting('stayLoggedIn', true)).toBe(true);
        expect(settings.setSetting('theme', 'dark')).toBe(true);

        expect(stored().auth.lastUsername).toBe('me@example.com');
    });

    test('a name saved while it is off stays: only turning it off forgets the name', () => {
        expect(settings.setSetting('stayLoggedIn', false)).toBe(true);
        expect(settings.setSetting('lastUsername', 'again@example.com')).toBe(true);
        expect(settings.setSetting('stayLoggedIn', false)).toBe(true);

        expect(stored().auth.lastUsername).toBe('again@example.com');
    });

    test('a write that is refused changes neither the choice nor the name', () => {
        const before = store.value;
        store.write.mockReturnValue(false);

        expect(settings.setSetting('stayLoggedIn', false)).toBe(false);

        expect(store.value).toBe(before);
    });
});
