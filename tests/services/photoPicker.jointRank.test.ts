import type * as jointRankModule from '../../src/ts/core/services/photoPicker/jointRank';
import type { JointEntry } from '../../src/ts/core/services/photoPicker/jointRank';
import type { ScoredCandidate } from '../../src/ts/core/types/photoPicker';
import { invalid } from '../helpers/invalid';

const { OFF_THEME_MARGIN, jointInputsOf, jointOrder } =
    require('../../src/ts/core/services/photoPicker/jointRank') as typeof jointRankModule;

/** One accepted photo: on theme at bucket 76, full support, a lexical hit, no suggestion, stats unknown. */
const entry = (id: string, overrides: Partial<JointEntry> = {}): JointEntry => ({
    id,
    themeMatch: true,
    shouldMatchCount: 0,
    semantic: 76,
    semanticSupport: 3,
    score: 3,
    suggested: false,
    fit: -4,
    votes: 0,
    statsKnown: false,
    ...overrides,
});

/** The floor jointOrder reads: the best fit minus the off-theme margin. */
const floorOf = (entries: JointEntry[]) => Math.max(...entries.map((item) => item.fit)) - OFF_THEME_MARGIN;
const order = (entries: JointEntry[]) => jointOrder(entries, { floor: floorOf(entries) });

describe('jointOrder', () => {
    test('the logged "Everything Sports" case picks the soccer photo', () => {
        // Same theme tiers (bucket 76, support 3, lexical 3); fits are the means of the logged logits.
        const golf = entry('golf', {
            fit: (-3.910000802633653 + -6.20046662189218) / 2,
            votes: 5470,
            statsKnown: true,
        });
        const soccer = entry('soccer', {
            fit: (-2.647967318348275 + -5.779306397868556) / 2,
            votes: 68596,
            statsKnown: true,
        });
        const { ids, breakdown } = order([golf, soccer]);
        expect(ids).toEqual(['soccer', 'golf']);
        expect(breakdown.soccer.vision_n).toBeCloseTo(1, 10);
        expect(breakdown.soccer.votes_n).toBeCloseTo(1, 10);
        expect(breakdown.golf.vision_n).toBeCloseTo(0.63, 2);
        expect(breakdown.golf.votes_n).toBeCloseTo(0.77, 2);
        // theme_n on the fixed scale: 0.7 * (76 - 46) / 54 + 0.2 + 0.1
        expect(breakdown.golf.theme_n).toBeCloseTo((0.7 * 30) / 54 + 0.3, 10);
        expect(breakdown.soccer.joint).toBeCloseTo(
            breakdown.soccer.theme_n + breakdown.soccer.vision_n + breakdown.soccer.votes_n,
            10,
        );
    });

    test('a much stronger theme match still beats a more popular photo', () => {
        const strong = entry('strong', { semantic: 100, fit: -4, votes: 10, statsKnown: true });
        const popular = entry('popular', {
            semantic: 46,
            semanticSupport: 0,
            score: 0,
            fit: -4.5,
            votes: 90000,
            statsKnown: true,
        });
        expect(order([popular, strong]).ids).toEqual(['strong', 'popular']);
    });

    test('an unmatched photo with the top fit and votes stays behind a matched one', () => {
        const unmatched = entry('unmatched', {
            themeMatch: false,
            semantic: 0,
            semanticSupport: 0,
            score: 0,
            fit: -1,
            votes: 90000,
            statsKnown: true,
        });
        const matched = entry('matched', {
            semantic: 46,
            semanticSupport: 0,
            score: 1,
            fit: -3,
            votes: 5,
            statsKnown: true,
        });
        const { ids, breakdown } = order([unmatched, matched]);
        expect(ids).toEqual(['matched', 'unmatched']);
        // Each is alone in its gate group: nothing is weighed.
        expect(breakdown).toEqual({});
    });

    test('a photo with more Should Include Tags stays ahead however the rest compares', () => {
        const fewer = entry('fewer', { shouldMatchCount: 1, fit: -1, votes: 90000, statsKnown: true });
        const more = entry('more', {
            shouldMatchCount: 2,
            semantic: 0,
            semanticSupport: 0,
            score: 0,
            fit: -3,
            votes: 1,
            statsKnown: true,
        });
        expect(order([fewer, more]).ids).toEqual(['more', 'fewer']);
    });

    test('the gates order the groups even when the entries arrive out of tier order', () => {
        const ids = order([
            entry('none', { themeMatch: false }),
            entry('one', { shouldMatchCount: 1 }),
            entry('two', { shouldMatchCount: 2 }),
            entry('zero'),
        ]).ids;
        expect(ids).toEqual(['two', 'one', 'zero', 'none']);
    });

    test('a photo with known 0 votes loses to one with unknown stats (neutral 0.5)', () => {
        const zero = entry('zero', { votes: 0, statsKnown: true });
        const unknown = entry('unknown', { votes: 0, statsKnown: false });
        const popular = entry('popular', { votes: 1000, statsKnown: true });
        const { ids, breakdown } = order([zero, unknown, popular]);
        expect(ids).toEqual(['popular', 'unknown', 'zero']);
        expect(breakdown.unknown.votes_n).toBe(0.5);
        expect(breakdown.zero.votes_n).toBe(0);
    });

    test('a flat votes:0 on a photo whose stats are unknown is never read as zero votes', () => {
        const { breakdown } = order([entry('a'), entry('b', { votes: 500, statsKnown: true })]);
        expect(breakdown.a.votes_n).toBe(0.5);
    });

    test('all known votes zero: every known photo scores 1, and nothing is NaN', () => {
        const { ids, breakdown } = order([
            entry('a', { votes: 0, statsKnown: true }),
            entry('b', { votes: 0, statsKnown: true }),
        ]);
        expect(ids).toEqual(['a', 'b']);
        expect(breakdown.a.votes_n).toBe(1);
        expect(breakdown.b.votes_n).toBe(1);
        expect(Object.values(breakdown).every((terms) => Object.values(terms).every(Number.isFinite))).toBe(true);
    });

    test('no known stats in the group: every photo is neutral, with no NaN or -Infinity', () => {
        const { breakdown } = order([entry('a', { fit: -3 }), entry('b', { fit: -4 })]);
        expect(Object.values(breakdown).map((terms) => terms.votes_n)).toEqual([0.5, 0.5]);
        expect(Object.values(breakdown).every((terms) => Object.values(terms).every(Number.isFinite))).toBe(true);
    });

    test('a single entry and an empty list have nothing to weigh', () => {
        expect(order([entry('only')])).toEqual({ ids: ['only'], breakdown: {} });
        expect(jointOrder([], { floor: 0 })).toEqual({ ids: [], breakdown: {} });
    });

    test('exact ties keep the incoming order', () => {
        expect(order([entry('first'), entry('second'), entry('third')]).ids).toEqual(['first', 'second', 'third']);
    });

    test('the suggested bonus lifts a suggested photo over a slightly stronger theme match', () => {
        const stronger = entry('stronger', { semantic: 80 });
        const suggested = entry('suggested', { semantic: 76, suggested: true });
        const { ids, breakdown } = order([stronger, suggested]);
        expect(ids).toEqual(['suggested', 'stronger']);
        expect(breakdown.suggested.joint - breakdown.suggested.theme_n - breakdown.suggested.vision_n).toBeCloseTo(
            0.25 + 0.5,
            10,
        );
    });

    test('support and the lexical match move the order inside a group', () => {
        const base = entry('base', { semanticSupport: 1, score: 0 });
        const supported = entry('supported', { semanticSupport: 3, score: 0 });
        const lexical = entry('lexical', { semanticSupport: 1, score: 2 });
        const { ids, breakdown } = order([base, lexical, supported]);
        expect(ids).toEqual(['supported', 'lexical', 'base']);
        expect(breakdown.supported.theme_n - breakdown.base.theme_n).toBeCloseTo((0.2 * 2) / 3, 10);
        expect(breakdown.lexical.theme_n - breakdown.base.theme_n).toBeCloseTo(0.1, 10);
    });

    test('a semantic bucket under the floor adds nothing, and a bucket over 100 adds no more than 100', () => {
        const { breakdown } = order([
            entry('under', { semantic: 10, semanticSupport: 0, score: 0 }),
            entry('over', { semantic: 140, semanticSupport: 0, score: 0 }),
        ]);
        expect(breakdown.under.theme_n).toBe(0);
        expect(breakdown.over.theme_n).toBeCloseTo(0.7, 10);
    });

    test('the support term stops at the cap', () => {
        const { breakdown } = order([
            entry('capped', { semanticSupport: 9, score: 0 }),
            entry('cap', { semanticSupport: 3, score: 0 }),
        ]);
        expect(breakdown.capped.theme_n).toBeCloseTo(breakdown.cap.theme_n, 10);
    });

    test('a fit under the floor scores 0 on vision', () => {
        const { breakdown } = jointOrder([entry('a', { fit: -9 }), entry('b', { fit: -4 })], { floor: -6 });
        expect(breakdown.a.vision_n).toBe(0);
        expect(breakdown.b.vision_n).toBeCloseTo(2 / Math.log(10), 10);
    });
});

describe('jointInputsOf', () => {
    const candidate = (overrides: Partial<ScoredCandidate> = {}): ScoredCandidate =>
        invalid<ScoredCandidate>({
            id: 'p1',
            photo: { id: 'p1' },
            shouldMatchCount: 0,
            semantic: 0,
            semanticSupport: 0,
            score: 0,
            suggested: false,
            statsKnown: false,
            achievementCount: 0,
            votes: 0,
            views: 0,
            uploadDate: 0,
            ...overrides,
        });

    test('reads the tier values and whether the photo matched the theme at all, keyed by id text', () => {
        const inputs = jointInputsOf([
            candidate({ id: 'p1' }),
            invalid<ScoredCandidate>({
                ...candidate({ semantic: 76, semanticSupport: 2, score: 3, suggested: true }),
                id: 7,
            }),
        ]);
        expect(inputs.get('p1')).toEqual({
            themeMatch: false,
            shouldMatchCount: 0,
            semantic: 0,
            semanticSupport: 0,
            score: 0,
            suggested: false,
        });
        expect(inputs.get('7')).toEqual({
            themeMatch: true,
            shouldMatchCount: 0,
            semantic: 76,
            semanticSupport: 2,
            score: 3,
            suggested: true,
        });
    });
});
