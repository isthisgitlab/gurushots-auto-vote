/**
 * Types for the renderer's pure utils (src/ts/react/utils/). Type-only:
 * nothing here exists at runtime.
 */
import type { Challenge, ChallengeMember, MemberRanking, RankingExposure } from './gurushots';

/**
 * A challenge whose member standing and exposure figure are present — what the
 * challenge card and the low-exposure list read without guards. Active
 * challenges from get_my_active_challenges always carry them.
 */
export type RankedChallenge = Challenge & {
    member: ChallengeMember & {
        ranking: MemberRanking & { exposure: RankingExposure & { exposure_factor: number } };
    };
};
