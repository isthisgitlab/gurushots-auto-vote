import { startupDelaySeconds, startupResumeAt } from '../../src/ts/scheduling/startupDelay';
import { DEFAULT_STARTUP_DELAY_SECONDS, MAX_STARTUP_DELAY_SECONDS } from '../../src/ts/settings/limits';

const LAUNCH = 1_700_000_000_000;

describe('startupDelaySeconds', () => {
    test.each([
        [0, 0],
        [45, 45],
        [MAX_STARTUP_DELAY_SECONDS, MAX_STARTUP_DELAY_SECONDS],
        [-5, 0],
        [MAX_STARTUP_DELAY_SECONDS + 1, MAX_STARTUP_DELAY_SECONDS],
    ])('%p reads as %p', (value, expected) => {
        expect(startupDelaySeconds(value)).toBe(expected);
    });

    test.each([[null], [undefined], ['60'], [1.5], [Number.NaN], [Infinity], [{}]])(
        '%p falls back to the default, so the hold fails closed',
        (value) => {
            expect(startupDelaySeconds(value)).toBe(DEFAULT_STARTUP_DELAY_SECONDS);
        },
    );
});

describe('startupResumeAt', () => {
    test('the resume time is the launch plus the delay', () => {
        expect(startupResumeAt(LAUNCH, 45)).toBe(LAUNCH + 45_000);
        expect(startupResumeAt(LAUNCH, 0)).toBe(LAUNCH);
    });

    test('an unreadable delay holds for the default', () => {
        expect(startupResumeAt(LAUNCH, null)).toBe(LAUNCH + DEFAULT_STARTUP_DELAY_SECONDS * 1000);
        expect(startupResumeAt(LAUNCH, 'x')).toBe(LAUNCH + DEFAULT_STARTUP_DELAY_SECONDS * 1000);
    });
});
