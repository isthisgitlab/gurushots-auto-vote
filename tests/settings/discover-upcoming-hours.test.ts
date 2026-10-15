/**
 * The Discover look-ahead window (`discoverUpcomingHours`): global only, whole hours from 0 (off)
 * to a week, 24 by default.
 */

import settings = require('../../src/ts/settings');
import type * as limitsModule from '../../src/ts/settings/limits';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';

const { MAX_UPCOMING_HOURS } = require('../../src/ts/settings/limits') as typeof limitsModule;

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

describe('discoverUpcomingHours', () => {
    test('is 24 hours by default, and a week at most', () => {
        expect(settings.getEffectiveSetting('discoverUpcomingHours', null)).toBe(24);
        expect(MAX_UPCOMING_HOURS).toBe(168);
        expect(settings.SETTINGS_SCHEMA.discoverUpcomingHours).toEqual(
            expect.objectContaining({ default: 24, min: 0, max: 168, unit: 'app.unitHours', perChallenge: false }),
        );
    });

    test.each([0, 1, 24, 100, 168])('accepts %p hours', (hours) => {
        expect(settings.setGlobalDefault('discoverUpcomingHours', hours)).toBe(true);
        expect(settings.getEffectiveSetting('discoverUpcomingHours', null)).toBe(hours);
    });

    test.each([[-1], [169], [1.5], ['24'], [null], [Number.NaN]])('refuses %p', (value) => {
        expect(settings.setGlobalDefault('discoverUpcomingHours', value)).toBe(false);
        expect(settings.getEffectiveSetting('discoverUpcomingHours', null)).toBe(24);
    });

    test('is global only: no challenge can hold its own', () => {
        expect(settings.setChallengeOverride('discoverUpcomingHours', '7', 6)).toBe(false);
    });
});
