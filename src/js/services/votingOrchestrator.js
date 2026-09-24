/**
 * The voting-pass orchestration shared by BOTH API strategies
 * (strategies/real and mock/index.js): the mock runs the identical strategy
 * path over its fake endpoints, so auto-fill, emergency fill, turbo-earn and
 * the timer-ordered deadline actions behave the same in both modes.
 *
 * `deps.api` is the endpoint set (real api/* modules or mockApiClient — the
 * same surface apiFactory's ApiStrategy describes minus authenticate and
 * this function itself). Strategy-specific behavior is injected:
 *   - interChallengeDelay: real mode mimics a human (2-5s random); mock
 *     uses a short fixed delay.
 *   - cleanupStaleMetadata: real mode prunes stale per-challenge metadata;
 *     mock passes null — the metadata store is SHARED and un-namespaced,
 *     and mock challenge ids never match real ones, so running cleanup in
 *     mock mode would purge the user's real voting metadata.
 *
 * Runners execute SEQUENTIALLY by design: auto-fill mutates the shared
 * challenge object (reflectNewEntry) so a later turbo/boost in the same
 * cycle sees the consumed slot and new entry. Do not parallelize them.
 *
 * @param {string} token
 * @param {string|number|null} challengeIdFilter - restricts the strategy pass
 *   to one challenge (per-card "Run"); stale-metadata cleanup still runs
 *   against the full active list first.
 * @param {{
 *   api: {
 *     getActiveChallenges: Function,
 *     getVoteImages: Function,
 *     submitVotes: Function,
 *     applyBoost: Function,
 *     applyBoostToEntry: Function,
 *     applyTurbo: Function,
 *     getEligiblePhotos: Function,
 *     submitToChallenge: Function,
 *     runTurboMiniGame: Function,
 *   },
 *   cleanupStaleMetadata: (Function|null),
 *   interChallengeDelay: () => number,
 *   entryTracker?: ({get: Function, set: Function}|null),
 *   currency?: ({strategy: Object, swapLedger: Object, spendLedger: Object}|null),
 * }} deps
 *   `entryTracker` backs the voteOnNewEntry feature. Real mode passes a
 *   metadata.json-backed tracker; mock passes an in-memory one for the same reason
 *   it passes cleanupStaleMetadata: null — the metadata store is shared and
 *   un-namespaced, and mock challenge ids would accumulate there unpruned. Omitting
 *   it entirely makes the feature inert.
 *   `currency` backs the automatic key / swap / fill spends (services/currencyAuto.js):
 *   `strategy` is the endpoint set the spend services take (the same shape the manual
 *   currency handlers pass), `swapLedger` the swap-back ledger and `spendLedger` the
 *   automatic-fill counter. Mock passes in-memory ledgers for the same reason it passes
 *   cleanupStaleMetadata: null. Omitting it makes the automation inert.
 * @returns {Promise<{success:boolean, message?:string, error?:string, challenges?:Array}>}
 *   `challenges` is the full active list this cycle fetched (not the
 *   filtered subset) so callers can reuse it for threshold scheduling.
 */

const logger = require('../logger');
const settings = require('../settings');
const votingLogic = require('./VotingLogic');
const autoFill = require('./autoFill');
const photoStats = require('./photoStats');
const newEntryTracker = require('./newEntryTracker');
const currencyAuto = require('./currencyAuto');
const cancellation = require('../voting/cancellation');
const { formatDuration } = require('../format/duration');
const { failureText } = require('../format/logSafe');
const { sleep } = require('../timing');

/**
 * Per-challenge context threaded to every deadline-action runner. All of a
 * runner's per-pass state comes through here explicitly — module-scope
 * imports (logger, settings, votingLogic, autoFill, formatDuration) are the
 * only other things they touch.
 *
 * @typedef {{
 *   challenge: Object,
 *   token: string,
 *   now: number,
 *   api: Object,
 *   fillDeps: Object,
 * }} ActionContext
 */

/** @param {ActionContext} ctx */
const runBoost = async (ctx) => {
    const { challenge, token, now, api, fillDeps } = ctx;
    // Check if boost is available for this challenge. Optional-chained to match
    // shouldApplyBoost/shouldApplyTurbo, which already guard the same tree: a payload
    // without `member` used to throw straight out of the per-action loop.
    const boost = challenge?.member?.boost || {};
    const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
    const isTimerBasedAvailable = boost.state === 'AVAILABLE' && hasTimeout;
    const isKeyUnlockedAvailable = boost.state === 'AVAILABLE_KEY' || (boost.state === 'AVAILABLE' && !hasTimeout);
    if (!isTimerBasedAvailable && !isKeyUnlockedAvailable) return;

    logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost available`, null);

    // Use the centralized voting logic service for boost decisions.
    // emergency:true lets shouldApplyBoost apply an available boost
    // near the deadline even if autoBoost is off for this challenge.
    const shouldApplyBoost = votingLogic.shouldApplyBoost(challenge, now, { emergency: true });
    const effectiveBoostTime = votingLogic.getEffectiveBoostTime(challenge.id.toString());
    // For timer-based availability use boost.timeout; for key-unlocked use challenge end time
    const timeUntilDisplayBase = isTimerBasedAvailable ? boost.timeout - now : challenge.close_time - now;

    if (shouldApplyBoost) {
        // Surface the override so an applied boost on a challenge with
        // Auto-Apply Boost off is explained rather than looking like a bug.
        if (!settings.getEffectiveSetting('autoBoost', challenge.id.toString())) {
            logger
                .withCategory('boost')
                .info(
                    `${logger.challengeTag(challenge)} Emergency Fill window — applying available boost despite Auto-Apply Boost being off`,
                    null,
                );
        }
        const timeDisplay = formatDuration(timeUntilDisplayBase);

        const applyingMsg = isTimerBasedAvailable
            ? `Applying boost to challenge ${challenge.title}`
            : `Applying boost to challenge ${challenge.title} (key-unlocked)`;
        logger.withCategory('boost').startOperation(`boost-${challenge.id}`, applyingMsg);

        try {
            const cid = challenge.id.toString();
            // 'always' = boostFillNew; 'conflict' = boostFillNewOnConflict when
            // the only existing entry is turboed; 'no' = boost an existing entry.
            const fillMode = votingLogic.resolveBoostFillNewMode(challenge, cid);
            let boostResult;
            if (fillMode !== 'no') {
                // Fill-new: submit a fresh photo and boost that entry instead
                // of an existing one.
                const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
                if (filled.ok) {
                    autoFill.reflectNewEntry(challenge, filled.imageId);
                    boostResult = await api.applyBoostToEntry(cid, filled.imageId, token);
                    if (boostResult) {
                        // applyBoost raises this flag itself (it owns the entry pick);
                        // the explicit-entry call cannot, so reflect it here.
                        autoFill.reflectEntryFlag(challenge, filled.imageId, 'boosted');
                    } else {
                        // applyBoostToEntry logs its own apply-boost-entry-* operation,
                        // but the outer boost-<id> operation opened above would dangle
                        // open on failure (the applyBoost fallback path closes its own).
                        logger
                            .withCategory('boost')
                            .endOperation(`boost-${challenge.id}`, null, 'boost apply to fresh entry failed');
                        return;
                    }
                } else if (filled.reason === 'challenge-gone') {
                    // The live re-check confirmed the challenge left the
                    // active list — boosting an existing entry on it would
                    // just be a second failing call and a confusing log.
                    logger
                        .withCategory('boost')
                        .endOperation(`boost-${challenge.id}`, null, 'challenge left the active list — boost skipped');
                    return;
                } else if (fillMode === 'conflict') {
                    // On-conflict mode only fires when the single existing entry is
                    // already turboed, so there is no valid fallback target — an
                    // applyBoost here would just fail with "only entry already has
                    // Turbo". Skip instead of making the pointless call.
                    logger
                        .withCategory('boost')
                        .endOperation(
                            `boost-${challenge.id}`,
                            null,
                            `boost fill-new unavailable (${filled.reason}); only entry already has Turbo — boost skipped`,
                        );
                    return;
                } else {
                    // 'always' mode falls back to the configured Boost Entry when
                    // no fresh photo can be submitted (full / none / failed).
                    logger
                        .withCategory('boost')
                        .info(
                            `${logger.challengeTag(challenge)} boost fill-new unavailable (${filled.reason}); boosting existing entry`,
                            null,
                        );
                    boostResult = await api.applyBoost(challenge, token);
                }
            } else {
                boostResult = await api.applyBoost(challenge, token);
            }
            if (boostResult) {
                const successSuffix = isTimerBasedAvailable
                    ? `${timeDisplay} remaining`
                    : `${timeDisplay} until challenge ends`;
                logger
                    .withCategory('boost')
                    .endOperation(`boost-${challenge.id}`, `Boost applied successfully (${successSuffix})`);
            }
            // On null/falsy result, applyBoost already logged endOperation with the failure
            // reason — no caller-side fallback log needed (mirrors the turbo handling shape).
        } catch (error) {
            logger.withCategory('boost').endOperation(`boost-${challenge.id}`, null, failureText(error));
        }
    } else {
        const timeDisplay = formatDuration(timeUntilDisplayBase);
        // Both branches render the threshold they actually use. The key-unlocked message
        // used to hardcode "10m" while the code applied at 15, which misled anyone
        // debugging it; it is now a setting, so read it rather than restating a constant.
        const keyUnlockedWindow = votingLogic.getEffectiveKeyUnlockedBoostTime(challenge.id.toString());
        const reason = isTimerBasedAvailable
            ? `${timeDisplay} until deadline (threshold: ${effectiveBoostTime / 60}m)`
            : `${timeDisplay} until challenge ends (needs ≤ ${Math.round(keyUnlockedWindow / 60)}m to auto-apply)`;
        logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost not ready - ${reason}`, null);
    }
};

/** @param {ActionContext} ctx */
const runTurboApply = async (ctx) => {
    const { challenge, token, now, api, fillDeps } = ctx;
    // Auto-apply a won turbo when eligible. emergency:true lets
    // shouldApplyTurbo apply a won turbo near the deadline even if
    // Auto-Apply Turbo (useTurbo) is off for this challenge.
    const turboApply = votingLogic.shouldApplyTurbo(challenge, now, { emergency: true });
    if (!turboApply.apply) return;

    // Surface the override so an applied turbo on a challenge with
    // Auto-Apply Turbo off is explained rather than looking like a bug.
    if (!settings.getEffectiveSetting('useTurbo', challenge.id.toString())) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} Emergency Fill window — applying won turbo despite Auto-Apply Turbo being off`,
                null,
            );
    }

    let imageId = turboApply.imageId;
    if (turboApply.fillNew) {
        // Fill-new: submit a fresh photo and turbo that entry instead of an
        // existing one. Falls back to the configured Turbo Entry (if any)
        // when no fresh photo can be submitted (full / none / failed).
        const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
        if (filled.ok) {
            autoFill.reflectNewEntry(challenge, filled.imageId);
            imageId = filled.imageId;
        } else if (filled.reason === 'challenge-gone') {
            // The live re-check confirmed the challenge left the active
            // list — applying turbo to an existing entry on it would just
            // be a second failing call and a confusing log.
            logger
                .withCategory('turbo')
                .info(
                    `${logger.challengeTag(challenge)} turbo fill-new: challenge left the active list — turbo skipped`,
                    null,
                );
            return;
        } else if (imageId) {
            logger
                .withCategory('turbo')
                .info(
                    `${logger.challengeTag(challenge)} turbo fill-new unavailable (${filled.reason}); applying to existing entry`,
                    null,
                );
        }
    }
    if (!imageId) {
        // fill-new was requested but no fresh photo could be submitted, so
        // imageId never resolved. The two ways to land here need different
        // logs: in the on-conflict (or always-blocked) path an entry DOES
        // exist — it just already has Boost, so turbo cannot go on it and
        // there is no valid fallback; only in always mode on an empty
        // challenge is there genuinely no entry at all.
        const hasExistingEntry = (challenge?.member?.ranking?.entries?.length ?? 0) > 0;
        const skipReason = hasExistingEntry
            ? 'only entry already has Boost — turbo skipped'
            : 'could not submit a fresh photo and there is no existing entry — turbo skipped';
        logger.withCategory('turbo').info(`${logger.challengeTag(challenge)} turbo fill-new ${skipReason}`, null);
    } else {
        logger
            .withCategory('turbo')
            .startOperation(`turbo-apply-${challenge.id}`, `Applying turbo to entry ${imageId} on ${challenge.title}`);
        try {
            const result = await api.applyTurbo(challenge.id, imageId, token);
            if (result.ok) {
                // Mark the entry so a boost running later in this same pass avoids it.
                autoFill.reflectEntryFlag(challenge, imageId, 'turbo');
                logger
                    .withCategory('turbo')
                    .endOperation(`turbo-apply-${challenge.id}`, `Turbo applied to entry ${imageId}`);
            } else {
                logger
                    .withCategory('turbo')
                    .endOperation(`turbo-apply-${challenge.id}`, null, 'Apply request returned ok=false');
            }
        } catch (error) {
            logger.withCategory('turbo').endOperation(`turbo-apply-${challenge.id}`, null, failureText(error));
        }
    }
};

/** @param {ActionContext} ctx */
const runAutoFill = async (ctx) => {
    const { challenge, token, now, fillDeps } = ctx;
    // Auto-fill missing entries near deadline (one slot per cycle, staggered).
    // On submit it reflects the new entry locally, so a turbo/boost that runs
    // later this cycle (timer order) acts on it instead of waiting a cycle.
    const fillResult = await autoFill.maybeAutoFillChallenge(challenge, token, now, fillDeps);
    if (fillResult === 'submitted') {
        logger
            .withCategory('voting')
            .info(
                `${logger.challengeTag(challenge)} autoFill: entry submitted (available to later actions this cycle)`,
                null,
            );
    }
};

/** @param {ActionContext} ctx */
const runEmergencyFill = async (ctx) => {
    const { challenge, token, now, fillDeps } = ctx;
    // Emergency fill: net for slots that staggered auto-fill leaves
    // empty (auto-fill off, or tags set with no match) — fills all
    // remaining slots once the challenge is inside the emergency window.
    const emergencyResult = await autoFill.maybeEmergencyFillChallenge(challenge, token, now, fillDeps);
    if (emergencyResult === 'submitted') {
        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} emergencyFill: entries submitted near deadline`, null);
    }
};

const actionRunners = {
    boost: runBoost,
    turbo: runTurboApply,
    autoFill: runAutoFill,
    emergencyFill: runEmergencyFill,
};

/**
 * Shared dependency bundle for every auto-fill entry point this pass
 * (fill-new on boost/turbo, staggered auto-fill, emergency fill).
 */
const buildFillDeps = (api) => ({
    settings,
    logger,
    getEligiblePhotos: api.getEligiblePhotos,
    getImageData: api.getImageData,
    submitToChallenge: api.submitToChallenge,
    getActiveChallenges: api.getActiveChallenges,
    // Enables tag resolution on the themed-search miss path; without the
    // pair the themed search skips tag resolution.
    searchTagAutocomplete: api.searchTagAutocomplete,
    getCurrentMemberProfile: api.getCurrentMemberProfile,
});

/**
 * Per-pass context threaded to every per-challenge phase below.
 *
 * @typedef {{
 *   token: string,
 *   api: Object,
 *   fillDeps: Object,
 *   interChallengeDelay: () => number,
 *   entryTracker: ({get: Function, set: Function}|null),
 *   currency: (Object|null),
 *   allChallenges: Array,
 * }} PassContext
 */

/**
 * Standard cancelled-pass exit shared by every cancellation checkpoint: one
 * warn, close the operation, surface the full active list.
 *
 * @param {Array} allChallenges
 * @param {string} [warning]
 */
const cancelPass = (allChallenges, warning = '🛑 Voting cancelled by user') => {
    logger.withCategory('voting').warning(warning, null);
    logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
    return { success: false, message: 'Voting cancelled by user', challenges: allChallenges };
};

/**
 * Failed-pass exit before any challenge is processed: log on the challenges
 * category, close the operation with the same message, surface the list.
 *
 * @param {string} msg
 * @param {Array} allChallenges
 * @param {'error'|'warning'} level
 */
const abortPass = (msg, allChallenges, level) => {
    logger.withCategory('challenges')[level](msg, null);
    logger.withCategory('voting').endOperation('voting-process', null, msg);
    return { success: false, error: msg, challenges: allChallenges };
};

/**
 * Cleanup stale metadata against the full active list — must run before any
 * per-challenge filter so we don't drop metadata for challenges the user is
 * simply not running this pass.
 */
const pruneStaleMetadata = (cleanupStaleMetadata, allChallenges) => {
    try {
        const activeChallengeIds = allChallenges.map((challenge) => challenge.id.toString());
        const cleanupSuccess = cleanupStaleMetadata(activeChallengeIds);
        if (cleanupSuccess) {
            logger.withCategory('api').debug('Successfully cleaned up stale metadata', null);
        } else {
            logger.withCategory('api').warning('Failed to cleanup stale metadata', null);
        }
    } catch (error) {
        logger.withCategory('api').warning('Error during metadata cleanup:', error);
    }
};

/**
 * Narrow the pass to the per-card "Run" challenge when a filter is set.
 *
 * @returns {{challenges: Array}|{result: Object}} `result` is the pass's exit
 *   value when the filtered challenge is not active.
 */
const selectPassChallenges = (allChallenges, challengeIdFilter) => {
    if (challengeIdFilter == null) return { challenges: allChallenges };
    const idStr = String(challengeIdFilter);
    const challenges = allChallenges.filter((c) => String(c.id) === idStr);
    if (challenges.length === 0) {
        return { result: abortPass(`Challenge ${idStr} is not active`, allChallenges, 'warning') };
    }
    logger.withCategory('voting').info(`🎯 Run scoped to single challenge: ${challenges[0].title} (${idStr})`, null);
    return { challenges };
};

/**
 * Auto-earn turbo by playing the mini-game when eligible. This has no
 * close-time threshold (it plays whenever a turbo is winnable), and a turbo
 * earned this cycle can't be applied until the next cycle re-fetches state, so
 * it runs ahead of the timer-ordered deadline actions.
 *
 * @param {Object} challenge
 * @param {number} now
 * @param {PassContext} pass
 */
const playAutoTurbo = async (challenge, now, { api, token }) => {
    if (!votingLogic.shouldPlayAutoTurbo(challenge, now)) return;
    logger
        .withCategory('turbo')
        .startOperation(`turbo-earn-${challenge.id}`, `Playing turbo mini-game on ${challenge.title}`);
    try {
        const result = await api.runTurboMiniGame(challenge, token);
        const summary = `played=${result.played} correct=${result.correct} flipped=${result.flipped} doubleFailed=${result.doubleFailed} won=${result.won}`;
        logger.withCategory('turbo').endOperation(`turbo-earn-${challenge.id}`, summary);
    } catch (error) {
        logger.withCategory('turbo').endOperation(`turbo-earn-${challenge.id}`, null, failureText(error));
    }
};

/**
 * Deadline actions (boost / auto-fill / turbo apply / emergency fill) run in the
 * order their configured timers imply — largest seconds-before-close window
 * first — instead of a fixed code order, so e.g. auto-fill (15m) acts before
 * turbo (12m) when both are due. Each runner keeps its own full eligibility
 * check, so an action that isn't actually due just no-ops.
 *
 * @param {Object} challenge
 * @param {number} now
 * @param {PassContext} pass
 * @returns {Promise<Object|null>} the cancelled-pass result, or null to continue
 */
const runDeadlineActions = async (challenge, now, pass) => {
    const actionCtx = { challenge, token: pass.token, now, api: pass.api, fillDeps: pass.fillDeps };
    for (const { action } of votingLogic.orderDeadlineActions(challenge)) {
        // Honor cancellation between actions, same as the per-challenge guard.
        if (cancellation.isCancelled()) {
            return cancelPass(pass.allChallenges);
        }
        // Defensive: orderDeadlineActions only emits the four known keys, but
        // guard the dispatch so a future action added there without a matching
        // runner degrades to a skip instead of throwing and aborting the loop.
        const run = actionRunners[action];
        if (typeof run === 'function') await run(actionCtx);
    }
    return null;
};

/**
 * New-entry detection (voteOnNewEntry) state for one challenge.
 *
 * The setting is read HERE and nowhere else — VotingLogic takes the
 * already-gated boolean. Gating the whole block (not just the decision) keeps
 * the feature genuinely opt-in: metadata.json is a synchronous whole-file
 * read/write, and a user who never enables this should pay none of it.
 *
 * @param {Object} challenge
 * @param {({get: Function, set: Function}|null)} entryTracker
 */
const detectNewEntry = (challenge, entryTracker) => {
    const challengeId = challenge.id.toString();
    const tracking =
        entryTracker && settings.getEffectiveSetting('voteOnNewEntry', challengeId) === true
            ? newEntryTracker.readEntryIds(challenge)
            : null;
    const previousIds = tracking ? entryTracker.get(challengeId) : null;
    const hasNewEntry = tracking ? newEntryTracker.hasNewEntries(previousIds, tracking) : false;
    return { challengeId, tracking, previousIds, hasNewEntry };
};

/**
 * How a detected new entry played out in the vote decision. Logged AFTER the
 * decision so the line matches the outcome: the voting pause holds the trigger
 * armed, so claiming "forcing a vote this cycle" off `hasNewEntry` alone would
 * repeat every cycle for the whole pause, directly above a "Skipping voting -
 * voting paused" line saying the opposite.
 */
const describeNewEntryOutcome = ({ forcedByNewEntry, preservesNewEntryTrigger, shouldVote }) => {
    if (forcedByNewEntry) return 'forcing a vote this cycle';
    if (preservesNewEntryTrigger) return 'vote deferred until the pause ends — trigger stays armed';
    return shouldVote ? 'already eligible on its own' : 'not voting this cycle';
};

/**
 * Record the entry snapshot, which disarms the trigger. Called after the vote,
 * and additionally from the post-submit cancellation return — that one bails
 * out of the whole pass after the vote already landed, so skipping the record
 * there would re-force the identical vote next pass. The two earlier
 * cancellation returns deliberately do NOT record: no vote went out yet, so the
 * trigger must stay armed.
 *
 * Skipped only when a vote this trigger FORCED threw, so the next cycle retries
 * it — that is the whole retry contract. Deliberately NOT skipped for:
 *   - "no vote images available", which is not a throw; treating it as a
 *     failure would force a getVoteImages call every cycle forever on a
 *     challenge that never has any.
 *   - a blocked decision (onlyBoost / vote-only-in-last-minute /
 *     scheduled-fill-only / not started), which consumes the trigger. Every
 *     block that can later lift, lifts into a rule that already votes to 100%
 *     or re-reads exposure from scratch, so nothing is lost.
 *
 * The exception to that last point is a block that sets
 * `preservesNewEntryTrigger` — today only the voting pause. It lifts into the
 * NORMAL threshold rule, which votes only while exposure is below the trigger,
 * so consuming the trigger here would drop the new entry's vote entirely
 * instead of deferring it past the pause.
 */
const recordEntrySnapshot = (entryTracker, entry, decision, voteThrew) => {
    if (!entry.tracking || (decision.forcedByNewEntry && voteThrew)) return;
    if (decision.preservesNewEntryTrigger && entry.hasNewEntry) return;
    if (!newEntryTracker.shouldRecordSnapshot(entry.previousIds, entry.tracking)) return;
    entryTracker.set(entry.challengeId, entry.tracking);
};

/**
 * Submit votes from an already-fetched pool, then pace before the next challenge.
 *
 * @param {Object} challenge
 * @param {Object} voteImages
 * @param {number} targetExposure
 * @param {PassContext} pass
 * @param {() => void} onVoteLanded - records the snapshot when a cancel follows a landed vote
 * @returns {Promise<Object|null>} the cancelled-pass result, or null to continue
 */
const submitVoteImages = async (challenge, voteImages, targetExposure, pass, onVoteLanded) => {
    // Check for cancellation before submitting votes
    if (cancellation.isCancelled()) {
        return cancelPass(pass.allChallenges, '🛑 Voting cancelled by user before vote submission');
    }

    logger
        .withCategory('voting')
        .info(`${logger.challengeTag(challenge)} Submitting votes for ${voteImages.images.length} images`, null);

    // Submit votes to target exposure (dynamic based on voting rules)
    await pass.api.submitVotes(voteImages, pass.token, targetExposure);

    // Check for cancellation before delay
    if (cancellation.isCancelled()) {
        // The vote already went through, so the trigger is spent —
        // record before bailing or the next pass re-votes it.
        onVoteLanded();
        return cancelPass(pass.allChallenges, '🛑 Voting cancelled by user after vote submission');
    }

    logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'voting attempt complete');

    // Add a delay between challenges (strategy-specific pacing)
    const delay = pass.interChallengeDelay();
    logger.withCategory('voting').debug(`Adding ${delay}ms delay between challenges`, null);
    await sleep(delay);
    return null;
};

/**
 * Vote on the challenge when the decision says so.
 *
 * `votePool` is the pool this pass voted from — handed to the exposure-fill
 * rule, which only spends when voting cannot reach its threshold. undefined =
 * voting didn't run (the rule fetches the pool itself); null = none.
 *
 * @param {Object} challenge
 * @param {{shouldVote: boolean, voteReason: string, targetExposure: number}} decision
 * @param {PassContext} pass
 * @param {() => void} onVoteLanded
 * @returns {Promise<{cancelled: (Object|null), voteThrew: boolean, votePool: (Object|null|undefined)}>}
 */
const voteOnChallenge = async (challenge, decision, pass, onVoteLanded) => {
    const outcome = { cancelled: null, voteThrew: false, votePool: undefined };
    if (!decision.shouldVote) {
        // Log why voting was skipped
        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} Skipping voting - ${decision.voteReason}`, null);
        return outcome;
    }

    logger
        .withCategory('voting')
        .startOperation(`vote-${challenge.id}`, `Voting on ${logger.challengeTag(challenge)}`, 'DEBUG');

    try {
        // Check for cancellation before voting
        if (cancellation.isCancelled()) {
            outcome.cancelled = cancelPass(
                pass.allChallenges,
                '🛑 Voting cancelled by user during challenge processing',
            );
            return outcome;
        }

        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} Starting voting process - ${decision.voteReason}`, null);

        // Get images to vote on
        const voteImages = await pass.api.getVoteImages(challenge, pass.token);
        outcome.votePool = voteImages ?? null;
        if (voteImages && voteImages.images) {
            outcome.cancelled = await submitVoteImages(
                challenge,
                voteImages,
                decision.targetExposure,
                pass,
                onVoteLanded,
            );
        } else {
            // No images is a valid "nothing to do" state — close the op as a
            // DEBUG success (silent) and surface one WARN for user visibility.
            logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'no vote images available');
            logger
                .withCategory('voting')
                .warning(`${logger.challengeTag(challenge)} No vote images available — skipping`, null);
        }
    } catch (error) {
        outcome.voteThrew = true;
        logger.withCategory('voting').endOperation(`vote-${challenge.id}`, null, failureText(error));
    }
    return outcome;
};

/**
 * One challenge's full pass: turbo-earn, currency automation, deadline actions,
 * new-entry detection, the vote, and the post-vote exposure fill — in that order.
 *
 * @param {Object} challenge
 * @param {number} now
 * @param {number} position - 1-based index for progress reporting
 * @param {number} total
 * @param {PassContext} pass
 * @returns {Promise<Object|null>} the cancelled-pass result, or null to continue
 */
const processChallenge = async (challenge, now, position, total, pass) => {
    // Check for cancellation before processing each challenge
    if (cancellation.isCancelled()) {
        return cancelPass(pass.allChallenges);
    }

    logger
        .withCategory('voting')
        .progress(`Processing challenge ${position}/${total}: ${challenge.title}`, position, total);

    await playAutoTurbo(challenge, now, pass);

    // Automatic key unlock and photo swap (opt-in per challenge/profile). They
    // run ahead of the deadline actions on purpose: an unlocked boost is then
    // available to the boost runner this same pass, and a swap happens before a
    // boost/turbo lands, so neither spends on the photo about to be replaced.
    const currencyCtx = { challenge, token: pass.token, now, currency: pass.currency };
    await currencyAuto.runAutoKey(currencyCtx);
    await currencyAuto.runAutoSwap(currencyCtx);

    const actionsCancelled = await runDeadlineActions(challenge, now, pass);
    if (actionsCancelled) return actionsCancelled;

    // New-entry detection runs AFTER the deadline actions on purpose: auto-fill /
    // emergency fill / boost-turbo fill-new all reflect their new entry into
    // challenge.member.ranking.entries, so an entry submitted seconds ago in this
    // very cycle is detected in this very cycle rather than waiting for the next one.
    const entry = detectNewEntry(challenge, pass.entryTracker);
    // Use the centralized voting logic service
    const decision = votingLogic.evaluateVotingDecision(challenge, now, { hasNewEntry: entry.hasNewEntry });

    if (entry.hasNewEntry) {
        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} New entry detected — ${describeNewEntryOutcome(decision)}`, null);
    }

    // onVoteLanded fires only when a cancel follows a submit that already
    // landed, so it records the snapshot with voteThrew=false; calling it from
    // a failure path would disarm a forced-vote retry.
    const vote = await voteOnChallenge(challenge, decision, pass, () =>
        recordEntrySnapshot(pass.entryTracker, entry, decision, false),
    );
    if (vote.cancelled) return vote.cancelled;

    recordEntrySnapshot(pass.entryTracker, entry, decision, vote.voteThrew);

    // Automatic exposure fill, AFTER the vote: a fill is only worth spending
    // when this pass's voting could not lift exposure to the fill threshold.
    if (!vote.voteThrew) await currencyAuto.runAutoExposureFill(currencyCtx, vote.votePool);
    return null;
};

const runVotingPass = async (token, challengeIdFilter, deps) => {
    const { api, cleanupStaleMetadata, interChallengeDelay, entryTracker = null, currency = null } = deps;
    const fillDeps = buildFillDeps(api);
    // Clear the photo-stats failure breaker so a pass that hit a rate limit does
    // not disable stat enrichment for every later pass in the session.
    photoStats.resetPassState();
    logger.withCategory('voting').startOperation('voting-process', 'Voting process');

    try {
        // Get all active challenges
        logger.withCategory('challenges').info('🔄 Loading active challenges', null);
        const { challenges: allChallenges, fetchFailed } = await api.getActiveChallenges(token);

        // A failed fetch is not an empty account. makePostRequest resolves null once retries
        // are exhausted, which would otherwise arrive here as an empty list and be reported
        // as a successful pass with "No active challenges found" — an outage indistinguishable
        // from having nothing to vote on, with the scheduler re-arming as if all were well.
        if (fetchFailed) {
            return abortPass('Could not load active challenges — the API request failed', allChallenges, 'error');
        }

        logger.withCategory('challenges').info(`📋 Found ${allChallenges.length} active challenges`, null);

        if (allChallenges.length === 0) {
            logger.withCategory('challenges').warning('No active challenges found', null);
            logger.withCategory('voting').endOperation('voting-process', 'No challenges to process');
            return { success: true, message: 'No active challenges found', challenges: allChallenges };
        }

        if (cleanupStaleMetadata) pruneStaleMetadata(cleanupStaleMetadata, allChallenges);

        const scope = selectPassChallenges(allChallenges, challengeIdFilter);
        if (scope.result) return scope.result;
        const { challenges } = scope;

        /** @type {PassContext} */
        const pass = { token, api, fillDeps, interChallengeDelay, entryTracker, currency, allChallenges };

        // Process each challenge
        let processedCount = 0;
        for (const challenge of challenges) {
            processedCount++;

            // Current timestamp in seconds (Unix epoch time), re-read per challenge rather
            // than captured once for the whole pass. A pass spends 2-5s of inter-challenge
            // delay per challenge, plus retries (up to 30s per request), paginated library
            // walks and up to 25 get_image_data calls per fill — minutes in total. A single
            // pass-start clock would evaluate every later challenge against a time biased
            // into the past, missing last-minute/emergency/boost/turbo windows that opened
            // mid-pass and treating an already-closed challenge as still open.
            const now = Math.floor(Date.now() / 1000);

            // One malformed challenge must not cost the pass every challenge after it: an
            // unguarded property read would otherwise throw into the single outer catch
            // below and abandon the whole pass. Catching here lets the loop move on to the
            // next challenge; the cancellation checkpoints inside return a result rather
            // than throw, so cancellation still exits the pass immediately rather than
            // being swallowed as a per-challenge error.
            try {
                const cancelled = await processChallenge(challenge, now, processedCount, challenges.length, pass);
                if (cancelled) return cancelled;
            } catch (error) {
                logger
                    .withCategory('voting')
                    .error(
                        `${logger.challengeTag(challenge)} Skipped after an unexpected error — continuing with the remaining challenges`,
                        error,
                    );
            }
        }

        // Complete the voting process
        logger
            .withCategory('voting')
            .endOperation('voting-process', `All ${challenges.length} challenges processed successfully`);

        return { success: true, message: 'Voting process completed successfully', challenges: allChallenges };
    } catch (error) {
        logger.withCategory('voting').endOperation('voting-process', null, failureText(error));
        return { success: false, error: error?.message || 'Voting process failed' };
    }
};

module.exports = { runVotingPass };
