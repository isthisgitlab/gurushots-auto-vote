import * as logger from '../../logger';
import * as settings from '../../settings';
import * as votingLogic from '../VotingLogic';
import { boostDeadline } from '../../voting/boostWindow';

import type { Challenge } from '../../types/gurushots';
import type { ActionContext } from './context';

/**
 * What a boost target is and how it is logged: the pieces the boost runner and
 * the Boost-pinned submit share. A leaf on purpose — the two modules must not
 * import each other, so what they both need lives here.
 */

// `explicit`: sent by id (boostEntryById), not left to applyBoost's own pick.
// `pinned`: the photo the user pinned for Boost, which counts as their confirmation of it.
// `atRelease`: a photo pinned for Turbo, boosted at the instant its pin gives way (sleep boost only).
export type BoostTarget = { imageId: string; explicit: boolean; pinned?: boolean; atRelease?: boolean };

export const logBoostTarget = (challenge: Challenge, key: string, params: unknown[]) => {
    logger.withCategory('boost').infoT(key, [logger.challengeTag(challenge), ...params], null);
};

// The fill submits the photo in its boundary pass; +60 s puts the next cycle just after it. The
// same 60 s clamps the wake to `boostDeadline − 60`, mirroring BOOST_HOLD_MARGIN_SEC in
// getBoostHoldUntil, so one last poll still happens before the boost dies.
const PIN_WAIT_WAKE_GAP_SEC = 60;

/**
 * While a Boost pin waits for its photo (the photo is not in the challenge yet), arm a wake just
 * after the fill boundary that should submit it — but only when a fill will plausibly run: the
 * autoSubmit toggle on for the challenge and a schedule threshold still ahead of now. Without the
 * toggle, a configured-but-disabled schedule would re-arm `now + 60` every pass: a per-minute
 * wake/log loop. A boundary already overdue sets no hold either (the fill's window opened but the
 * photo did not land); normal cadence re-checks, and the per-pass skip log stays.
 */
export const armPinWaitWake = ({ challenge, now }: ActionContext) => {
    const cid = challenge.id.toString();
    if (settings.getEffectiveSetting('autoSubmit', cid) !== true) return;
    const fillThresholdSec = votingLogic.getAutoFillThresholdSec(challenge, cid);
    const closeTime = Number(challenge.close_time);
    // A malformed close_time would pass NaN through both `<=` guards below and set a NaN hold;
    // every sibling fill-instant computation guards the same way.
    if (fillThresholdSec <= 0 || !Number.isFinite(closeTime)) return;
    const fillBoundary = closeTime - fillThresholdSec;
    if (fillBoundary <= now) return;
    const wakeAt = Math.min(fillBoundary + PIN_WAIT_WAKE_GAP_SEC, boostDeadline(challenge) - PIN_WAIT_WAKE_GAP_SEC);
    if (wakeAt <= now) return;
    challenge.boostHoldUntil = wakeAt;
};
