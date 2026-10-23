/**
 * Shapes of the GuruShots API payloads the app reads. Type-only: nothing here
 * exists at runtime. Modules pull them in with
 * `import type { Challenge } from '../types/gurushots'`.
 *
 * Nested objects and most fields are optional on purpose. The data comes off
 * the network, and the code optional-chains every per-challenge read (an
 * unguarded throw would abort the whole voting pass), so the types describe
 * what may arrive rather than what usually does.
 *
 * The shapes live in the type-only siblings under `gurushots/` and are
 * re-exported here, so every caller keeps importing this module.
 */

export type { SuccessResponse, ActionResult } from './gurushots/base';
export type { EntryEnteredTime, RankingEntry, RankingTotal, RankingExposure, MemberRanking } from './gurushots/ranking';
export type {
    BoostState,
    MemberBoost,
    MemberTurbo,
    RewardsBySection,
    Prize,
    PrizeTier,
    ChallengeMember,
    Challenge,
    ActiveChallengesResponse,
    WebActiveChallengesResponse,
    MemberChallengesResponse,
    DiscoverChallenge,
    OpenChallenge,
    ChosenAnnotation,
    CompletedChallenge,
    CompletedChallengesResponse,
} from './gurushots/challenges';
export type { TeamStanding, TeamMatch, TeamsResponse, MatchResponse } from './gurushots/teams';
export type {
    VoteImage,
    VoteImagesResponse,
    ChallengeTurboResponse,
    TurboBattleSet,
    TurboSelectionResponse,
    TurboSelectionResult,
    StartTurboSessionResponse,
    SnapVoteResponse,
    SnapImage,
    TurboSession,
    SnapVoteResult,
    TurboMiniGameResult,
    SnapStopReason,
    SnapGameResult,
    TurboGameResult,
} from './gurushots/voting';
export type {
    LoginResponse,
    BankrollResponse,
    Bankroll,
    LibraryPhoto,
    PhotosPrivateResponse,
    ImageRecord,
    ImageDataResponse,
    CurrentMemberProfileResponse,
    MemberIdentity,
    SearchAutocompleteResponse,
    Mission,
    MissionsResponse,
} from './gurushots/member';
