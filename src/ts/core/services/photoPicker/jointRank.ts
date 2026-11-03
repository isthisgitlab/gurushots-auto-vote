/**
 * Photo picker — the joint ranking of photos the vision check accepted: theme
 * strength, vision fit and votes weighed together instead of one after another.
 *
 * It runs inside ONE gate group only, never across one: matched photos stay
 * ahead of unmatched ones (`themeMatch`), and a photo matching more of the
 * user's Should Include Tags stays ahead of one matching fewer
 * (`shouldMatchCount`). Within a group the three signals count equally:
 *
 *   joint   = theme_n + vision_n + votes_n + suggested_bonus
 *   theme_n = 0.7·sem + 0.2·min(support, cap)/cap + 0.1·(lexical score > 0)
 *             sem = (semantic bucket − SEMANTIC_MATCH_FLOOR) / (100 − SEMANTIC_MATCH_FLOOR), clamped 0..1.
 *             The scale is fixed, so a one-point bucket gap stays small; support (tier 3) and the lexical match
 *             (tier 4) keep a smaller weight of their own rather than the exact-tie role they would never get
 *             once the buckets are floats.
 *   vision_n = (fit − floor) / OFF_THEME_MARGIN, clamped 0..1
 *   votes_n  = log1p(votes) / log1p(the most votes known in the group); 1 when every known photo has 0 votes;
 *             0.5 (neutral) for a photo whose stats are not known — read from `statsKnown`, never from a flat
 *             `votes: 0`, which is missing data and not a measurement
 *   suggested_bonus = 0.25 for a photo GuruShots suggests (join picks only): the stand-in for tier 5 once the
 *             tiers stop being lexicographic. The weight is a judgement, about 13 semantic-bucket points.
 *
 * Exact ties keep the incoming (tier) order.
 */

import { SEMANTIC_MATCH_FLOOR, SEMANTIC_SUPPORT_CAP, hasThemeMatch } from './tiers';

import type { ScoredCandidate } from '../../types/photoPicker';

// A photo scoring 10x less likely than the best match is off-theme (the aerial
// island under "Green Leaves" sat ~7 logits below the leaf photos).
const OFF_THEME_MARGIN = Math.log(10);

const SEMANTIC_WEIGHT = 0.7;
const SUPPORT_WEIGHT = 0.2;
const LEXICAL_WEIGHT = 0.1;
const SUGGESTED_BONUS = 0.25;
const UNKNOWN_VOTES_N = 0.5;

/** What one photo's tiers say about the theme; read off its ScoredCandidate. */
export interface JointInput {
    themeMatch: boolean;
    shouldMatchCount: number;
    semantic: number;
    semanticSupport: number;
    /** The lexical tag-match score (tier 4). */
    score: number;
    suggested: boolean;
}

/** A photo's votes as the stats lookup left them; `statsKnown` false means the number is missing, not zero. */
export interface VoteStat {
    votes: number;
    statsKnown: boolean;
}

/** One photo as jointOrder reads it: its tier values plus the vision fit and the votes. */
export interface JointEntry extends JointInput, VoteStat {
    id: string;
    /** Mean of the per-prompt logits. */
    fit: number;
}

/** One photo's terms, for the log. */
export interface JointScore {
    theme_n: number;
    vision_n: number;
    votes_n: number;
    joint: number;
}

export type JointBreakdown = Record<string, JointScore>;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The tier values of every candidate, by id, as jointOrder wants them. */
const jointInputsOf = (scored: readonly ScoredCandidate[]): Map<string, JointInput> =>
    new Map(
        scored.map((entry) => [
            String(entry.id),
            {
                themeMatch: hasThemeMatch(entry),
                shouldMatchCount: entry.shouldMatchCount,
                semantic: entry.semantic,
                semanticSupport: entry.semanticSupport,
                score: entry.score,
                suggested: entry.suggested,
            },
        ]),
    );

const themeN = (entry: JointEntry): number => {
    const sem = clamp01((entry.semantic - SEMANTIC_MATCH_FLOOR) / (100 - SEMANTIC_MATCH_FLOOR));
    const support = Math.min(entry.semanticSupport, SEMANTIC_SUPPORT_CAP) / SEMANTIC_SUPPORT_CAP;
    return SEMANTIC_WEIGHT * sem + SUPPORT_WEIGHT * support + (entry.score > 0 ? LEXICAL_WEIGHT : 0);
};

const votesN = (entry: JointEntry, knownMax: number): number => {
    if (!entry.statsKnown) return UNKNOWN_VOTES_N;
    return knownMax === 0 ? 1 : Math.log1p(entry.votes) / Math.log1p(knownMax);
};

/** One gate group's order and terms. */
const scoreGroup = (group: JointEntry[], floor: number): Array<{ entry: JointEntry; terms: JointScore }> => {
    const knownMax = Math.max(0, ...group.filter((entry) => entry.statsKnown).map((entry) => entry.votes));
    return group.map((entry) => {
        const vision_n = clamp01((entry.fit - floor) / OFF_THEME_MARGIN);
        const votes_n = votesN(entry, knownMax);
        const theme_n = themeN(entry);
        const joint = theme_n + vision_n + votes_n + (entry.suggested ? SUGGESTED_BONUS : 0);
        return { entry, terms: { theme_n, vision_n, votes_n, joint } };
    });
};

/**
 * Order photos the vision check accepted. The gates come first: matched photos
 * before unmatched ones, then more Should Include Tags before fewer; the
 * joint score only orders photos inside one such group. A group of one has
 * nothing to order and is left out of the breakdown.
 *
 * @param entries - in tier order (the order a tie falls back to)
 * @param floor - the vision floor: the best fit minus OFF_THEME_MARGIN
 * @returns the ids in order, and each scored photo's terms by id
 */
const jointOrder = (
    entries: readonly JointEntry[],
    { floor }: { floor: number },
): { ids: string[]; breakdown: JointBreakdown } => {
    const gated = entries
        .slice()
        .sort((a, b) => Number(b.themeMatch) - Number(a.themeMatch) || b.shouldMatchCount - a.shouldMatchCount);
    const groups: JointEntry[][] = [];
    for (const entry of gated) {
        const last = groups[groups.length - 1];
        if (last && last[0].themeMatch === entry.themeMatch && last[0].shouldMatchCount === entry.shouldMatchCount) {
            last.push(entry);
        } else {
            groups.push([entry]);
        }
    }
    const ids: string[] = [];
    const breakdown: JointBreakdown = {};
    for (const group of groups) {
        if (group.length < 2) {
            ids.push(group[0].id);
            continue;
        }
        const scored = scoreGroup(group, floor).sort((a, b) => b.terms.joint - a.terms.joint);
        for (const { entry, terms } of scored) {
            ids.push(entry.id);
            breakdown[entry.id] = terms;
        }
    }
    return { ids, breakdown };
};

export { OFF_THEME_MARGIN, jointInputsOf, jointOrder };
