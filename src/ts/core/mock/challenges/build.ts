/**
 * Turns a challenge spec into the full mock challenge object. Anything random
 * (exposure) is drawn here, at generation time, never in the spec tables.
 */

import type { Prize, PrizeTier } from '../../types/gurushots';
import type { ChallengeSpec, ExposureRange, RankedEntrySpec } from './types';

/**
 * Row builders for the spec tables: each emits one server-shaped row on a single
 * line, so the tables stay readable as data instead of page-wide literals.
 */

/** One `member.ranking.total.benchmark` row. */
const bench = (benchmark: string, score: string) => ({ benchmark, score });

/** One prize row, as the server shapes every prize list. */
const prize = (type: string, amount: number): Prize => ({ type, amount });

const buildRankedEntry = (entry: RankedEntrySpec) => ({
    id: entry.id,
    votes: entry.votes,
    rank: entry.rank,
    member_id: 'mock_user_001',
    adult: false,
    guru_pick: entry.guruPick,
    boost: entry.boost,
    turbo: entry.turbo,
    boosting: false,
    boosted: entry.boosted,
});

const buildExposureFactor = (factor: ExposureRange | 0) =>
    factor === 0 ? 0 : Math.min(factor.cap, Math.floor(Math.random() * factor.spread) + factor.base);

// Copied one level deep, like every emitted field: a caller mutating the built
// challenge must not corrupt the spec table the next session builds from.
const copyPrizes = (prizes: Prize[]): Prize[] => prizes.map((prize) => ({ ...prize }));

const copyPrizeTiers = (tiers: PrizeTier[]): PrizeTier[] =>
    tiers.map((tier) => ({
        ...tier,
        ...(tier.rank ? { rank: { ...tier.rank } } : {}),
        ...(tier.prizes ? { prizes: copyPrizes(tier.prizes) } : {}),
    }));

const buildMember = (spec: ChallengeSpec, now: number) => ({
    time_joined: spec.joined ? now + spec.startsIn : 0,
    boost: {
        state: spec.boost.state,
        timeout:
            spec.boost.timeout === null || spec.boost.timeout === 0
                ? spec.boost.timeout
                : now + spec.boost.timeout.availableFor,
    },
    // The key is emitted only when the spec has a turbo: a no-turbo challenge
    // reads `member.turbo` as absent, like the live payloads.
    ...(spec.turbo === undefined
        ? {}
        : {
              turbo: {
                  max_selections: 10,
                  turbo_unlock_amount: 250,
                  required_selections: 6,
                  state: spec.turbo.state,
                  mode: spec.turbo.mode ?? 'classic',
                  time_to_open: spec.turbo.opensIn === null ? null : now + spec.turbo.opensIn,
              },
          }),
    ranking: {
        total: {
            ...spec.total,
            ...(spec.benchmark ? { benchmark: spec.benchmark.map((row) => ({ ...row })) } : {}),
        },
        exposure: {
            exposure_factor: buildExposureFactor(spec.exposure.factor),
            vote_exposure_factor: spec.exposure.voteFactor,
            vote_ratio: spec.exposure.voteRatio,
        },
        entries: spec.myEntries.map(buildRankedEntry),
        ...(spec.swaps === undefined
            ? {}
            : {
                  swaps: Array.from({ length: spec.swaps }, (_, i) => ({
                      id: `swap_0${String(i + 1).padStart(2, '0')}`,
                  })),
              }),
    },
});

const buildChallenge = (spec: ChallengeSpec, id: number, now: number) => {
    const [level1, level2, level3, level4, level5] = spec.rankingLevels;
    return {
        id,
        title: spec.title,
        welcome_message: spec.welcomeMessage,
        url: spec.url,
        start_time: now + spec.startsIn,
        close_time: now + spec.closesIn,
        status: spec.status,
        entries: spec.entries,
        players: spec.players,
        votes: spec.votes,
        max_photo_submits: spec.maxPhotoSubmits,
        ...(spec.joinCoins === undefined ? {} : { join_coins: spec.joinCoins }),
        ...(spec.maxPlayers === undefined ? {} : { max_players: spec.maxPlayers }),
        badge: spec.badge,
        type: spec.type,
        tags: [...spec.tags],
        ...(spec.image ? { image: { ...spec.image } } : {}),
        prizes_worth: spec.prizesWorth,
        ranking_levels: {
            level_0: 0,
            level_1: level1,
            level_2: level2,
            level_3: level3,
            level_4: level4,
            level_5: level5,
        },
        boost_enable: spec.boostEnabled,
        turbo_enable: spec.turbo !== undefined,
        fill_enable: true,
        swap_enable: true,
        top_photo_enable: true,
        ...(spec.fillLocked === undefined ? {} : { fill_locked: spec.fillLocked }),
        ...(spec.swapLocked === undefined ? {} : { swap_locked: spec.swapLocked }),
        ...(spec.guruPickEnable === undefined ? {} : { guru_pick_enable: spec.guruPickEnable }),
        ...(spec.topPhotographerEnable === undefined ? {} : { top_photographer_enable: spec.topPhotographerEnable }),
        ...(spec.levelsRankEnable === undefined ? {} : { levels_rank_enable: spec.levelsRankEnable }),
        ...(spec.newRankingEnable === undefined ? {} : { new_ranking_enable: spec.newRankingEnable }),
        ...(spec.firstPrizes ? { first_prizes: copyPrizes(spec.firstPrizes) } : {}),
        ...(spec.achievementsAndPrizes ? { achievements_and_prizes: copyPrizeTiers(spec.achievementsAndPrizes) } : {}),
        time_left: { ...spec.timeLeft },
        member: buildMember(spec, now),
        ...(spec.teamMatch
            ? {
                  teamMatch: {
                      us: { ...spec.teamMatch.us },
                      them: { ...spec.teamMatch.them },
                      ...(spec.teamMatch.running === undefined ? {} : { running: spec.teamMatch.running }),
                      ...(spec.teamMatch.me !== undefined
                          ? { me: spec.teamMatch.me === null ? null : { ...spec.teamMatch.me } }
                          : {}),
                  },
              }
            : {}),
    };
};

export { bench, prize, copyPrizes, buildChallenge };
