/**
 * Dynamic phase schedules end to end (the issue 94 case): the REAL settings, scenario runner and voting pass, over the REAL
 * mock strategy, with only the endpoints a recording stand-in. A phase's submit, vote and pause schedules are worked out
 * from the challenge's own evidence when the phase is published, and execution, deadline ordering, the final live recheck
 * and the next wake all read that one resolved form. The tests assert what was actually submitted or voted, and when the
 * scenario next wants a look.
 */

const mockLogs: Array<{ level: string; msg: string }> = [];

jest.mock('../../src/ts/core/logger', () => {
    const category = new Proxy(
        {},
        {
            get:
                (_target, level: string) =>
                (msg: unknown, ...rest: unknown[]) => {
                    mockLogs.push({ level, msg: String(msg) + (typeof rest[0] === 'string' ? ` ${rest[0]}` : '') });
                },
        },
    );
    const named = {
        __esModule: true,
        withCategory: () => category,
        challengeTag: (challenge: { id?: unknown; title?: unknown } | null | undefined) =>
            `[Challenge ${challenge?.id}: ${challenge?.title}]`,
    };
    // Anything else the pass reaches for on the logger is a no-op.
    return new Proxy(named, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) });
});

import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { buildChallenge } from '../helpers/challengeFixtures';
import { invalid } from '../helpers/invalid';
import settings = require('../../src/ts/core/settings');
import type * as mockStrategyModule from '../../src/ts/core/mock/strategy';
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as nextWakeModule from '../../src/ts/core/scenarios/nextWake';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioExpr } from '../../src/ts/core/types/scenario';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';
import type { ScenarioState } from '../../src/ts/core/types/stores';

const { createMockStrategy } = require('../../src/ts/core/mock/strategy') as typeof mockStrategyModule;
const { mockScenarioStateLedger } = require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { nextWakeAt } = require('../../src/ts/core/scenarios/nextWake') as typeof nextWakeModule;

const ID = 94;
const END = 1_800_000_000;
const HOUR = 3600;

const clock = { now: END - 48 * HOUR };

const hours = (value: number) => invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'duration', unit: 'hours' });
const endFact = () => invalid<ScenarioExpr>({ kind: 'fact', name: 'challenge.end' });
const freeExpiry = () => invalid<ScenarioExpr>({ kind: 'fact', name: 'boost.freeExpiry' });
const before = (from: ScenarioExpr, by: ScenarioExpr) =>
    invalid<ScenarioExpr>({ kind: 'offset', from, by, direction: 'before' });
const earlier = (...of: ScenarioExpr[]) => invalid<ScenarioExpr>({ kind: 'earlier', of });
const later = (...of: ScenarioExpr[]) => invalid<ScenarioExpr>({ kind: 'later', of });
const instant = (value: number) => invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'instant' });
const minutes = (value: number) =>
    invalid<ScenarioExpr>({ kind: 'literal', value, quantity: 'duration', unit: 'minutes' });

const rowTwo = () => earlier(before(endFact(), hours(10)), before(freeExpiry(), hours(1)));
const rowThree = () => before(endFact(), hours(9));
const rowFour = () => before(endFact(), hours(8));

type Rows = Array<{ count: number; at: ScenarioExpr }>;

const issue94 = (): Rows => [
    { count: 2, at: rowTwo() },
    { count: 3, at: rowThree() },
    { count: 4, at: rowFour() },
];

const planOf = (schedules: Record<string, unknown>) => ({
    name: 'Plan',
    version: 1,
    start: 'push',
    phases: { push: { schedules } },
});

const submitPlan = (rows: Rows = issue94(), alignment: 'end' | 'absolute' = 'end') =>
    planOf({ submit: { alignment, rows } });

/** The endpoint calls the pass made, and the challenge the stand-in shows. */
type Recorder = {
    calls: Array<{ method: string; args: unknown[] }>;
    live: Challenge[];
    /** What the live re-read of the challenge answers: an entry added from outside shows up in it. */
    onRead: Array<(live: Challenge[]) => void>;
};

const photos = () =>
    ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, index) => ({
        id,
        labels: ['Pink'],
        upload_date: 9000 + index,
        permission: { allowed: true, message: null },
    }));

const stub = (recorder: Recorder) =>
    new Proxy(
        {},
        {
            get: (_target, name: string | symbol) => {
                if (typeof name !== 'string' || name === 'then') return undefined;
                return async (...args: unknown[]) => {
                    recorder.calls.push({ method: name, args });
                    switch (name) {
                        case 'getActiveChallenges':
                            recorder.onRead.shift()?.(recorder.live);
                            return { challenges: recorder.live };
                        case 'getVoteImages':
                            return { images: [{ id: 'i1' }], challengeId: ID };
                        case 'getEligiblePhotos':
                            return photos().filter(
                                (photo) =>
                                    !(recorder.live[0]?.member?.ranking?.entries ?? []).some(
                                        (entry) => entry.id === photo.id,
                                    ),
                            );
                        // the pass reflects a landed submit into the challenge object it shares with this stand-in
                        case 'submitToChallenge':
                            return { ok: true, raw: { success: true } };
                        case 'getBankroll':
                            return { keys: 3, swaps: 3, fills: 3, coins: 0 };
                        case 'getMyMissions':
                            return { missions: [] };
                        case 'getMyCompletedChallenges':
                            return { challenges: [] };
                        default:
                            return { success: true, ok: true };
                    }
                };
            },
        },
    );

const challengeOf = (entries: number, boost: Record<string, unknown> | null = null, max = 4): Challenge =>
    buildChallenge({
        id: ID,
        title: 'Issue 94',
        type: 'regular',
        start_time: END - 10 * 24 * HOUR,
        close_time: END,
        max_photo_submits: max,
        member: {
            boost: boost ?? { state: 'AVAILABLE_KEY' },
            turbo: { state: 'NONE' },
            ranking: {
                entries: Array.from({ length: entries }, (_unused, index) => ({
                    id: `e${index + 1}`,
                    member_id: 'm',
                    votes: 10,
                })),
                exposure: { exposure_factor: 100 },
                swaps: [],
            },
        },
    });

/** The parts of the stand-in's member these tests change. */
type Member = { boost: unknown; ranking: { entries: unknown[]; exposure: { exposure_factor: number } } };
const memberOf = (challenge: Challenge | undefined) => invalid<Member>(challenge?.member);

let recorder: Recorder;

const arrange = (doc: unknown, challenge: Challenge) => {
    recorder = { calls: [], live: [challenge], onRead: [] };
    expect(settings.saveScenario(doc)).toEqual({ ok: true, name: 'Plan' });
    settings.setChallengeOverride('scenario', String(ID), 'Plan');
};

/** One full mock pass at `now` (unix seconds): the number of photos it submitted. */
const pass = async (now: number): Promise<number> => {
    clock.now = now;
    const submitted = recorder.calls.filter((call) => call.method === 'submitToChallenge').length;
    const result = await createMockStrategy(invalid(stub(recorder))).fetchChallengesAndVote('tok');
    expect(result.success).toBe(true);
    return recorder.calls.filter((call) => call.method === 'submitToChallenge').length - submitted;
};

const votes = () => recorder.calls.filter((call) => call.method === 'getVoteImages').length;
const entries = () => memberOf(recorder.live[0]).ranking.entries.length;

const published = () => mockScenarioStateLedger.get(ID).state?.published;
const submitRows = () => published()?.schedules?.submit?.rows;
const state = () => mockScenarioStateLedger.get(ID).state as ScenarioState;

const wake = (now: number) =>
    nextWakeAt({
        scenario: settings.getScenario('Plan') as ScenarioDocument,
        state: state(),
        challenge: recorder.live[0] as Challenge,
        now,
        timezone: 'UTC',
    });

beforeEach(async () => {
    mockLogs.length = 0;
    installHeadlessStore();
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now * 1000);
    await mockScenarioStateLedger.removeAll();
    settings.setSetting('mock', true);
    settings.setGlobalDefault('autoSubmit', true);
    settings.setGlobalDefault('emergencySubmit', 0);
    settings.rememberChallengeTitles([{ id: ID, title: 'Issue 94', type: 'regular' }]);
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
    settings.rememberChallengeTitles([]);
});

describe('issue 94: the resolved schedule of a four-photo challenge', () => {
    test('with no free expiry the rows are end minus 10h, 9h and 8h', async () => {
        arrange(submitPlan(), challengeOf(1));
        await pass(END - 48 * HOUR);
        expect(submitRows()).toEqual([
            { count: 2, state: 'known', at: 1799964000 },
            { count: 3, state: 'known', at: 1799967600 },
            { count: 4, state: 'known', at: 1799971200 },
        ]);
        expect(published()?.schedules?.submit?.alignment).toBe('end');
    });

    test('a free expiry earlier than the deadline moves the first row to an hour before it', async () => {
        arrange(submitPlan(), challengeOf(1, { state: 'AVAILABLE', timeout: 1799956800 }));
        await pass(END - 48 * HOUR);
        expect(submitRows()).toEqual([
            { count: 2, state: 'known', at: 1799953200 },
            { count: 3, state: 'known', at: 1799967600 },
            { count: 4, state: 'known', at: 1799971200 },
        ]);
    });

    test('a free expiry later than the deadline leaves the first row at end minus 10h', async () => {
        arrange(submitPlan(), challengeOf(1, { state: 'AVAILABLE', timeout: END - 2 * HOUR }));
        await pass(END - 48 * HOUR);
        expect(submitRows()?.[0]).toEqual({ count: 2, state: 'known', at: 1799964000 });
    });

    test('a key-unlocked Boost has no free expiry: the deadline stands alone', async () => {
        arrange(submitPlan(), challengeOf(1, { state: 'AVAILABLE_KEY' }));
        await pass(END - 48 * HOUR);
        expect(submitRows()?.[0]).toEqual({ count: 2, state: 'known', at: 1799964000 });
    });

    test('a malformed timer leaves the first row unknown, and the other rows known', async () => {
        arrange(submitPlan(), challengeOf(1, { state: 'AVAILABLE', timeout: 'soon' }));
        await pass(END - 48 * HOUR);
        const rows = submitRows();
        expect(rows?.[0]).toMatchObject({ count: 2, state: 'unknown' });
        expect(rows?.[1]).toEqual({ count: 3, state: 'known', at: 1799967600 });
        expect(rows?.[2]).toEqual({ count: 4, state: 'known', at: 1799971200 });
    });

    test('the later of two deadlines is the one that applies', async () => {
        arrange(
            submitPlan([
                { count: 2, at: later(before(endFact(), hours(10)), before(endFact(), hours(12))) },
                { count: 3, at: rowThree() },
            ]),
            challengeOf(1),
        );
        await pass(END - 48 * HOUR);
        expect(submitRows()?.[0]).toEqual({ count: 2, state: 'known', at: 1799964000 });
    });

    test('the resolved rows read as count and instant', async () => {
        arrange(submitPlan(), challengeOf(1, { state: 'AVAILABLE', timeout: 1799956800 }));
        await pass(END - 48 * HOUR);
        const resolvedRows = submitRows()?.map(({ count, state: rowState, ...rest }) => ({
            count,
            ...(rowState === 'known' ? { at: (rest as { at: number }).at } : {}),
        }));
        expect(resolvedRows).toEqual([
            { count: 2, at: 1799953200 },
            { count: 3, at: 1799967600 },
            { count: 4, at: 1799971200 },
        ]);
    });
});

describe('what a pass submits, and when the scenario next looks', () => {
    test('nothing is submitted before the first row, and the next look is that row', async () => {
        arrange(submitPlan(), challengeOf(1));
        const now = END - 48 * HOUR;
        expect(await pass(now)).toBe(0);
        expect(wake(now)).toBe(1799964000);
    });

    test('each row, once due, authorizes its cumulative count and no more', async () => {
        arrange(submitPlan(), challengeOf(1));
        expect(await pass(1799964000)).toBe(1);
        expect(entries()).toBe(2);
        // nothing more is due before the next row, and a second pass does not repeat the fulfilled row
        expect(await pass(1799964000 + 60)).toBe(0);
        expect(wake(1799964000 + 60)).toBe(1799967600);
        expect(await pass(1799967600)).toBe(1);
        expect(entries()).toBe(3);
        expect(wake(1799967600)).toBe(1799971200);
        expect(await pass(1799971200)).toBe(1);
        expect(entries()).toBe(4);
        expect(wake(1799971200)).toBeNull();
    });

    test('a late start catches up one photo per pass, toward the largest due count', async () => {
        arrange(submitPlan(), challengeOf(1));
        const late = 1799971200 + 60;
        expect(await pass(late)).toBe(1);
        expect(entries()).toBe(2);
        expect(await pass(late)).toBe(1);
        expect(entries()).toBe(3);
        expect(await pass(late)).toBe(1);
        expect(entries()).toBe(4);
        expect(await pass(late)).toBe(0);
    });

    test('a satisfied target submits nothing', async () => {
        arrange(submitPlan(), challengeOf(3));
        expect(await pass(1799967600 + 60)).toBe(0);
        expect(await pass(1799971200)).toBe(1);
        expect(entries()).toBe(4);
    });

    // A submitting pass reads the challenge three times: the pass start, the live re-check, and the final recheck.
    const outsideEntry = (live: Challenge[]) => {
        memberOf(live[0]).ranking.entries.push({ id: 'outside', member_id: 'm', votes: 0 });
    };

    test('an entry added from outside before the live re-check stands the fill down', async () => {
        arrange(submitPlan(), challengeOf(1));
        recorder.onRead.push(() => undefined, outsideEntry);
        expect(await pass(1799964000 + 60)).toBe(0);
    });

    test('an entry added from outside before the final recheck stands the fill down', async () => {
        arrange(submitPlan(), challengeOf(1));
        recorder.onRead.push(
            () => undefined,
            () => undefined,
            outsideEntry,
        );
        expect(await pass(1799964000 + 60)).toBe(0);
    });

    test("control: the same pass with no outside entry submits (so the stand-down above is the recheck's)", async () => {
        arrange(submitPlan(), challengeOf(1));
        recorder.onRead.push(
            () => undefined,
            () => undefined,
            () => undefined,
        );
        expect(await pass(1799964000 + 60)).toBe(1);
    });

    test('a clock that moved back before the final recheck does not submit early', async () => {
        arrange(submitPlan(), challengeOf(1));
        recorder.onRead.push(
            () => undefined,
            () => undefined,
            () => {
                clock.now = 1799964000 - 600;
            },
        );
        expect(await pass(1799964000 + 60)).toBe(0);
    });

    test('a smaller capacity end-aligns the rows: a three-photo challenge follows the 3rd and 4th deadlines', async () => {
        arrange(submitPlan(), challengeOf(1, null, 3));
        // count 2 follows the 3rd-photo deadline (end - 9h), count 3 the 4th (end - 8h)
        expect(await pass(1799964000 + 60)).toBe(0);
        expect(await pass(1799967600)).toBe(1);
        expect(entries()).toBe(2);
        expect(await pass(1799971200)).toBe(1);
        expect(entries()).toBe(3);
        expect(await pass(END - HOUR)).toBe(0);
    });

    test('a two-photo challenge follows the last deadline', async () => {
        arrange(submitPlan(), challengeOf(1, null, 2));
        expect(await pass(1799967600 + 60)).toBe(0);
        expect(await pass(1799971200)).toBe(1);
        expect(entries()).toBe(2);
    });

    test('absolute alignment keeps each count at its own deadline and drops counts above the capacity', async () => {
        arrange(submitPlan(issue94(), 'absolute'), challengeOf(1, null, 3));
        expect(await pass(1799964000)).toBe(1);
        expect(entries()).toBe(2);
        expect(await pass(1799967600)).toBe(1);
        expect(entries()).toBe(3);
        // count 4 is above the capacity: it is never remapped into an earlier slot
        expect(await pass(1799971200)).toBe(0);
        expect(entries()).toBe(3);
    });
});

describe('partly unknown schedules', () => {
    const unknownTimer = { state: 'AVAILABLE', timeout: 'soon' };

    test('an unknown target 2 beside a known due target 3 allows one submission toward 3 per pass', async () => {
        arrange(submitPlan(), challengeOf(1, unknownTimer));
        const now = 1799967600 + 60;
        expect(await pass(now)).toBe(1);
        expect(entries()).toBe(2);
        expect(await pass(now)).toBe(1);
        expect(entries()).toBe(3);
        expect(await pass(now)).toBe(0);
        expect(entries()).toBe(3);
    });

    test('a known due target 2 beside an unknown target 3 reaches 2 only', async () => {
        arrange(
            submitPlan([
                { count: 2, at: instant(1799964000) },
                { count: 3, at: before(freeExpiry(), hours(2)) },
            ]),
            challengeOf(1, unknownTimer),
        );
        const now = 1799964000 + 60;
        expect(await pass(now)).toBe(1);
        expect(entries()).toBe(2);
        expect(await pass(now)).toBe(0);
        expect(entries()).toBe(2);
    });

    test('three trusted entries make an unknown target 2 irrelevant: it does not block the future target 4', async () => {
        arrange(submitPlan(), challengeOf(3, unknownTimer));
        expect(await pass(1799967600 + 60)).toBe(0);
        expect(await pass(1799971200)).toBe(1);
        expect(entries()).toBe(4);
    });

    test('with no known row due, an unknown row alone submits nothing', async () => {
        arrange(submitPlan(), challengeOf(1, unknownTimer));
        expect(await pass(END - 48 * HOUR)).toBe(0);
        expect(await pass(1799964000 + 60)).toBe(0);
    });

    test('fresh evidence recovers the row: the next pass reads it and submits', async () => {
        arrange(submitPlan(), challengeOf(1, unknownTimer));
        const now = 1799964000 + 60;
        expect(await pass(now)).toBe(0);
        expect(submitRows()?.[0]).toMatchObject({ count: 2, state: 'unknown' });
        // the timer is readable on the next read of the challenge
        memberOf(recorder.live[0]).boost = { state: 'AVAILABLE_KEY' };
        expect(await pass(now)).toBe(1);
        expect(submitRows()?.[0]).toEqual({ count: 2, state: 'known', at: 1799964000 });
        expect(entries()).toBe(2);
    });

    test('a confirmed absent candidate is left out of "earlier", and an absent row is inactive', async () => {
        arrange(
            submitPlan([
                { count: 2, at: before(freeExpiry(), hours(1)) },
                { count: 3, at: rowThree() },
            ]),
            challengeOf(1, { state: 'AVAILABLE_KEY' }),
        );
        expect(await pass(1799967600 + 60)).toBe(1);
        expect(submitRows()?.[0]).toMatchObject({ count: 2, state: 'absent' });
        expect(entries()).toBe(2);
        expect(await pass(1799967600 + 60)).toBe(1);
        expect(entries()).toBe(3);
    });
});

describe('vote and pause schedules', () => {
    const lowExposure = (): Challenge => {
        const challenge = challengeOf(2);
        memberOf(challenge).ranking.exposure.exposure_factor = 10;
        return challenge;
    };
    const NOW = END - 48 * HOUR;
    const unknownAt = () => before(freeExpiry(), hours(1));
    const unknownTimer = { state: 'AVAILABLE', timeout: 'soon' };

    const lowWith = (boost: Record<string, unknown>): Challenge => {
        const challenge = lowExposure();
        memberOf(challenge).boost = boost;
        return challenge;
    };

    beforeEach(() => {
        settings.setGlobalDefault('exposure', 90);
        settings.setGlobalDefault('exposureTarget', 100);
    });

    test('control: with no schedule the challenge below its threshold is voted', async () => {
        arrange(planOf({}), lowExposure());
        await pass(NOW);
        expect(votes()).toBeGreaterThan(0);
    });

    test('a known pause window that is open stops voting', async () => {
        settings.setGlobalDefault('useVotingPause', true);
        arrange(planOf({ pause: { rows: [{ at: instant(NOW - HOUR), duration: hours(3) }] } }), lowExposure());
        await pass(NOW);
        expect(votes()).toBe(0);
    });

    test('a known pause window that is over lets voting go on', async () => {
        settings.setGlobalDefault('useVotingPause', true);
        arrange(planOf({ pause: { rows: [{ at: instant(NOW - 5 * HOUR), duration: hours(3) }] } }), lowExposure());
        await pass(NOW);
        expect(votes()).toBeGreaterThan(0);
    });

    test('a pause window that cannot be told stops voting: permission is unproven', async () => {
        settings.setGlobalDefault('useVotingPause', true);
        arrange(planOf({ pause: { rows: [{ at: unknownAt(), duration: hours(3) }] } }), lowWith(unknownTimer));
        await pass(NOW);
        expect(votes()).toBe(0);
    });

    test('an unknown pause row beside a known clear one still stops voting', async () => {
        settings.setGlobalDefault('useVotingPause', true);
        arrange(
            planOf({
                pause: {
                    rows: [
                        { at: instant(NOW - 5 * HOUR), duration: hours(3) },
                        { at: unknownAt(), duration: hours(3) },
                    ],
                },
            }),
            lowWith(unknownTimer),
        );
        await pass(NOW);
        expect(votes()).toBe(0);
    });

    test('a known open scheduled-voting window votes even beside an unknown one', async () => {
        settings.setGlobalDefault('useScheduledFill', true);
        settings.setGlobalDefault('scheduledFillReplaces', true);
        arrange(
            planOf({
                vote: {
                    rows: [
                        { at: instant(NOW - HOUR), duration: minutes(120) },
                        { at: unknownAt(), duration: minutes(60) },
                    ],
                },
            }),
            lowWith(unknownTimer),
        );
        await pass(NOW);
        expect(votes()).toBeGreaterThan(0);
    });

    test('an unreadable replacing schedule does not fall through to ordinary voting', async () => {
        settings.setGlobalDefault('useScheduledFill', true);
        settings.setGlobalDefault('scheduledFillReplaces', true);
        arrange(planOf({ vote: { rows: [{ at: unknownAt(), duration: minutes(60) }] } }), lowWith(unknownTimer));
        await pass(NOW);
        expect(votes()).toBe(0);
    });

    test('a known window that is shut keeps its replacing behaviour', async () => {
        settings.setGlobalDefault('useScheduledFill', true);
        settings.setGlobalDefault('scheduledFillReplaces', true);
        arrange(planOf({ vote: { rows: [{ at: instant(NOW - 5 * HOUR), duration: minutes(60) }] } }), lowExposure());
        await pass(NOW);
        expect(votes()).toBe(0);
    });

    test('an unknown window alone cannot authorize voting, but a non-replacing schedule leaves ordinary voting alone', async () => {
        settings.setGlobalDefault('useScheduledFill', true);
        settings.setGlobalDefault('scheduledFillReplaces', false);
        arrange(planOf({ vote: { rows: [{ at: unknownAt(), duration: minutes(60) }] } }), lowWith(unknownTimer));
        await pass(NOW);
        expect(votes()).toBeGreaterThan(0);
    });
});
