/**
 * runSnapGame (src/ts/core/strategies/real/snapGame.ts): every way the Snap game stops, resuming from the server's
 * position, the per-photo pacing, and that the classic game is never opened.
 */

jest.mock('../../src/ts/core/api/turbo', () => ({
    startTurboSession: jest.fn(),
    submitSnapScore: jest.fn(),
    submitSnapVote: jest.fn(),
    getChallengeTurbo: jest.fn(),
}));
jest.mock('../../src/ts/core/services/visionVerifier', () => ({
    hasBundledModel: jest.fn(),
    judgeSnapImage: jest.fn(),
    judgeSnapVideoFrames: jest.fn(),
    snapPrompts: jest.fn(),
    SNAP_CAPTION_MAX_CHARS: 200,
}));
jest.mock('../../src/ts/core/settings', () => ({ __esModule: true, getEffectiveSetting: jest.fn() }));
jest.mock('../../src/ts/core/timing', () => ({
    sleep: jest.fn(() => new Promise<void>((resolve) => setImmediate(resolve))),
    getRandomDelay: jest.fn(() => 4000),
}));
jest.mock('../../src/ts/core/platform/port', () => ({ platform: jest.fn() }));

import turboModule = require('../../src/ts/core/api/turbo');
import visionModule = require('../../src/ts/core/services/visionVerifier');
import settingsModule = require('../../src/ts/core/settings');
import timingModule = require('../../src/ts/core/timing');
import cancellation = require('../../src/ts/core/voting/cancellation');
import logger = require('../../src/ts/core/logger');
import platformModule = require('../../src/ts/core/platform/port');
import { __resetSnapTransientRunsForTests, runSnapGame } from '../../src/ts/core/strategies/real/snapGame';
import {
    __resetSnapUnavailableForTests,
    isSnapAutoCoolingDown,
    isSnapUnavailable,
} from '../../src/ts/core/services/turboRunLock';
import type { CategoryLogger } from '../../src/ts/core/logger';
import type { SnapJudgment } from '../../src/ts/core/services/visionVerifier';
import type { Challenge, SnapVoteResult, TurboSession } from '../../src/ts/core/types/gurushots';
import type { SnapScoreResult } from '../../src/ts/core/types/gurushots/voting';
import { invalid } from '../helpers/invalid';

const turbo = jest.mocked(turboModule);
const vision = jest.mocked(visionModule);
const settings = jest.mocked(settingsModule);
const timing = jest.mocked(timingModule);
const platform = jest.mocked(platformModule.platform);
const videoFrames = jest.fn<Promise<string[]>, [string, number, readonly number[], AbortSignal?]>();

const CHALLENGE = invalid<Challenge>({ id: 77, title: 'Snap Test' });
const CAPTION = 'Does the soft, even light look natural?';

const snapSession = (position = 0, count = 3): Extract<TurboSession, { kind: 'snap' }> => ({
    kind: 'snap',
    sessionId: 'sess',
    position,
    caption: CAPTION,
    images: Array.from({ length: count }, (_, i) => ({ imageId: `img${i}`, memberId: `m${i}` })),
});

const scoreSession = (position = 0, count = 1): Extract<TurboSession, { kind: 'score' }> => ({
    kind: 'score',
    sessionId: 'score-sess',
    position,
    caption: 'Rate overall picture quality.',
    maxScore: 7,
    images: Array.from({ length: count }, (_, index) => ({
        imageId: `video${index}`,
        memberId: `m${index}`,
        durationMs: 5000,
        mediaUrl: `https://media.gurushots.com/clip${index}.mp4`,
    })),
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

const scored = (overrides: Partial<SnapScoreResult> = {}): SnapScoreResult => ({
    ok: true,
    completed: false,
    communityAvg: 6,
    tooEarly: false,
    retryAfterMs: null,
    sessionEnded: false,
    restartRequired: false,
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

// The cancel watcher and the sliced waits sleep in pieces of at most this many ms.
const POLL_MS = 250;
// Every sleep ends on a macrotask: the watcher loop of a judgment that never settles must not starve the event loop.
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleeps: number[] = [];
// What a wait of `ms` records: whole slices and the remainder.
const slicesOf = (ms: number): number[] => [
    ...Array<number>(Math.floor(ms / POLL_MS)).fill(POLL_MS),
    ...(ms % POLL_MS === 0 ? [] : [ms % POLL_MS]),
];
const deps = (overrides: Parameters<typeof runSnapGame>[2] = {}) => ({
    now: () => 0,
    pace: () => 4000,
    sleep: async (ms: number) => {
        sleeps.push(ms);
        await nextTask();
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
    turbo.submitSnapScore.mockResolvedValue(scored());
    turbo.submitSnapVote.mockResolvedValue(landed());
    videoFrames.mockResolvedValue(['frame-a', 'frame-b', 'frame-c']);
    platform.mockReturnValue(invalid<ReturnType<typeof platformModule.platform>>({ assets: { videoFrames } }));
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
        expect(vision.judgeSnapImage).toHaveBeenCalledWith(
            CAPTION,
            { imageId: 'img0', memberId: 'm0' },
            expect.any(AbortSignal),
        );
        expect(turbo.getChallengeTurbo).not.toHaveBeenCalled();
        expect(infos()).toContain('[Challenge 77: Snap Test] Snap 1/3: yes (yes=1.23 no=-0.50) community=50%');
    });

    test('sends the no answer when the judge says no', async () => {
        vision.judgeSnapImage.mockResolvedValue({ answer: 'no', yesLogit: -1, noLogit: 2 });
        turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

        await runSnapGame(CHALLENGE, 'tok', deps());

        expect(turbo.submitSnapVote).toHaveBeenCalledWith('sess', 'img0', 'no', 'tok');
    });

    test('cancels after the photo pacing wait and does not submit', async () => {
        let cancelled = false;
        const result = await runSnapGame(
            CHALLENGE,
            'tok',
            deps({
                isCancelled: () => cancelled,
                pace: () => 4100,
                // The cancel watcher and the full slices are skipped: only the last slice of the wait sets the flag.
                sleep: async (ms) => {
                    if (ms !== POLL_MS) cancelled = true;
                    await nextTask();
                },
            }),
        );

        expect(result.stopReason).toBe('cancelled');
        expect(turbo.submitSnapVote).not.toHaveBeenCalled();
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

    describe('scored video sessions', () => {
        beforeEach(() => {
            vision.hasBundledModel.mockResolvedValue(false);
            settings.getEffectiveSetting.mockImplementation((key) => key === 'snapYesWithoutModel');
            turbo.startTurboSession.mockResolvedValue(scoreSession());
        });

        test('uses the maximum score without a model and waits for clip duration plus pace', async () => {
            turbo.submitSnapScore.mockResolvedValue(scored({ completed: true, communityAvg: 6.5 }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toEqual({ answered: 1, total: 1, meanAgreement: null, won: true, stopReason: 'completed' });
            expect(turbo.submitSnapScore).toHaveBeenCalledWith('score-sess', 'video0', 7, 'tok');
            expect(turbo.submitSnapVote).not.toHaveBeenCalled();
            expect(sleeps).toEqual(slicesOf(9000));
        });

        test('allows an empty score caption with snapYesWithoutModel enabled', async () => {
            turbo.startTurboSession.mockResolvedValue({ ...scoreSession(), caption: '' });
            turbo.submitSnapScore.mockResolvedValue(scored({ completed: true }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toMatchObject({ answered: 1, won: true, stopReason: 'completed' });
            expect(turbo.submitSnapScore).toHaveBeenCalledWith('score-sess', 'video0', 7, 'tok');
            expect(vision.judgeSnapVideoFrames).not.toHaveBeenCalled();
        });

        test('rejects an empty score caption when the model would validate it', async () => {
            vision.hasBundledModel.mockResolvedValue(true);
            turbo.startTurboSession.mockResolvedValue({ ...scoreSession(), caption: '' });

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toMatchObject({ answered: 0, won: false, stopReason: 'unparsed-caption' });
            expect(turbo.submitSnapScore).not.toHaveBeenCalled();
            expect(vision.judgeSnapVideoFrames).not.toHaveBeenCalled();
        });

        test('retries only an explicit too-early response, at most twice', async () => {
            turbo.submitSnapScore
                .mockResolvedValueOnce(scored({ ok: false, tooEarly: true, retryAfterMs: 300, communityAvg: null }))
                .mockResolvedValueOnce(scored({ completed: true }));

            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(turbo.submitSnapScore).toHaveBeenCalledTimes(2);
            expect(sleeps).toEqual([...slicesOf(9000), ...slicesOf(300)]);
        });

        test('uses the bounded minimum retry delay when the server does not provide one', async () => {
            turbo.submitSnapScore
                .mockResolvedValueOnce(scored({ ok: false, tooEarly: true, retryAfterMs: null }))
                .mockResolvedValueOnce(scored({ completed: true, communityAvg: null }));

            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(sleeps).toEqual([...slicesOf(9000), ...slicesOf(100)]);
        });

        test('extracts three video frames and scores them with the model', async () => {
            vision.hasBundledModel.mockResolvedValue(true);
            vision.judgeSnapVideoFrames.mockResolvedValue(4);
            turbo.submitSnapScore.mockResolvedValue(scored({ completed: true }));

            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(videoFrames).toHaveBeenCalledWith(
                'https://media.gurushots.com/clip0.mp4',
                5000,
                [0.2, 0.5, 0.8],
                expect.any(AbortSignal),
            );
            expect(vision.judgeSnapVideoFrames).toHaveBeenCalledWith(
                'Rate overall picture quality.',
                ['frame-a', 'frame-b', 'frame-c'],
                7,
                expect.any(AbortSignal),
            );
            expect(turbo.submitSnapScore).toHaveBeenCalledWith('score-sess', 'video0', 4, 'tok');
        });

        test('resumes the scored session from the server position', async () => {
            turbo.startTurboSession.mockResolvedValue(scoreSession(1, 3));
            turbo.submitSnapScore.mockResolvedValueOnce(scored()).mockResolvedValueOnce(scored({ completed: true }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result).toMatchObject({ answered: 2, total: 3, meanAgreement: null, won: true });
            expect(turbo.submitSnapScore.mock.calls).toEqual([
                ['score-sess', 'video1', 7, 'tok'],
                ['score-sess', 'video2', 7, 'tok'],
            ]);
        });

        test('stops without sending when decoder or inference fails', async () => {
            vision.hasBundledModel.mockResolvedValue(true);
            videoFrames.mockRejectedValueOnce(new Error('decode failed'));

            expect((await runSnapGame(CHALLENGE, 'tok', deps())).stopReason).toBe('judge-failed');
            expect(turbo.submitSnapScore).not.toHaveBeenCalled();
            expect(warnings()).toEqual(['Snap video judgment unavailable: Error: decode failed']);

            videoFrames.mockResolvedValue(['frame-a', 'frame-b', 'frame-c']);
            vision.judgeSnapVideoFrames.mockResolvedValueOnce(null);
            expect((await runSnapGame(CHALLENGE, 'tok', deps())).stopReason).toBe('judge-failed');
            expect(turbo.submitSnapScore).not.toHaveBeenCalled();
        });

        test('cancels after the clip-duration wait and never sends', async () => {
            let cancelled = false;
            const result = await runSnapGame(
                CHALLENGE,
                'tok',
                deps({
                    isCancelled: () => cancelled,
                    sleep: async () => {
                        cancelled = true;
                    },
                }),
            );

            expect(result.stopReason).toBe('cancelled');
            expect(turbo.submitSnapScore).not.toHaveBeenCalled();
        });

        test('does not begin a score round after cancellation is already set', async () => {
            const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => true }));

            expect(result.stopReason).toBe('cancelled');
            expect(turbo.submitSnapScore).not.toHaveBeenCalled();
        });

        test.each([
            ['landed response', scored({ tooEarly: true })],
            ['unclear response', scored({ ok: false, unclear: true, tooEarly: true })],
            ['terminal response', scored({ ok: false, sessionEnded: true, tooEarly: true })],
        ])('does not retry a %s that also says too early', async (_name, response) => {
            turbo.submitSnapScore.mockResolvedValue(response);

            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(turbo.submitSnapScore).toHaveBeenCalledTimes(1);
        });

        test('stops after two explicit too-early retries', async () => {
            turbo.submitSnapScore.mockResolvedValue(scored({ ok: false, tooEarly: true, retryAfterMs: 300 }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result.stopReason).toBe('request-failed');
            expect(turbo.submitSnapScore).toHaveBeenCalledTimes(3);
            expect(sleeps).toEqual([...slicesOf(9000), ...slicesOf(300), ...slicesOf(300)]);
        });

        test('cancels after a retry wait and never repeats the answer', async () => {
            let cancelled = false;
            turbo.submitSnapScore.mockResolvedValue(scored({ ok: false, tooEarly: true, retryAfterMs: 1000 }));
            const result = await runSnapGame(
                CHALLENGE,
                'tok',
                deps({
                    // Only the retry wait (after the first answer went out) sets the flag.
                    sleep: async () => {
                        if (turbo.submitSnapScore.mock.calls.length > 0) cancelled = true;
                        await nextTask();
                    },
                    isCancelled: () => cancelled,
                }),
            );

            expect(result.stopReason).toBe('cancelled');
            expect(turbo.submitSnapScore).toHaveBeenCalledTimes(1);
        });

        test('uses the bounded cooldown for repeated score refusals but a direct run can still retry', async () => {
            turbo.submitSnapScore.mockResolvedValue(scored({ ok: false }));
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(isSnapAutoCoolingDown(77, 0)).toBe(true);
            await runSnapGame(CHALLENGE, 'tok', deps());
            expect(turbo.submitSnapScore).toHaveBeenCalledTimes(4);
        });
    });

    describe('a stop while a round is running', () => {
        const deferred = <T>() => {
            let resolve!: (value: T) => void;
            let reject!: (reason: unknown) => void;
            const promise = new Promise<T>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            return { promise, resolve, reject };
        };
        // Lets a rejection that nobody awaits surface before the test ends.
        const settleStragglers = async () => {
            await nextTask();
            await nextTask();
        };
        const unhandled = jest.fn();
        beforeEach(() => {
            unhandled.mockClear();
            process.on('unhandledRejection', unhandled);
        });
        afterEach(() => {
            process.off('unhandledRejection', unhandled);
        });

        describe('photo rounds', () => {
            beforeEach(() => {
                turbo.startTurboSession.mockResolvedValue(snapSession(0, 1));
                turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));
            });

            test('a judgment that settles first is answered, and the watcher stops polling', async () => {
                const pending = deferred<SnapJudgment | null>();
                vision.judgeSnapImage.mockReturnValue(pending.promise);

                const result = await runSnapGame(
                    CHALLENGE,
                    'tok',
                    deps({
                        pace: () => 0,
                        sleep: async (ms) => {
                            sleeps.push(ms);
                            if (sleeps.length === 3) pending.resolve(judgment);
                            await nextTask();
                        },
                    }),
                );
                await settleStragglers();

                expect(result).toMatchObject({ answered: 1, won: true, stopReason: 'completed' });
                expect(turbo.submitSnapVote).toHaveBeenCalledWith('sess', 'img0', 'yes', 'tok');
                expect(sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS]);
            });

            test('a judgment that settles during a watcher sleep that ends on a microtask still wins', async () => {
                const pending = deferred<SnapJudgment | null>();
                vision.judgeSnapImage.mockReturnValue(pending.promise);

                const result = await runSnapGame(
                    CHALLENGE,
                    'tok',
                    deps({
                        pace: () => 0,
                        sleep: async (ms) => {
                            sleeps.push(ms);
                            pending.resolve(judgment);
                        },
                    }),
                );

                expect(result).toMatchObject({ answered: 1, won: true, stopReason: 'completed' });
                expect(turbo.submitSnapVote).toHaveBeenCalledWith('sess', 'img0', 'yes', 'tok');
            });

            test('a stop during the judgment returns at once, aborts it and drops its later failure silently', async () => {
                const pending = deferred<SnapJudgment | null>();
                let signal: AbortSignal | undefined;
                vision.judgeSnapImage.mockImplementation((_caption, _image, received) => {
                    signal = received;
                    return pending.promise;
                });

                const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => sleeps.length >= 3 }));
                expect(signal?.aborted).toBe(true);
                pending.reject(new Error('late failure'));
                await settleStragglers();

                expect(result).toEqual({
                    answered: 0,
                    total: 1,
                    meanAgreement: null,
                    won: false,
                    stopReason: 'cancelled',
                });
                expect(sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS]);
                expect(turbo.submitSnapVote).not.toHaveBeenCalled();
                expect(warnings()).toEqual([]);
                expect(unhandled).not.toHaveBeenCalled();
            });

            test('a stop during the answer wait is seen within one slice', async () => {
                const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => sleeps.length >= 5 }));

                expect(result.stopReason).toBe('cancelled');
                expect(sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS, POLL_MS, POLL_MS]);
                expect(turbo.submitSnapVote).not.toHaveBeenCalled();
            });

            test('a stop that is already set when the answer wait begins sleeps no slice', async () => {
                let cancelled = false;
                const result = await runSnapGame(
                    CHALLENGE,
                    'tok',
                    deps({
                        isCancelled: () => cancelled,
                        pace: () => {
                            cancelled = true;
                            return 4000;
                        },
                    }),
                );

                expect(result.stopReason).toBe('cancelled');
                expect(sleeps).toEqual([POLL_MS]);
                expect(turbo.submitSnapVote).not.toHaveBeenCalled();
            });
        });

        describe('score rounds', () => {
            beforeEach(() => {
                turbo.startTurboSession.mockResolvedValue(scoreSession());
                turbo.submitSnapScore.mockResolvedValue(scored({ completed: true }));
            });

            test('a judgment that settles first is submitted, and the watcher stops polling', async () => {
                const pending = deferred<number | null>();
                vision.judgeSnapVideoFrames.mockReturnValue(pending.promise);

                const result = await runSnapGame(
                    CHALLENGE,
                    'tok',
                    deps({
                        pace: () => 0,
                        now: steppedClock(5000),
                        sleep: async (ms) => {
                            sleeps.push(ms);
                            if (sleeps.length === 3) pending.resolve(5);
                            await nextTask();
                        },
                    }),
                );
                await settleStragglers();

                expect(result).toMatchObject({ answered: 1, won: true, stopReason: 'completed' });
                expect(turbo.submitSnapScore).toHaveBeenCalledWith('score-sess', 'video0', 5, 'tok');
                expect(sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS]);
            });

            test('a stop during frame extraction returns at once, aborts it and drops its later failure silently', async () => {
                const pending = deferred<string[]>();
                let signal: AbortSignal | undefined;
                videoFrames.mockImplementation((_url, _durationMs, _positions, received) => {
                    signal = received;
                    return pending.promise;
                });

                const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => sleeps.length >= 3 }));
                expect(signal?.aborted).toBe(true);
                pending.reject(new Error('Video extraction was cancelled'));
                await settleStragglers();

                expect(result).toEqual({
                    answered: 0,
                    total: 1,
                    meanAgreement: null,
                    won: false,
                    stopReason: 'cancelled',
                });
                expect(sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS]);
                expect(vision.judgeSnapVideoFrames).not.toHaveBeenCalled();
                expect(turbo.submitSnapScore).not.toHaveBeenCalled();
                expect(warnings()).toEqual([]);
                expect(unhandled).not.toHaveBeenCalled();
            });

            test('a stop during the model call aborts it, and its later result is dropped', async () => {
                const pending = deferred<number | null>();
                let signal: AbortSignal | undefined;
                vision.judgeSnapVideoFrames.mockImplementation((_caption, _frames, _maxScore, received) => {
                    signal = received;
                    return pending.promise;
                });

                const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => sleeps.length >= 3 }));
                expect(signal?.aborted).toBe(true);
                pending.reject(new Error('late failure'));
                await settleStragglers();

                expect(result.stopReason).toBe('cancelled');
                expect(warnings()).toEqual([]);
                expect(turbo.submitSnapScore).not.toHaveBeenCalled();
                expect(unhandled).not.toHaveBeenCalled();
            });

            test('a stop during the answer wait of a 5 s clip is seen within one slice', async () => {
                vision.judgeSnapVideoFrames.mockResolvedValue(4);

                const result = await runSnapGame(CHALLENGE, 'tok', deps({ isCancelled: () => sleeps.length >= 5 }));

                expect(result.stopReason).toBe('cancelled');
                expect(sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS, POLL_MS, POLL_MS]);
                expect(turbo.submitSnapScore).not.toHaveBeenCalled();
            });
        });
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
            expect(sleeps).toEqual(slicesOf(4000));
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
            // Per image: the cancel watcher's one poll, then the wait in slices.
            expect(sleeps).toEqual([POLL_MS, ...slicesOf(2500), POLL_MS, ...slicesOf(2500)]);
        });

        test('does not wait when judging alone took the target', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));

            await runSnapGame(CHALLENGE, 'tok', deps({ now: steppedClock(5000) }));

            expect(sleeps).toEqual([POLL_MS]);
            expect(turbo.submitSnapVote).toHaveBeenCalledTimes(1);
        });

        test('draws its target between 3 and 6 seconds with the real timing helpers by default', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ completed: true }));
            let t = 0;
            const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => (t += 100));

            await runSnapGame(CHALLENGE, 'tok');

            dateNow.mockRestore();
            expect(timing.getRandomDelay).toHaveBeenCalledWith(3000, 6000);
            // Target 4000 minus the 100 ms the clock advanced between its two readings, waited in slices, plus the
            // cancel watcher's one poll.
            const waited = timing.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
            expect(waited).toBe(3900 + POLL_MS);
            expect(timing.sleep).toHaveBeenCalledWith(150);
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

        test('error 1105 is transient and leaves Snap available', async () => {
            turbo.submitSnapVote.mockResolvedValue(landed({ ok: false, errorCode: 1105, communityPct: null }));

            const result = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(result.stopReason).toBe('request-failed');
            expect(isSnapUnavailable(77)).toBe(false);
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
            expect(warnings()).toEqual([]);
        });
    });

    describe('transient failures', () => {
        const noSession = () => turbo.startTurboSession.mockResolvedValue(null);

        test('the third run in a row that lands nothing starts the automatic cooldown and says so', async () => {
            vision.judgeSnapImage.mockResolvedValue(null);

            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            expect(isSnapUnavailable(77)).toBe(false);
            await runSnapGame(CHALLENGE, 'tok', deps());

            expect(isSnapUnavailable(77)).toBe(false);
            expect(isSnapAutoCoolingDown(77, 0)).toBe(true);
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

            expect(isSnapUnavailable(77)).toBe(false);
            expect(isSnapAutoCoolingDown(77, 0)).toBe(true);
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

            expect(isSnapUnavailable(77)).toBe(false);
            expect(isSnapAutoCoolingDown(77, 0)).toBe(true);
        });

        test('runs that make progress clear the transient state even without a win', async () => {
            await runSnapGame(CHALLENGE, 'tok', deps());
            await runSnapGame(CHALLENGE, 'tok', deps());
            expect(isSnapUnavailable(77)).toBe(false);
            const third = await runSnapGame(CHALLENGE, 'tok', deps());

            expect(third.answered).toBe(3);
            expect(isSnapUnavailable(77)).toBe(false);
            expect(isSnapAutoCoolingDown(77)).toBe(false);
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
