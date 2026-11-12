import * as settings from '../../settings';
import * as votingLogic from '../VotingLogic';
import * as autoFill from '../autoFill';
import { oneLine } from '../../format/logSafe';
import { boostDeadline } from '../../voting/boostWindow';
import { armPinWaitWake, logBoostTarget } from './boostTargetLog';

import type { ActionContext } from './context';
import type { BoostTarget } from './boostTargetLog';

/**
 * The Boost-pinned submit: the photo pinned for Boost is submitted exactly as
 * pinned, at the scheduled Auto-Submit time when an Auto-Submit is due before
 * Boost, or at Boost time, whichever comes first. The boost lands on it through
 * the normal pinned path. A definitive submit failure latches on the entry-age
 * ledger for this challenge, photo and Boost window; a transient one retries on
 * the next due pass.
 */

/**
 * What the caller should do after this ran: `submitted` — the photo went in now;
 * `held` — an earlier pass's pending submit of it stands; `skip` — logged and
 * armed, with the cause of the failure; `fallback` — the path is not eligible.
 */
type BoostPinSubmitOutcome =
    | { kind: 'submitted'; target: BoostTarget }
    | { kind: 'held'; target: BoostTarget }
    | { kind: 'skip'; cause: 'definitive' | 'transient' | 'gone' }
    | { kind: 'fallback' };

// A server refusal and the library-walk verdicts that mean this photo can never go
// into this challenge: latched for the rest of the Boost window. Everything else is
// retried on the next due pass.
const DEFINITIVE_REASONS = new Set([
    'submit-rejected',
    'pin-refused',
    'pin-not-found',
    'pin-unreachable',
    'pin-filtered',
]);

// "Log once" for a definitive failure needs no extra guard: the latch stops any
// further attempt in this window, so this line is emitted on the last try only.
const PIN_SUBMIT_DEFINITIVE_KEY = 'mb0d7e3a91c65';
const PIN_SUBMIT_TRANSIENT_KEY = 'mb2f6a1d84b09';

/**
 * Hold an already-pending pinned photo, else submit the pinned photo when
 * eligible, else fall back to the plain wait.
 *
 * @param finalEligibility - the last live check before the submit; the
 *   Auto-Submit run passes its own, the Boost run passes none
 * @returns `submitted` / `held` — the photo to boost (submitted now, or an
 *   earlier submit's pending one); `skip` — logged and armed, boost nothing
 *   this pass; `fallback` — the path is not eligible here, the caller logs the
 *   plain wait
 */
const submitBoostPinnedPhoto = async (
    ctx: ActionContext,
    finalEligibility?: Parameters<typeof autoFill.submitPinnedEntry>[4],
): Promise<BoostPinSubmitOutcome> => {
    const { challenge, token, fillDeps, entryAges } = ctx;
    const cid = challenge.id.toString();
    const pinnedId = settings.getEntryPins(cid).boost;
    // A pinned photo an earlier pass submitted is still its pending fill: hold it
    // (no second submit while the refetch lags) before any setting check, so the
    // hold also stands with the setting just turned off.
    if (pinnedId && entryAges?.pending(cid) === pinnedId) {
        return { kind: 'held', target: { imageId: pinnedId, explicit: true, pinned: true } };
    }
    // canSubmitBoostPin reads the ledger for the latch, so without one the feature is off.
    if (entryAges === null) return { kind: 'fallback' };
    const eligible = votingLogic.canSubmitBoostPin(challenge, cid, entryAges);
    if (eligible === null) return { kind: 'fallback' };
    const filled = await autoFill.submitPinnedEntry(challenge, token, fillDeps, eligible, finalEligibility);
    if (filled.ok) {
        // An ok fill always carries the submitted imageId. No success log here —
        // the boost application is logged by the existing apply path — and no skip
        // or hold either: runBoost's skipForUncertainPhoto (a pinned target never
        // skips) and holdBoostForFreshEntry already run on every resolved target.
        const imageId = String(filled.imageId);
        autoFill.reflectNewEntry(challenge, imageId);
        entryAges.markPending(challenge, imageId, ctx.now);
        return { kind: 'submitted', target: { imageId, explicit: true, pinned: true } };
    }
    if (filled.reason === 'challenge-gone') {
        // The live re-check confirmed the challenge left the active list — the
        // same key the fill-new branch of resolveBoostTarget logs for it.
        logBoostTarget(challenge, 'm68af6d2b3623', []);
        return { kind: 'skip', cause: 'gone' };
    }
    const { reason } = filled;
    const definitive = DEFINITIVE_REASONS.has(reason);
    if (definitive) {
        entryAges.markPinSubmitFailed(challenge, eligible, boostDeadline(challenge), ctx.now);
        logBoostTarget(challenge, PIN_SUBMIT_DEFINITIVE_KEY, [oneLine(eligible), reason]);
    } else {
        // Transient (fetch-error, data-incomplete, submit-unanswered, walk-incomplete,
        // no-slots, invalid-challenge): no latch, the next due pass tries again.
        logBoostTarget(challenge, PIN_SUBMIT_TRANSIENT_KEY, [oneLine(eligible), reason]);
    }
    armPinWaitWake(ctx);
    return { kind: 'skip', cause: definitive ? 'definitive' : 'transient' };
};

export { submitBoostPinnedPhoto };
