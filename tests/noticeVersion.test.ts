/**
 * The notice version and the setting that records which version the user acknowledged.
 */

import type * as schemaModule from '../src/ts/settings/schema';
import type * as settingsModule from '../src/ts/settings';
import type { AndroidHeadlessStore } from '../src/ts/types/settings';
import { CURRENT_NOTICE_VERSION } from '../src/ts/noticeVersion';
import { isRendererHiddenKey } from '../src/ts/ipc/rendererSettings';

const { SETTINGS_SCHEMA, schemaEntry, validateSetting } = require('../src/ts/settings/schema') as typeof schemaModule;

describe('notice version', () => {
    test('the current version is a positive integer, so the default of 0 shows the notice', () => {
        expect(Number.isInteger(CURRENT_NOTICE_VERSION)).toBe(true);
        expect(CURRENT_NOTICE_VERSION).toBeGreaterThan(SETTINGS_SCHEMA.noticeAcknowledgedVersion.default);
    });
});

describe('noticeAcknowledgedVersion', () => {
    const entry = schemaEntry('noticeAcknowledgedVersion');

    test('is a global (not per-challenge) number defaulting to 0', () => {
        expect(entry).toBeDefined();
        expect(entry?.type).toBe('number');
        expect(entry?.default).toBe(0);
        expect(entry?.perChallenge).toBe(false);
        expect(entry?.challengeOnly).toBeUndefined();
    });

    test.each([0, 1, 2, 50])('accepts %p', (value) => {
        expect(validateSetting('noticeAcknowledgedVersion', value)).toBe(true);
    });

    test.each([-1, 1.5, '1', null, undefined, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p', (value) => {
        expect(validateSetting('noticeAcknowledgedVersion', value)).toBe(false);
    });

    test('a renderer may read and write it', () => {
        expect(isRendererHiddenKey('noticeAcknowledgedVersion')).toBe(false);
    });
});

describe('noticeAcknowledgedVersion through the settings facade', () => {
    const g = globalThis as typeof globalThis & {
        __GS_HEADLESS__?: boolean;
        AndroidHeadlessStore?: AndroidHeadlessStore;
    };
    let value: string | null;
    let settings: typeof settingsModule;

    beforeEach(() => {
        value = null;
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = {
            read: () => value,
            write: (data) => {
                value = data;
            },
        };
        jest.isolateModules(() => {
            settings = require('../src/ts/settings') as typeof settingsModule;
        });
    });

    afterEach(() => {
        delete g.__GS_HEADLESS__;
        delete g.AndroidHeadlessStore;
    });

    test('is unset until acknowledged and set-setting records the version', () => {
        expect(settings.getSetting('noticeAcknowledgedVersion')).toBeUndefined();

        expect(settings.setSetting('noticeAcknowledgedVersion', CURRENT_NOTICE_VERSION)).toBe(true);

        expect(settings.getSetting('noticeAcknowledgedVersion')).toBe(CURRENT_NOTICE_VERSION);
    });

    test.each([-1, 1.5, 'one', null])('set-setting refuses %p and keeps what was stored', (bad) => {
        settings.setSetting('noticeAcknowledgedVersion', 1);

        expect(settings.setSetting('noticeAcknowledgedVersion', bad)).toBe(false);
        expect(settings.saveSettings({ noticeAcknowledgedVersion: bad })).toBe(false);

        expect(settings.getSetting('noticeAcknowledgedVersion')).toBe(1);
    });

    test('a stored value that is not a non-negative integer is dropped at load', () => {
        value = JSON.stringify({ theme: 'dark', noticeAcknowledgedVersion: -3 });

        const loaded = settings.loadSettings();

        expect(loaded.theme).toBe('dark');
        expect(loaded.noticeAcknowledgedVersion).toBeUndefined();
    });

    test('set-global-default validates it too, and it never counts as a per-challenge setting', () => {
        expect(settings.setGlobalDefault('noticeAcknowledgedVersion', -1)).toBe(false);
        expect(settings.setChallengeOverride('noticeAcknowledgedVersion', '77', 1)).toBe(false);
    });
});
