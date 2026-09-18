/**
 * Schema validation for the voting-pause keys.
 *
 * The pause deliberately shares scheduled fill's validators (timeOfDayList,
 * beforeEndList, windowMinutes) rather than declaring its own — these tests
 * pin that the sharing is actually wired up, so a future bounds change to one
 * feature can't silently leave the other behind.
 */

const { validateSetting, getValidationError, SETTINGS_SCHEMA } = require('../../src/js/settings/schema');

describe('voting pause schema validation', () => {
    test('all four keys exist, are per-challenge, and sit in the votingPause group', () => {
        const keys = ['useVotingPause', 'votingPauseTime', 'votingPauseBeforeEnd', 'votingPauseDurationMinutes'];
        for (const key of keys) {
            expect(SETTINGS_SCHEMA[key]).toBeDefined();
            expect(SETTINGS_SCHEMA[key].perChallenge).toBe(true);
            expect(SETTINGS_SCHEMA[key].group).toBe('votingPause');
        }
    });

    test('defaults are inert: feature off, both triggers empty', () => {
        expect(SETTINGS_SCHEMA.useVotingPause.default).toBe(false);
        expect(SETTINGS_SCHEMA.votingPauseTime.default).toEqual([]);
        expect(SETTINGS_SCHEMA.votingPauseBeforeEnd.default).toEqual([]);
        expect(SETTINGS_SCHEMA.votingPauseDurationMinutes.default).toBe(240);
    });

    test('the field types drive the existing list editors', () => {
        expect(SETTINGS_SCHEMA.votingPauseTime.type).toBe('timeOfDayList');
        expect(SETTINGS_SCHEMA.votingPauseBeforeEnd.type).toBe('timeList');
    });

    describe('votingPauseTime (list of daily HH:MM starts)', () => {
        test.each([[[]], [['00:00']], [['01:30']], [['01:30', '13:00']]])('accepts %p', (value) => {
            expect(validateSetting('votingPauseTime', value)).toBe(true);
        });

        test.each([[['1:30']], [['24:00']], [['01:60']], [['01:30:00']], [[130]], ['01:30']])('rejects %p', (value) => {
            expect(validateSetting('votingPauseTime', value)).toBe(false);
        });

        test('rejects duplicates', () => {
            expect(validateSetting('votingPauseTime', ['01:30', '01:30'])).toBe(false);
            expect(getValidationError('votingPauseTime', ['01:30', '01:30'])).toMatch(/duplicate/i);
        });

        test('rejects more than the shared entry cap', () => {
            const tooMany = ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00'];
            expect(validateSetting('votingPauseTime', tooMany)).toBe(false);
        });
    });

    describe('votingPauseBeforeEnd (list of seconds-before-close starts)', () => {
        test.each([[[]], [[7200]], [[3600, 7200]]])('accepts %p', (value) => {
            expect(validateSetting('votingPauseBeforeEnd', value)).toBe(true);
        });

        test.each([[[0]], [[-1]], [[1.5]], [['7200']], [[2592001]]])('rejects %p', (value) => {
            expect(validateSetting('votingPauseBeforeEnd', value)).toBe(false);
        });

        test('rejects duplicates', () => {
            expect(validateSetting('votingPauseBeforeEnd', [7200, 7200])).toBe(false);
        });
    });

    describe('votingPauseDurationMinutes', () => {
        test.each([5, 60, 270, 720])('accepts %p', (value) => {
            expect(validateSetting('votingPauseDurationMinutes', value)).toBe(true);
        });

        test.each([4, 0, -1, 721, 60.5, '60'])('rejects %p', (value) => {
            expect(validateSetting('votingPauseDurationMinutes', value)).toBe(false);
        });

        test('the reported 01:30-06:00 night pause is expressible', () => {
            expect(validateSetting('votingPauseTime', ['01:30'])).toBe(true);
            expect(validateSetting('votingPauseDurationMinutes', 270)).toBe(true);
        });
    });
});
