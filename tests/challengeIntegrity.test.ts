/**
 * challengeIntegrity.ts — the active-challenge boundary: every challenge is
 * checked once, when its read arrives. Covers every rule in both directions,
 * the §1 boundary inputs, and normalizeActiveChallenges' drop / strip / mark /
 * log behavior.
 */

import type * as loggerModule from '../src/ts/logger';
import type * as challengeIntegrityModule from '../src/ts/challengeIntegrity';
import type { ActiveChallengesResponse } from '../src/ts/types/gurushots';
import { APP_SET_CHALLENGE_FIELDS } from '../src/ts/challengeIntegrity';
import { invalid } from './helpers/invalid';

const { normalizeActiveChallenges, challengeIssues, challengeWarnings, __resetForTests } =
    require('../src/ts/challengeIntegrity') as typeof challengeIntegrityModule;

type LoggerMock = typeof loggerModule & {
    __mockDebugFn: jest.MockedFunction<loggerModule.CategoryLogger['debug']>;
    __mockWarningFn: jest.MockedFunction<loggerModule.CategoryLogger['warning']>;
    __mockWarningTFn: jest.MockedFunction<loggerModule.CategoryLogger['warningT']>;
};

// Mock the logger module
jest.mock('../src/ts/logger', () => {
    const mockDebugFn = jest.fn();
    const mockWarningFn = jest.fn();
    const mockWarningTFn = jest.fn();

    return {
        challengeTag: jest.fn(
            (c: { id?: string | number; title?: string } | string | number | null | undefined, t?: string | null) =>
                c && typeof c === 'object'
                    ? `[Challenge ${c.id ?? 'unknown'}: ${c.title ?? 'unknown'}]`
                    : `[Challenge ${c ?? 'unknown'}: ${t ?? 'unknown'}]`,
        ),
        withCategory: jest.fn(() => ({
            debug: mockDebugFn,
            warning: mockWarningFn,
            warningT: mockWarningTFn,
        })),
        // Export the mock functions for testing
        __mockDebugFn: mockDebugFn,
        __mockWarningFn: mockWarningFn,
        __mockWarningTFn: mockWarningTFn,
    };
});

// One fully valid challenge: no issues, no warnings. Tests override single fields.
const validRanking = (): Record<string, unknown> => ({
    total: { votes: 10, rank: 2, level: 3, level_name: 'SKILLED', percent: 42.5 },
    exposure: { exposure_factor: 55 },
    entries: [{ id: 'e1', votes: 5, boosted: false, boosting: false, turbo: false }],
    swaps: [{ id: 'swap_01' }],
});

const validMember = (): Record<string, unknown> => ({
    boost: { state: 'AVAILABLE', timeout: null },
    ranking: validRanking(),
});

const validChallenge = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 135938,
    title: 'Test Challenge',
    url: 'test-challenge',
    start_time: 1_800_000_000,
    close_time: 1_800_086_400,
    entries: 12,
    players: 40,
    max_photo_submits: 3,
    type: 'default',
    boost_enable: true,
    member: validMember(),
    ...overrides,
});

const logger: LoggerMock = invalid(require('../src/ts/logger'));

beforeEach(() => {
    jest.clearAllMocks();
    __resetForTests();
});

describe('challengeIssues', () => {
    test('a fully valid challenge carries no issues', () => {
        expect(challengeIssues(validChallenge())).toEqual([]);
    });

    test.each([
        ['type is absent', { type: undefined }],
        ['url is absent', { url: undefined }],
        ['max_photo_submits is absent', { max_photo_submits: undefined }],
        ['member is absent', { member: undefined }],
        ['member is null', { member: null }],
        ['ranking is absent', { member: { boost: {} } }],
        ['ranking is null', { member: { boost: {}, ranking: null } }],
        ['exposure is absent', { member: { ranking: { total: {} } } }],
        ['exposure_factor is absent', { member: { ranking: { exposure: {}, total: {} } } }],
        ['exposure_factor is null', { member: { ranking: { exposure: { exposure_factor: null }, total: {} } } }],
        ['swaps is absent', { member: { ranking: { swaps: undefined, total: {} } } }],
        ['entries are absent', { member: { ranking: { entries: undefined, total: {} } } }],
        ['entries are null', { member: { ranking: { entries: null, total: {} } } }],
        ['an entry votes is absent', { member: { ranking: { entries: [{ id: 'e1' }], total: {} } } }],
        ['an entry votes is null', { member: { ranking: { entries: [{ id: 'e1', votes: null }], total: {} } } }],
    ])('never marks when %s', (_label, override) => {
        expect(challengeIssues(validChallenge(override))).toEqual([]);
    });

    test.each([null, 0])('an AVAILABLE boost with timeout %p does not mark', (timeout) => {
        const challenge = validChallenge({ member: { boost: { state: 'AVAILABLE', timeout } } });
        expect(challengeIssues(challenge)).toEqual([]);
    });

    test('numeric-string timestamps are converted in place and do not mark', () => {
        const challenge = validChallenge({ start_time: '1800000000', close_time: '1800086400' });
        expect(challengeIssues(challenge)).toEqual([]);
        expect(challenge.start_time).toBe(1_800_000_000);
        expect(challenge.close_time).toBe(1_800_086_400);
    });

    test('a numeric-string exposure_factor in range is converted in place and does not mark', () => {
        const challenge = validChallenge({
            member: {
                boost: { state: 'AVAILABLE', timeout: null },
                ranking: { exposure: { exposure_factor: '55.5' } },
            },
        });
        expect(challengeIssues(challenge)).toEqual([]);
        expect(challenge.member).toEqual({
            boost: { state: 'AVAILABLE', timeout: null },
            ranking: { exposure: { exposure_factor: 55.5 } },
        });
    });

    test('the incident payload (ranking.total without level, level_name and percent) does not mark', () => {
        const challenge = validChallenge({
            member: { ...validMember(), ranking: { ...validRanking(), total: { votes: 5, rank: 2 } } },
        });
        expect(challengeIssues(challenge)).toEqual([]);
    });

    test.each([
        ['a non-finite timestamp', { start_time: NaN }, ['start_time']],
        ['an infinite timestamp', { start_time: Infinity }, ['start_time', 'start_close_order']],
        ['a boolean timestamp', { start_time: true }, ['start_time']],
        ['a millisecond timestamp', { start_time: 1e11 }, ['start_time', 'start_close_order']],
        ['a millisecond timestamp past the cap', { close_time: 1e12 }, ['close_time']],
        ['a scientific-notation string', { start_time: '1e3' }, ['start_time']],
        ['a hex string', { start_time: '0x10' }, ['start_time']],
        ['an empty string', { start_time: '' }, ['start_time']],
        ['a blank string', { close_time: '  ' }, ['close_time']],
        ['a null timestamp', { start_time: null }, ['start_time']],
        ['an out-of-range numeric string', { start_time: '100000000000' }, ['start_time']],
    ])('marks %s', (_label, override, expected) => {
        expect(challengeIssues(validChallenge(override))).toEqual(expected);
    });

    test.each([
        ['equal times', 1_800_000_000, 1_800_000_000],
        ['start after close', 1_800_000_002, 1_800_000_001],
    ])('marks start_close_order for %s', (_label, start, close) => {
        expect(challengeIssues(validChallenge({ start_time: start, close_time: close }))).toEqual([
            'start_close_order',
        ]);
    });

    test.each([
        ['a string member', 'none'],
        ['a number member', 5],
        ['an array member', [1]],
    ])('marks a primitive member (%s)', (_label, member) => {
        expect(challengeIssues(validChallenge({ member }))).toEqual(['member']);
    });

    test.each([
        ['a string ranking', 'none'],
        ['a number ranking', 0],
    ])('marks %s', (_label, ranking) => {
        const challenge = validChallenge({ member: { ...validMember(), ranking } });
        expect(challengeIssues(challenge)).toEqual(['member.ranking']);
    });

    test.each([
        ['a non-array entries', 'none'],
        ['an entry without an id', [{ id: 'ok' }, { votes: 1 }]],
        ['an entry with an empty-string id', [{ id: '' }]],
        ['an entry with a negative id', [{ id: '-1' }]],
        ['an entry with a zero id', [{ id: 0 }]],
        ['an entry with a non-finite id', [{ id: Infinity }]],
        ['a primitive entry', ['bad']],
    ])('marks ranking.entries for %s', (_label, entries) => {
        const challenge = validChallenge({ member: { ...validMember(), ranking: { entries } } });
        expect(challengeIssues(challenge)).toEqual(['ranking.entries']);
    });

    test.each([
        ['above 100', 150],
        ['below 0', -1],
        ['NaN', NaN],
        ['a numeric string out of range', '150'],
        ['a non-numeric string', 'abc'],
        ['a boolean', true],
    ])('marks an out-of-range exposure_factor (%s)', (_label, exposure_factor) => {
        const challenge = validChallenge({
            member: { ...validMember(), ranking: { exposure: { exposure_factor } } },
        });
        expect(challengeIssues(challenge)).toEqual(['ranking.exposure.exposure_factor']);
    });

    test.each([0, 100, 55.5])('does not mark an in-range exposure_factor of %s', (exposure_factor) => {
        const challenge = validChallenge({
            member: { ...validMember(), ranking: { exposure: { exposure_factor } } },
        });
        expect(challengeIssues(challenge)).toEqual([]);
    });

    test('emits more than one code when more than one rule fails', () => {
        const challenge = validChallenge({ start_time: 1e11, member: 'none' });
        expect(challengeIssues(challenge)).toEqual(['start_time', 'start_close_order', 'member']);
    });
});

describe('challengeWarnings', () => {
    test('a fully valid challenge carries no warnings', () => {
        expect(challengeWarnings(validChallenge())).toEqual([]);
    });

    test('a type that is not a string warns', () => {
        expect(challengeWarnings(validChallenge({ type: 5 }))).toEqual(['type']);
    });

    test('an absent url warns', () => {
        expect(challengeWarnings(validChallenge({ url: undefined }))).toEqual(['url']);
    });

    test.each([
        ['a string', '3'],
        ['NaN', NaN],
        ['null', null],
    ] as Array<[string, unknown]>)('a max_photo_submits of %p warns', (max_photo_submits) => {
        expect(challengeWarnings(validChallenge({ max_photo_submits }))).toEqual(['max_photo_submits']);
    });

    test.each([
        ['a string timeout', 'x'],
        ['a NaN timeout', NaN],
    ])('member.boost.timeout %p warns', (_label, timeout) => {
        const challenge = validChallenge({ member: { boost: { state: 'AVAILABLE', timeout } } });
        expect(challengeWarnings(challenge)).toEqual(['member.boost.timeout']);
    });

    test('a null or absent member.boost.timeout does not warn', () => {
        expect(challengeWarnings(validChallenge({ member: { boost: { state: 'AVAILABLE', timeout: null } } }))).toEqual(
            [],
        );
        expect(challengeWarnings(validChallenge({ member: { boost: { state: 'AVAILABLE' } } }))).toEqual([]);
    });

    test.each(['boost_enable', 'fill_locked', 'guru_pick_enable', 'new_ranking_enable'])(
        'a non-boolean %s warns',
        (field) => {
            expect(challengeWarnings(validChallenge({ [field]: 'yes' }))).toEqual([field]);
        },
    );

    test('absent flags do not warn', () => {
        expect(challengeWarnings(validChallenge({ boost_enable: undefined }))).toEqual([]);
    });

    test.each([
        [
            'entries absent',
            { member: { boost: {}, ranking: { swaps: [], entries: undefined } } },
            'ranking.entries_absent',
        ],
        ['entries null', { member: { boost: {}, ranking: { swaps: [], entries: null } } }, 'ranking.entries_absent'],
        ['swaps absent', { member: { boost: {}, ranking: { entries: [{ id: 'e1' }] } } }, 'ranking.swaps_absent'],
    ])('%s warns', (_label, member, code) => {
        expect(challengeWarnings(validChallenge(member))).toEqual([code]);
    });

    test('a numeric-string entry votes warns', () => {
        const challenge = validChallenge({
            member: { ...validMember(), ranking: { ...validRanking(), entries: [{ id: 'e1', votes: '5' }] } },
        });
        expect(challengeWarnings(challenge)).toEqual(['ranking.entries.votes']);
    });

    test.each(['boosted', 'boosting', 'turbo'])('an entry %s that is not a boolean warns', (flag) => {
        const challenge = validChallenge({
            member: {
                ...validMember(),
                ranking: { ...validRanking(), entries: [{ id: 'e1', [flag]: 'yes' }] },
            },
        });
        expect(challengeWarnings(challenge)).toEqual([`ranking.entries.${flag}`]);
    });

    test('the same code from several entries warns once', () => {
        const challenge = validChallenge({
            member: {
                ...validMember(),
                ranking: {
                    ...validRanking(),
                    entries: [
                        { id: 'e1', boosted: 'yes' },
                        { id: 'e2', boosted: 1 },
                    ],
                },
            },
        });
        expect(challengeWarnings(challenge)).toEqual(['ranking.entries.boosted']);
    });

    test('a non-object entry is skipped by the warning walk, the readable ones still warn', () => {
        const challenge = validChallenge({
            member: {
                ...validMember(),
                ranking: { ...validRanking(), entries: ['bad', { id: 'e2', boosted: 'yes' }] },
            },
        });
        expect(challengeWarnings(challenge)).toEqual(['ranking.entries.boosted']);
    });

    test('a null exposure_factor warns', () => {
        const challenge = validChallenge({
            member: { ...validMember(), ranking: { ...validRanking(), exposure: { exposure_factor: null } } },
        });
        expect(challengeWarnings(challenge)).toEqual(['ranking.exposure.exposure_factor_null']);
    });

    test('the incident shape (total without level, level_name or percent) warns with the incident code', () => {
        const challenge = validChallenge({
            member: { ...validMember(), ranking: { ...validRanking(), total: { votes: 5, rank: 2 } } },
        });
        expect(challengeWarnings(challenge)).toEqual(['ranking.total.level']);
    });

    test('a total with a wrong-typed level field warns once, not per field', () => {
        const challenge = validChallenge({
            member: {
                ...validMember(),
                ranking: { ...validRanking(), total: { level: '3', level_name: 5, percent: null } },
            },
        });
        expect(challengeWarnings(challenge)).toEqual(['ranking.total.level']);
    });

    test('several malformed optional fields warn with every code, in a fixed order', () => {
        const challenge = validChallenge({ url: undefined, type: 5, boost_enable: 'no' });
        expect(challengeWarnings(challenge)).toEqual(['type', 'url', 'boost_enable']);
    });
});

describe('normalizeActiveChallenges', () => {
    test.each([
        ['a non-array challenges', { challenges: 'none' }],
        ['a missing challenges', {}],
    ])('%s resolves the failed-read shape', (_label, body) => {
        expect(normalizeActiveChallenges(invalid<ActiveChallengesResponse>(body))).toEqual({
            challenges: [],
            fetchFailed: true,
        });
    });

    test('a server-sent fetchFailed cannot fake a failed read', () => {
        const response = normalizeActiveChallenges(
            invalid<ActiveChallengesResponse>({ challenges: [validChallenge()], fetchFailed: true }),
        );
        expect(response.fetchFailed).toBe(false);
    });

    test('elements that are not plain objects or have no valid id are dropped, and the read becomes prune-unsafe', () => {
        const kept = validChallenge({ id: '1' });
        const response = normalizeActiveChallenges(
            invalid<ActiveChallengesResponse>({
                challenges: [
                    kept,
                    null,
                    'text',
                    5,
                    [],
                    { title: 'no id' },
                    { id: '' },
                    { id: '0' },
                    { id: '__proto__' },
                ],
            }),
        );
        expect(response.challenges).toEqual([kept]);
        expect(response.pruneUnsafe).toBe(true);
        expect(response.fetchFailed).toBe(false);
    });

    test('a clean read carries pruneUnsafe false as a real boolean', () => {
        const response = normalizeActiveChallenges(
            invalid<ActiveChallengesResponse>({ challenges: [validChallenge()] }),
        );
        expect(response.pruneUnsafe).toBe(false);
        expect(response.pruneUnsafe).toBeDefined();
    });

    test('strips every app-set field on the real read, iterating the constant', () => {
        for (const field of APP_SET_CHALLENGE_FIELDS) {
            const challenge = validChallenge({ [field]: field === 'boostHoldUntil' ? 1_800_000_000 : { us: {} } });
            const response = normalizeActiveChallenges(
                invalid<ActiveChallengesResponse>({ challenges: [challenge] }),
                true,
            );
            expect(response.challenges[0]).not.toHaveProperty(field);
        }
    });

    test('with stripping off (the mock read) the app-set fields survive', () => {
        const teamMatch = { us: { name: 'Home', votes: 1 }, them: { name: 'Away', votes: 2 } };
        const challenge = validChallenge({ boostHoldUntil: 1_800_000_000, teamMatch });
        const response = normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));
        expect(response.challenges[0].boostHoldUntil).toBe(1_800_000_000);
        expect(response.challenges[0].teamMatch).toBe(teamMatch);
    });

    test('marks a malformed challenge and keeps it in the list', () => {
        const challenge = validChallenge({ start_time: 1e11 });
        const response = normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));
        expect(response.challenges).toEqual([challenge]);
        expect(challenge.dataIssues).toEqual(['start_time', 'start_close_order']);
    });

    test('a fixed mock object loses its mark on the next read', () => {
        const challenge = validChallenge({ start_time: 1e11 });
        normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));
        expect(challenge.dataIssues).toEqual(['start_time', 'start_close_order']);

        challenge.start_time = 1_800_000_000;
        const response = normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));
        expect(response.challenges).toEqual([challenge]);
        expect(challenge.dataIssues).toBeUndefined();
    });

    test('a clean challenge carries no dataIssues key at all', () => {
        const challenge = validChallenge();
        normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));
        expect(challenge).not.toHaveProperty('dataIssues');
    });

    describe('logging', () => {
        test('marks log at warning level, tagged with the challenge and carrying the codes only', () => {
            const challenge = validChallenge({ start_time: 1e11 });
            normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));

            expect(logger.__mockWarningTFn).toHaveBeenCalledWith(
                'mb1c1035e9290',
                ['[Challenge 135938: Test Challenge]'],
                { codes: ['start_time', 'start_close_order'] },
            );
        });

        test('the same code set for the same id does not log again; a new set does', () => {
            const challenge = validChallenge({ start_time: 1e11 });
            const read = () =>
                normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));

            read();
            read();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(1);

            challenge.member = 'none';
            read();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(2);
            expect(logger.__mockWarningTFn).toHaveBeenLastCalledWith(
                'mb1c1035e9290',
                ['[Challenge 135938: Test Challenge]'],
                { codes: ['start_time', 'start_close_order', 'member'] },
            );
        });

        test('an id that leaves the list leaves the dedup map and logs again when it returns', () => {
            const marked = validChallenge({ id: 'gone-1', start_time: 1e11 });
            normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [marked] }));
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(1);

            normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [validChallenge()] }));
            normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [marked] }));
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(2);
        });

        test('a mark that clears and flares up again with the same codes logs again', () => {
            const challenge = validChallenge({ start_time: 1e11 });
            const read = () =>
                normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));

            read();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(1);

            // The clean read clears the mark AND the stream's memory of its codes.
            challenge.start_time = 1_800_000_000;
            read();
            expect(challenge.dataIssues).toBeUndefined();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(1);

            challenge.start_time = 1e11;
            read();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(2);
            expect(logger.__mockWarningTFn).toHaveBeenLastCalledWith(
                'mb1c1035e9290',
                ['[Challenge 135938: Test Challenge]'],
                { codes: ['start_time', 'start_close_order'] },
            );
        });

        test('a cleared incident shape forgets its stream and logs again', () => {
            const incidentRanking = (): Record<string, unknown> => ({ ...validRanking(), total: { votes: 5 } });
            const challenge = validChallenge({ member: { ...validMember(), ranking: incidentRanking() } });
            const read = () =>
                normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));

            read();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(1);
            // A repeated identical incident read stays silent (dedup), and a
            // cleared one forgets the stream, so the re-flare logs again.
            read();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(1);

            challenge.member = { ...validMember(), ranking: validRanking() };
            read();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(1);

            challenge.member = { ...validMember(), ranking: incidentRanking() };
            read();
            expect(logger.__mockWarningTFn).toHaveBeenCalledTimes(2);
            expect(logger.__mockWarningTFn).toHaveBeenLastCalledWith(
                'm890f1744e605',
                ['[Challenge 135938: Test Challenge]'],
                { codes: ['ranking.total.level'] },
            );
        });

        test('optional-field warnings log at debug level with their codes, and dedup both ways', () => {
            const challenge = validChallenge({ url: undefined });
            const read = () =>
                normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));

            read();
            expect(logger.__mockDebugFn).toHaveBeenCalledWith(
                '[Challenge 135938: Test Challenge]: optional fields could not be read — running with defaults',
                { codes: ['url'] },
            );
            read();
            expect(logger.__mockDebugFn).toHaveBeenCalledTimes(1);

            challenge.type = 5;
            read();
            expect(logger.__mockDebugFn).toHaveBeenCalledTimes(2);
            expect(logger.__mockDebugFn).toHaveBeenLastCalledWith(
                '[Challenge 135938: Test Challenge]: optional fields could not be read — running with defaults',
                { codes: ['type', 'url'] },
            );
            // A warning never lands on the mark stream.
            expect(logger.__mockWarningTFn).not.toHaveBeenCalled();
        });

        test('the incident shape logs at warning level, separate from the optional-field debug line', () => {
            const challenge = validChallenge({
                member: { ...validMember(), ranking: { ...validRanking(), total: { votes: 5 } } },
            });
            normalizeActiveChallenges(invalid<ActiveChallengesResponse>({ challenges: [challenge] }));

            expect(logger.__mockWarningTFn).toHaveBeenCalledWith(
                'm890f1744e605',
                ['[Challenge 135938: Test Challenge]'],
                { codes: ['ranking.total.level'] },
            );
            expect(logger.__mockWarningFn).not.toHaveBeenCalled();
        });
    });

    describe('the prune-unsafe warning', () => {
        test('logs once per run of consecutive unsafe reads, and resets on a safe read', () => {
            const bad = () => invalid<ActiveChallengesResponse>({ challenges: [{ title: 'no id' }, validChallenge()] });
            const good = () => invalid<ActiveChallengesResponse>({ challenges: [validChallenge()] });

            normalizeActiveChallenges(bad());
            normalizeActiveChallenges(bad());
            expect(logger.__mockWarningFn).toHaveBeenCalledTimes(1);
            expect(logger.__mockWarningFn).toHaveBeenCalledWith(
                'Unreadable challenges in the active list — title pins, per-challenge settings and metadata were not pruned',
                { dropped: 1 },
            );

            normalizeActiveChallenges(good());
            expect(logger.__mockWarningFn).toHaveBeenCalledTimes(1);

            normalizeActiveChallenges(bad());
            expect(logger.__mockWarningFn).toHaveBeenCalledTimes(2);
        });
    });
});
