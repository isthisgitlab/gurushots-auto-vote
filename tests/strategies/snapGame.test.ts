/**
 * runSnapGame (src/ts/strategies/real/snapGame.ts): every way the Snap game stops, resuming from the server's
 * position, the per-photo pacing, and that the classic game is never opened.
 */

jest.mock('../../src/ts/api/turbo', () => ({
    startTurboSession: jest.fn(),
    submitSnapVote: jest.fn(),
    getChallengeTurbo: jest.fn(),
}));
jest.mock('../../src/ts/services/visionVerifier', () => ({
    hasBundledModel: jest.fn(),
    judgeSnapImage: jest.fn(),
    snapPrompts: jest.fn(),
    SNAP_CAPTION_MAX_CHARS: 200,
}));
jest.mock('../../src/ts/settings', () => ({ __esModule: true, getEffectiveSetting: jest.fn() }));
jest.mock('../../src/ts/timing', () => ({
    sleep: jest.fn(() => Promise.resolve()),
    getRandomDelay: jest.fn(() => 4000),
}));

import turboModule = require('../../src/ts/api/turbo');
import visionModule = require('../../src/ts/services/visionVerifier');
import settingsModule = require('../../src/ts/settings');
import timingModule = require('../../src/ts/timing');
import cancellation = require('../../src/ts/voting/cancellation');
import logger = require('../../src/ts/logger');
import { __resetSnapTransientRunsForTests, runSnapGame } from '../../src/ts/strategies/real/snapGame';
import { __resetSnapUnavailableForTests, isSnapUnavailable } from '../../src/ts/services/turboRunLock';
import type { CategoryLogger } from '../../src/ts/logger';
import type { Challenge, SnapVoteResult, TurboSession } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const turbo = jest.mocked(turboModule);
const vision = jest.mocked(visionModule);
const settings = jest.mocked(settingsModule);
const timing = jest.mocked(timingModule);

const CHALLENGE = invalid<Challenge>({ id: 77, title: 'Snap Test' });
const CAPTION = 'Does the soft, even light look natural?';

const snapSession = (position = 0, count = 3): Extract<TurboSession, { kind: 'snap' }> => ({
    kind: 'snap',
    sessionId: 'sess',
    position,
    caption: CAPTION,
    images: Array.from({ length: count }, (_, i) => ({ imageId: `img${i}`, memberId: `m${i}` })),
});

const landed = (overrides: Partial<SnapVoteResult> = {}): SnapVoteResult => ({
    ok: true,
    completed: false,
    communityPct: 60,
    errorCode: null,
    unclear: false,
    serverAnswered: true,
    ...overrides,
});

const judgment = { answer: 'yes', yesLogit: 1.234, noLogit: -0.5 } as const;

const debugs = () =>
    jest
        .mocked(logger.withCategory)
        .mock.results.flatMap((r) => jest.mocked(r.value as CategoryLogger).debug.mock.calls.map((call) => call[0]));

const warnings = () =>
    jest
        .mocked(logger.withCategory)
        .mock.results.flatMap((r) => jest.mocked(r.value as CategoryLogger).warning.mock.calls.map((call) => call[0]));

const infos = () =>
    jest
        .mocked(logger.withCategory)
        .mock.results.flatMap((r) => jest.mocked(r.value as CategoryLogger).info.mock.calls.map((call) => call[0]));

// A clock that advances by the given step per reading.
const steppedClock = (stepMs: number) => {
    let t = 0;
    return () => {
        const now = t;
        t += stepMs;
        return now;
    };
};

const sleeps: number[] = [];
const deps = (overrides: Parameters<typeof runSnapGame>[2] = {}) => ({
    now: () => 0,
    pace: () => 4000,
    sleep: async (ms: number) => {
        sleeps.push(ms);
    },
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    sleeps.length = 0;
    cancellation.reset();
    __resetSnapUnavailableForTests();
    __resetSnapTransientRunsForTests();
    settings.getEffectiveSetting.mockReturnValue(false);
    vision.hasBundledModel.mockResolvedValue(true);
    vision.snapPrompts.mockReturnValue({ yes: 'y', no: 'n' });
    vision.judgeSnapImage.mockResolvedValue(judgment);
    turbo.startTurboSession.mockResolvedValue(snapSession());
    turbo.submitSnapVote.mockResolvedValue(landed());
});

describe('runSnapGame', () => {
    test('answers every photo and wins on the last answer', async () => {
        turbo.submitSnapVote
            .mockResolvedValueOnce(landed({ communityPct: 50 }))
            .mockResolvedValueOnce(landed({ communityPct: 70 }))
            .mockResolvedValueOnce(landed({ communityPct: 90, completed: true }));

        const result = await runSnapGame(CHALLENGE, 'tok', deps());

        expect(result).toEqual({ answered: 3, total: 3, meanAgreement: 70, won: true, stopReason: 'completed' });
        expect(turbo.startTurboSession).toHaveBeenCalledWith(77, 'tok');
        expect(turbo.submitSnapVote.mock.calls).toEqual([
            ['sess', 'img0', 'yes', 'tok'],
            ['sess', 'img1', 'yes', 'tok'],
            ['sess', 'img2', 'yes', 'tok'],
        ]);
        expect(vision.judgeSnapImage).toHaveBeenCalledWith(CAPTION, { imageId: 'img0', memberId: 'm0' });
        expect(turbo.getChallengeTurbo).not.toHaveBeenCalled();
        expect(infos()).toContain('[Challenge 77: Snap Test] Snap 1/3: yes (yes=1.23 no=-0.50) community=50%');
    });

    test('sends the no answer when the judge says no', async () => {
        vision.judgeSnapImage.mockResolvedValue({ answer: 'no', yesLogit: -1, noLogit: 2 });
        turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

        await runSnapGame(CHALLENGE, 'tok', deps());

        expect(turbo.submitSnapVote).toHaveBeenCalledWith('sess', 'img0', 'no', 'tok');
    });

    test('resumes from the position the server reports', async () => {
        turbo.startTurboSession.mockResolvedValue(snapSession(2, 3));
        turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

        const result = await runSnapGame(CHALLENGE, 'tok', deps());

        expect(result).toEqual({ answered: 1, total: 3, meanAgreement: 60, won: true, stopReason: 'completed' });
        expect(turbo.submitSnapVote).toHaveBeenCalledTimes(1);
        expect(turbo.submitSnapVote).toHaveBeenCalledWith('sess', 'img2', 'yes', 'tok');
    });

    test('has no mean agreement when no answer carried one', async () => {
        turbo.submitSnapVote.mockResolvedValue(landed({ communityPct: null, completed: true }));

        const result = await runSnapGame(CHALLENGE, 'tok', deps());

        expect(result.meanAgreement).toBeNull();
        expect(infos().some((line) => line.endsWith('community=n/a%'))).toBe(true);
    });

    describe('without the vision model and snapYesWithoutModel on', () => {
        beforeEach(() => {
            vision.hasBundledModel.mockResolvedValue(false);
            settings.getEffectiveSetting.mockImplementation((key) => key === 'snapYesWithoutModel');
        });

        test('answers yes to every photo, never judges, and wins on the last answer', async () => {
            turbo.submitSnapVote
                .mockResolvedValueOnce(landed({ communityPct: 50 }))
                .mockResolvedValueOnce(landed({ communityPct: 70 }))
                .mockResolvedValueOnce(landed({ communityPct: 90, completed: true }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({ answered: 3, total: 3, meanAgreement: 70, won: true, stopReason: 'completed' });
            expect(turbo.submitSnapVote.mock.calls).toEqual([
                ['sess', 'img0', 'yes', 'tok'],
                ['sess', 'img1', 'yes', 'tok'],
                ['sess', 'img2', 'yes', 'tok'],
            ]);
            expect(vision.judgeSnapImage).not.toHaveBeenCalled();
            expect(isSnapUnavailable(77)).toBe(false);
            expect(infos()).toEqual([
                expect.stringContaining('Snap 1/3: yes (no vision model) community=50%'),
                expect.stringContaining('Snap 2/3: yes (no vision model) community=70%'),
                expect.stringContaining('Snap 3/3: yes (no vision model) community=90%'),
            ]);
        });

        test('plays a question the model could not parse', async () => {
            vision.snapPrompts.mockReturnValue(null);
            turbo.startTurboSession.mockResolvedValue({ ...snapSession(0, 1), caption: 'Unreadable question' });
            turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({ answered: 1, total: 1, meanAgreement: 60, won: true, stopReason: 'completed' });
            expect(vision.snapPrompts).not.toHaveBeenCalled();
            expect(isSnapUnavailable(77)).toBe(false);
        });

        test('resumes from the server position at the usual pace', async () => {
            turbo.startTurboSession.mockResolvedValue(snapSession(2, 3));
            turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(turbo.submitSnapVote.mock.calls).toEqual([['sess', 'img2', 'yes', 'tok']]);
            expect(sleeps).toEqual([4000]);
        });

        test('keeps the stop handling of the model path', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ ok: false, serverAnswered: false }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result.stopReason).toBe('request-failed');
            expect(isSnapUnavailable(77)).toBe(false);
        });

        test('cancelled after the first answer keeps what landed', async () => {
            let cancelled = false;
            turbo.submitSnapVote.mockImplementationOnce(async () => {
                cancelled = true;
                return landed({ communityPct: 40 });
            });

            const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => cancelled }));

            expect(result).toEqual({ answered: 1, total: 3, meanAgreement: 40, won: false, stopReason: 'cancelled' });
            expect(turbo.submitSnapVote).toHaveBeenCalledTimes(1);
            expect(vision.judgeSnapImage).not.toHaveBeenCalled();
        });

        test('vote-unclear never resends', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ ok: false, unclear: true, communityPct: null }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toMatchObject({ answered: 0, won: false, stopReason: 'vote-unclear' });
            expect(turbo.submitSnapVote).toHaveBeenCalledTimes(1);
            expect(isSnapUnavailable(77)).toBe(false);
        });
    });

    test('with the model the model answers whatever snapYesWithoutModel says', async () => {
        settings.getEffectiveSetting.mockReturnValue(true);
        vision.judgeSnapImage.mockResolvedValue({ answer: 'no', yesLogit: -1, noLogit: 2 });
        turbo.startTurboSession.mockResolvedValue(snapSession(0, 1));
        turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

        await runSnapGame(CHALLENGE, 'tok', deps());

        expect(vision.judgeSnapImage).toHaveBeenCalledTimes(1);
        expect(turbo.submitSnapVote.mock.calls).toEqual([['sess', 'img0', 'no', 'tok']]);
        expect(infos()).toEqual([expect.stringContaining('no (yes=-1.00 no=2.00)')]);
    });

    describe('pacing', () => {
        test('waits so that judging plus the wait reaches the target', async () => {
            turbo.submitSnapVote.mockResolvedValueOnce(landed()).mockResolvedValueOnce(landed({ completed: true }));
            turbo.startTurboSession.mockResolvedValue(snapSession(0, 2));
            // Each image reads the clock twice (start, after judging): 1500 ms of judging against a 4000 ms target.
            const now = steppedClock(1500);
            const pace = jest.fn(() => 4000);

            await runSnapGame(CHALLENGE, 'tok', deps({ now, pace }));

            expect(pace).toHaveBeenCalledTimes(2);
            expect(sleeps).toEqual([2500, 2500]);
        });

        test('does not wait when judging alone took the target', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

            await runSnapGame(CHALLENGE, 'tok', deps({ now: steppedClock(5000) }));

            expect(sleeps).toEqual([]);
            expect(turbo.submitSnapVote).toHaveBeenCalledTimes(1);
        });

        test('draws its target between 3 and 6 seconds with the real timing helpers by default', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));
            let t = 0;
            const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => (t += 100));

            await runSnapGame(CHALLENGE, 'tok');

            dateNow.mockRestore();
            expect(timing.getRandomDelay).toHaveBeenCalledWith(3000, 6000);
            // Target 4000 minus the 100 ms the clock advanced between its two readings.
            expect(timing.sleep).toHaveBeenCalledWith(3900);
        });
    });

    describe('stop reasons', () => {
        test('no-model with snapYesWithoutModel off: no request is made, nothing is marked, the line is debug', async () => {
            vision.hasBundledModel.mockResolvedValue(false);

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({ answered: 0, total: 0, meanAgreement: null, won: false, stopReason: 'no-model' });
            expect(settings.getEffectiveSetting).toHaveBeenCalledWith('snapYesWithoutModel', null);
            expect(isSnapUnavailable(77)).toBe(false);
            expect(turbo.startTurboSession).not.toHaveBeenCalled();
            expect(turbo.submitSnapVote).not.toHaveBeenCalled();
            expect(turbo.getChallengeTurbo).not.toHaveBeenCalled();
            expect(debugs()).toEqual([expect.stringContaining('needs the vision model')]);
            expect(infos()).toEqual([]);
        });

        test('request-failed when the session cannot be opened', async () => {
            turbo.startTurboSession.mockResolvedValue(null);

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result.stopReason).toBe('request-failed');
            expect(isSnapUnavailable(77)).toBe(false);
            expect(warnings()).toEqual([expect.stringContaining('could not open a usable Snap session')]);
        });

        test('withdrawn: a classic session marks Snap unavailable and never opens the classic game', async () => {
            turbo.startTurboSession.mockResolvedValue({ kind: 'classic' });

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({ answered: 0, total: 0, meanAgreement: null, won: false, stopReason: 'withdrawn' });
            expect(isSnapUnavailable(77)).toBe(true);
            expect(turbo.getChallengeTurbo).not.toHaveBeenCalled();
            expect(turbo.submitSnapVote).not.toHaveBeenCalled();
        });

        test('unparsed-caption: marks Snap unavailable and logs the caption cut to 200 characters', async () => {
            vision.snapPrompts.mockReturnValue(null);

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({
                answered: 0,
                total: 3,
                meanAgreement: null,
                won: false,
                stopReason: 'unparsed-caption',
            });
            expect(isSnapUnavailable(77)).toBe(true);
            expect(vision.snapPrompts).toHaveBeenCalledWith(CAPTION);
            expect(warnings()).toEqual([expect.stringContaining(JSON.stringify(CAPTION))]);
            expect(turbo.submitSnapVote).not.toHaveBeenCalled();
        });

        test('judge-failed: stops before sending anything for that photo', async () => {
            vision.judgeSnapImage.mockResolvedValue(null);

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result.stopReason).toBe('judge-failed');
            expect(result.won).toBe(false);
            expect(turbo.submitSnapVote).not.toHaveBeenCalled();
        });

        test('cancelled: stops by return before judging', async () => {
            const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => true }));

            expect(result).toEqual({ answered: 0, total: 3, meanAgreement: null, won: false, stopReason: 'cancelled' });
            expect(vision.judgeSnapImage).not.toHaveBeenCalled();
        });

        test('cancelled midway keeps what already landed', async () => {
            let cancelled = false;
            turbo.submitSnapVote.mockImplementationOnce(async () => {
                cancelled = true;
                return landed({ communityPct: 40 });
            });

            const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => cancelled }));

            expect(result).toEqual({ answered: 1, total: 3, meanAgreement: 40, won: false, stopReason: 'cancelled' });
            expect(turbo.submitSnapVote).toHaveBeenCalledTimes(1);
        });

        test('a run that passes no isCancelled (a manual one) is not stopped by the voting-cancel flag', async () => {
            cancellation.setCancelled(true);
            turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toMatchObject({ won: true, stopReason: 'completed' });
        });

        test('vote-unclear: never resends', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ ok: false, unclear: true, communityPct: null }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result.stopReason).toBe('vote-unclear');
            expect(result.answered).toBe(0);
            expect(turbo.submitSnapVote).toHaveBeenCalledTimes(1);
            expect(isSnapUnavailable(77)).toBe(false);
        });

        test('unavailable: error 1105 marks Snap unavailable', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ ok: false, errorCode: 1105, communityPct: null }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result.stopReason).toBe('unavailable');
            expect(isSnapUnavailable(77)).toBe(true);
        });

        test('an over-long unparsed caption is logged cut to 200 characters', async () => {
            const long = 'x'.repeat(500);
            turbo.startTurboSession.mockResolvedValue({ ...snapSession(), caption: long });
            vision.snapPrompts.mockReturnValue(null);

            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(warnings()).toEqual([expect.stringContaining(JSON.stringify('x'.repeat(200)))]);
            expect(warnings()[0]).not.toContain('x'.repeat(201));
        });

        test('request-failed: an answer the server refused marks Snap unavailable', async () => {
            turbo.submitSnapVote
                .mockResolvedValueOnce(landed())
                .mockResolvedValueOnce(landed({ ok: false, errorCode: 9, communityPct: null }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({
                answered: 1,
                total: 3,
                meanAgreement: 60,
                won: false,
                stopReason: 'request-failed',
            });
            expect(isSnapUnavailable(77)).toBe(true);
        });

        test('request-failed when every photo is answered but no win is reported', async () => {
            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({
                answered: 3,
                total: 3,
                meanAgreement: 60,
                won: false,
                stopReason: 'request-failed',
            });
            expect(warnings()).toEqual([expect.stringContaining('ran out of photos')]);
        });

        test('request-failed at once when the session has nothing left to answer', async () => {
            turbo.startTurboSession.mockResolvedValue(snapSession(3, 3));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({
                answered: 0,
                total: 3,
                meanAgreement: null,
                won: false,
                stopReason: 'request-failed',
            });
            expect(vision.judgeSnapImage).not.toHaveBeenCalled();
        });

        test('request-failed: an answer that got no response from the server leaves Snap available', async () => {
            turbo.submitSnapVote
                .mockResolvedValueOnce(landed())
                .mockResolvedValueOnce(landed({ ok: false, serverAnswered: false, communityPct: null }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({
                answered: 1,
                total: 3,
                meanAgreement: 60,
                won: false,
                stopReason: 'request-failed',
            });
            expect(isSnapUnavailable(77)).toBe(false);
            expect(warnings()).toEqual([expect.stringContaining('got no answer from the server')]);
        });
    });

    describe('transient failures', () => {
        const noSession = () => turbo.startTurboSession.mockResolvedValue(null);

        test('the third run in a row that lands nothing marks Snap unavailable and says so', async () => {
            vision.judgeSnapImage.mockResolvedValue(null);

            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            expect(isSnapUnavailable(77)).toBe(false);
            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(isSnapUnavailable(77)).toBe(true);
            expect(warnings().filter((line) => line.includes('3 runs in a row'))).toHaveLength(1);
        });

        test('session failures and transport refusals count the same way', async () => {
            noSession();
            await runSnapGame(CHALLENGE, 'tok', deps());
            turbo.startTurboSession.mockResolvedValue(snapSession());
            turbo.submitSnapVote.mockResolvedValue(landed({ ok: false, serverAnswered: false, communityPct: null }));
            await runSnapGame(CHALLENGE, 'tok', deps());
            expect(isSnapUnavailable(77)).toBe(false);
            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(isSnapUnavailable(77)).toBe(true);
        });

        test('a landed answer in between starts the count again', async () => {
            noSession();
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            turbo.startTurboSession.mockResolvedValue(snapSession());
            turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));
            await runSnapGame(CHALLENGE, 'tok', deps());
            noSession();
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(isSnapUnavailable(77)).toBe(false);
        });

        test('a run that lands answers before failing does not count', async () => {
            vision.judgeSnapImage.mockResolvedValue(null);

            for (let run = 0; run < 4; run++) {
                vision.judgeSnapImage.mockResolvedValueOnce(judgment).mockResolvedValue(null);
                await runSnapGame(CHALLENGE, 'tok', deps());
            }

            expect(isSnapUnavailable(77)).toBe(false);
        });

        test('running out of photos counts although answers landed, and the unusable session after it adds up', async () => {
            await runSnapGame(CHALLENGE, 'tok', deps());
            noSession();
            await runSnapGame(CHALLENGE, 'tok', deps());
            expect(isSnapUnavailable(77)).toBe(false);
            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(isSnapUnavailable(77)).toBe(true);
        });

        test('three runs in a row that answer every photo without a win mark Snap unavailable', async () => {
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            expect(isSnapUnavailable(77)).toBe(false);
            const third = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(third.answered).toBe(3);
            expect(isSnapUnavailable(77)).toBe(true);
        });

        test('a win between runs that ran out of photos starts the count again', async () => {
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            turbo.submitSnapVote.mockResolvedValueOnce(landed()).mockResolvedValueOnce(landed());
            turbo.submitSnapVote.mockResolvedValueOnce(landed({ completed: true }));
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(isSnapUnavailable(77)).toBe(false);
        });

        test('a 4xx answer with no body is transient: the first run leaves Snap available', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ ok: false, serverAnswered: false, communityPct: null }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toMatchObject({ answered: 0, stopReason: 'request-failed' });
            expect(isSnapUnavailable(77)).toBe(false);
        });

        test('counts are kept per challenge', async () => {
            noSession();
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(invalid<Challenge>({ id: 78, title: 'Other' }), 'tok', deps());

            expect(isSnapUnavailable(77)).toBe(false);
            expect(isSnapUnavailable(78)).toBe(false);
        });
    });
});
