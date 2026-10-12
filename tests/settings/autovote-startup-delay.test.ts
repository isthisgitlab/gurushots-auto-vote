/**
 * The auto-resume hold (`autovoteStartupDelay`): global only, whole seconds from 0 (off) to an hour,
 * 60 by default.
 */

import settings = require('../../src/ts/settings');
import type * as limitsModule from '../../src/ts/settings/limits';
import type { AndroidHeadlessStore } from '../../src/ts/types/settings';

const { DEFAULT_STARTUP_DELAY_SECONDS, MAX_STARTUP_DELAY_SECONDS } =
    require('../../src/ts/settings/limits') as typeof limitsModule;

jest.mock('../../src/ts/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => category),
    };
});

const g = globalThis as typeof globalThis & { __GS_HEADLESS__?: boolean; AndroidHeadlessStore?: AndroidHeadlessStore };

beforeEach(() => {
    g.__GS_HEADLESS__ = true;
    const store: AndroidHeadlessStore & { value: string | null } = {
        value: null,
        read: jest.fn(() => store.value),
        write: jest.fn((d) => {
            store.value = d;
        }),
        readKey: () => null,
        writeKey: () => undefined,
    };
    g.AndroidHeadlessStore = store;
});

afterEach(() => {
    delete g.__GS_HEADLESS__;
    delete g.AndroidHeadlessStore;
});

describe('autovoteStartupDelay', () => {
    test('is 60 seconds by default, and an hour at most', () => {
        expect(settings.getEffectiveSetting('autovoteStartupDelay', null)).toBe(60);
        expect(DEFAULT_STARTUP_DELAY_SECONDS).toBe(60);
        expect(MAX_STARTUP_DELAY_SECONDS).toBe(3600);
        expect(settings.SETTINGS_SCHEMA.autovoteStartupDelay).toEqual(
            expect.objectContaining({ default: 60, min: 0, max: 3600, unit: 'app.unitSeconds', perChallenge: false }),
        );
    });

    test.each([0, 1, 60, 3600])('accepts %p seconds', (seconds) => {
        expect(settings.setGlobalDefault('autovoteStartupDelay', seconds)).toBe(true);
        expect(settings.getEffectiveSetting('autovoteStartupDelay', null)).toBe(seconds);
    });

    test.each([[-1], [3601], [1.5], ['60'], [null], [Number.NaN]])('refuses %p', (value) => {
        expect(settings.setGlobalDefault('autovoteStartupDelay', value)).toBe(false);
        expect(settings.getEffectiveSetting('autovoteStartupDelay', null)).toBe(60);
    });

    test('is global only: no challenge can hold its own', () => {
        expect(settings.setChallengeOverride('autovoteStartupDelay', '7', 30)).toBe(false);
    });
});
