/**
 * The Snap-without-the-model switch (`snapYesWithoutModel`): global only, a boolean in the turbo group, off by default.
 */

import settings = require('../../src/ts/settings');
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';

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

beforeEach(() => {
    installHeadlessStore();
});

afterEach(() => {
    removeHeadlessStore();
});

describe('snapYesWithoutModel', () => {
    test('is off by default, global only, in the turbo group', () => {
        expect(settings.getEffectiveSetting('snapYesWithoutModel', null)).toBe(false);
        expect(settings.SETTINGS_SCHEMA.snapYesWithoutModel).toEqual(
            expect.objectContaining({
                type: 'boolean',
                default: false,
                perChallenge: false,
                group: 'turbo',
                label: 'app.snapYesWithoutModel',
                description: 'app.snapYesWithoutModelDesc',
            }),
        );
    });

    test.each([[true], [false]])('accepts %p and reads it back', (value) => {
        expect(settings.setGlobalDefault('snapYesWithoutModel', value)).toBe(true);
        expect(settings.getEffectiveSetting('snapYesWithoutModel', null)).toBe(value);
    });

    test.each([['true'], [1], [null]])('refuses %p', (value) => {
        expect(settings.setGlobalDefault('snapYesWithoutModel', value)).toBe(false);
        expect(settings.getEffectiveSetting('snapYesWithoutModel', null)).toBe(false);
    });
});
