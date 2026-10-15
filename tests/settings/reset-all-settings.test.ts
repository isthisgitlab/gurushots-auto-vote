/**
 * Guards the credential-preservation invariant of the settings facade's
 * resetAllSettings(): it must reset everything to defaults EXCEPT the
 * sign-in state and the mock mode. The CLI `reset-all-settings`
 * command and the GUI/IPC `reset-all-settings` handler both delegate here, so
 * this invariant is what stops a reset from silently logging the user out.
 *
 * Drives the in-memory headless-store seam (the same one storage.test.ts uses)
 * so the facade's loadSettings/saveSettings round-trip without touching fs.
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
    let store: MemoryStore;

    beforeEach(() => {
        store = installHeadlessStore();
    });

    afterEach(() => {
        removeHeadlessStore();
    });

    const imported = { at: '2026-10-15T10:00:00.000Z', sha256: '', report: { refsBlocked: [] }, acknowledged: true };

    test('keeps the whole sign-in state and the mock mode, and resets everything else to defaults', () => {
        store.value = JSON.stringify({
            auth: {
                token: 'secret-token',
                apiHeaders: { 'X-Test': '1' },
                lastUsername: 'me',
                chosenPhotosMemberId: 'm1',
            },
            app: {
                mock: true,
                theme: 'dark', // changed from default 'light'
                apiTimeout: 99, // changed from default 30
                noticeAcknowledgedVersion: 4,
            },
            defaults: { exposure: 80 },
            profiles: { P: { exposure: 70 } },
            seededProfiles: ['p'],
            scenarios: { S: { name: 'S' } },
            rules: [{ title: 'Macro', profile: 'P' }],
            challenges: { '7': { values: { exposure: 60 }, suppressRuleProfile: true, pins: { boost: 'e1' } } },
            imported,
        });

        const ok = settings.resetAllSettings();
        expect(ok).toBe(true);

        const after = parseJsonAs(store.value!, isConfig);
        // Essential user data survives the reset.
        expect(after.auth).toEqual({
            token: 'secret-token',
            apiHeaders: { 'X-Test': '1' },
            lastUsername: 'me',
            chosenPhotosMemberId: 'm1',
        });
        expect(after.app.mock).toBe(true);
        // Everything else returns to its default.
        expect(after.app.theme).toBe('light');
        expect(after.app.apiTimeout).toBe(30);
        expect(after.app.noticeAcknowledgedVersion).toBeUndefined();
        expect(after.defaults).toEqual({});
        expect(after.profiles).toEqual({});
        expect(after.seededProfiles).toEqual([]);
        expect(after.scenarios).toEqual({});
        expect(after.rules).toEqual([]);
        expect(after.challenges).toEqual({});
        // The record of the import is no setting: it stays.
        expect(after.imported).toEqual(imported);
    });

    test('forgets the title pins, as it always has', () => {
        store.value = JSON.stringify({ app: { theme: 'dark' } });
        settings.mergeTitlePins({ '7': 'Macro World' }, []);
        expect(settings.getTitlePins()).toEqual({ '7': 'Macro World' });

        expect(settings.resetAllSettings()).toBe(true);

        expect(settings.getTitlePins()).toEqual({});
    });

    test('settings that cannot be saved keep the pins too', () => {
        store.value = JSON.stringify({ app: { theme: 'dark' } });
        settings.mergeTitlePins({ '7': 'Macro World' }, []);
        // The service's store cannot set a damaged configuration aside, so saving is refused.
        store.value = '{broken';

        expect(settings.resetAllSettings()).toBe(false);

        expect(settings.getTitlePins()).toEqual({ '7': 'Macro World' });
    });
});
