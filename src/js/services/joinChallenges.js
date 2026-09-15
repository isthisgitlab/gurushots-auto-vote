/**
 * GuruShots Auto Voter - Join Challenges Service
 *
 * Discovers un-joined ("open") challenges and joins them — free or paid —
 * reusing auto-fill's photo picker to choose the entry photo. Shared by the
 * automatic per-cycle pass (runJoinPass, wired into fetchChallengesAndVote so
 * GUI, CLI and Android all run it) and the manual single-join path
 * (joinChallengeSingle, behind an explicit paid confirmation).
 *
 * PAID-SPEND SAFETY (see the plan's safety model — do not reorder):
 *   1. Photo-first: resolve an eligible photo BEFORE any coins_unlock. No
 *      photo ⇒ skip the candidate, never spend.
 *   2. Idempotency: the unlock claim is persisted (joinStateStore) BEFORE
 *      coins_unlock is called, and only cleared on a successful submit. A crash
 *      the instant after the charge still leaves the claim on disk, so a later
 *      pass retries submit ONLY — it never re-unlocks (re-charges). If the claim
 *      cannot be written, no coins are spent.
 *   3. In-flight lock: a module-level Set stops a manual click racing the cycle
 *      pass (or itself) into a second coins_unlock WITHIN this process; a
 *      cross-process lockfile (deps.acquireUnlockLock) covers the same race
 *      across processes on real-fs platforms (GUI auto-join vs CLI `join --yes`
 *      on one account). The unlock claim is re-read authoritatively under that
 *      lock, and a corrupt/unreadable join-state refuses the spend (fail-safe).
 *   4. Budget decrements only after a confirmed unlock.
 *   5. Cancellation is honored between candidates and before each spend.
 *
 * deps (injected by api/main.js real / mock/index.js mock):
 *   { getMemberChallenges, getBankroll, coinsUnlock, submitToChallenge,
 *     getEligiblePhotos, joinStateStore, acquireUnlockLock } — joinStateStore is
 *   null and acquireUnlockLock absent in mock (no real state touched, mirroring
 *   cleanupStaleMetadata:null).
 */

const logger = require('../logger');
const settings = require('../settings');
const cancellation = require('../voting/cancellation');
const { shouldJoinChallenge } = require('./VotingLogic');
const { fetchCandidatesForChallenge, resolveSemanticScores } = require('./autoFill');
const { pickPhotosForChallenge } = require('./photoPicker');

// Shared across the manual handler and the automatic pass IN THIS PROCESS so the
// two cannot double-spend the same challenge. Module-level = one Set per process;
// cross-process racing is bounded by the persisted claim (see header residual).
const inFlight = new Set();

const cat = () => logger.withCategory('join');

// ---- settings resolution (by TITLE — un-joined ids are not in the id cache) ----

/**
 * Resolve one setting for an un-joined candidate. The id-keyed
 * getEffectiveSetting(key, id) cannot see a title profile for a challenge the
 * user has not joined (its id was never cached from get_my_active_challenges),
 * so we read the title profile directly and fall back to the global default.
 */
const resolveJoinSetting = (key, challenge) => {
    const title = challenge?.title;
    // getTitleProfile returns { name, values } (or null) — the overrides live
    // under `.values`, so read from there, not off the profile object itself.
    const profile = title ? settings.getTitleProfile(title) : null;
    const values = profile && !profile.suppressed ? profile.values : null;
    if (values && Object.prototype.hasOwnProperty.call(values, key)) {
        return values[key];
    }
    return settings.getEffectiveSetting(key, null);
};

const parseTypeList = (value) =>
    typeof value === 'string'
        ? value
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter((t) => t !== '')
        : [];

/** Per-candidate scope config, resolved by title. */
const resolveCandidateConfig = (challenge) => ({
    allowAll: resolveJoinSetting('autoJoinAll', challenge) === true,
    allowTypes: parseTypeList(resolveJoinSetting('autoJoinTypes', challenge)),
    maxCoins: Number(resolveJoinSetting('autoJoinMaxCoins', challenge)) || 0,
    hasProfileMatch: !!(challenge?.title && settings.getTitleProfile(challenge.title)),
});

// ---- persisted unlock marker (idempotency) ----

// Read the marker map, distinguishing "empty/never-written" (ok:true, {}) from
// "unreadable/corrupt" (ok:false). A corrupt file must NOT silently look empty:
// that would forget a real unlock marker and let a retry re-charge. Callers on
// the paid path treat ok:false as "cannot verify — do not spend".
const readUnlockedState = (store) => {
    if (!store) return { state: {}, ok: true };
    let raw;
    try {
        raw = store.readRaw();
    } catch (error) {
        cat().warning(`could not read join-state: ${error?.message || error}`, null);
        return { state: {}, ok: false };
    }
    if (!raw) return { state: {}, ok: true };
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { state: parsed, ok: true };
        }
        cat().warning('join-state file is malformed (not an object) — treating as unreadable', null);
        return { state: {}, ok: false };
    } catch (error) {
        cat().warning(`join-state file is corrupt: ${error?.message || error}`, null);
        return { state: {}, ok: false };
    }
};

const readUnlocked = (store) => readUnlockedState(store).state;

const isUnlocked = (store, id) => Object.prototype.hasOwnProperty.call(readUnlocked(store), String(id));

// Persist the unlock claim. Returns true on success (or when there is no store
// — mock mode, which spends no real coins). Returns false when a real store
// write fails: the caller MUST NOT spend coins it cannot record, or a crash /
// retry could re-unlock and double-charge.
const markUnlocked = (store, id) => {
    if (!store) return true;
    try {
        const state = readUnlocked(store);
        state[String(id)] = { unlockedAt: Date.now() };
        store.writeRaw(JSON.stringify(state));
        return true;
    } catch (error) {
        cat().warning(`could not persist unlock marker for ${id}: ${error?.message || error}`, null);
        return false;
    }
};

const clearUnlocked = (store, id) => {
    if (!store) return;
    try {
        const state = readUnlocked(store);
        if (Object.prototype.hasOwnProperty.call(state, String(id))) {
            delete state[String(id)];
            store.writeRaw(JSON.stringify(state));
        }
    } catch (error) {
        cat().warning(`could not clear unlock marker for ${id}: ${error?.message || error}`, null);
    }
};

// ---- photo pick (reuses auto-fill's picker) ----

/**
 * Pick a single eligible entry photo for a candidate, honoring the same
 * must/should tag rules and picker as auto-fill. Tags are resolved by the
 * challenge object (title-aware); fillWithoutTagMatch by title profile.
 * @returns {Promise<string|null>} the photo id, or null when none is eligible.
 */
const pickJoinPhoto = async (challenge, token, deps) => {
    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = resolveJoinSetting('fillWithoutTagMatch', challenge) === true;

    let eligible;
    try {
        eligible = await fetchCandidatesForChallenge(
            challenge,
            token,
            { mustIncludeTags, shouldIncludeTags },
            { getEligiblePhotos: deps.getEligiblePhotos, logger },
        );
    } catch (error) {
        cat().warning(`could not read eligible photos for ${challenge?.id}: ${error?.message || error}`, null);
        return null;
    }
    const semanticScores = await resolveSemanticScores(challenge, eligible, {});
    const picked = pickPhotosForChallenge(challenge, eligible, 1, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        semanticScores,
    });
    return picked && picked[0] ? picked[0] : null;
};

// ---- the join itself (shared by pass + manual) ----

/**
 * Perform one join under the safety model. Assumes the decision to join (and,
 * for paid, the consent/affordability) has already been made by the caller.
 *
 * @param {object} challenge
 * @param {string} token
 * @param {object} deps
 * @param {number} needsCoins paid cost (0 = free)
 * @returns {Promise<{status:string, charged:number, imageId?:string}>}
 *   status ∈ joined | skipped-no-photo | charged-pending-submit |
 *            failed-no-charge | busy. `charged` is coins spent THIS call.
 */
const performJoin = async (challenge, token, deps, needsCoins) => {
    const id = challenge?.id;
    const key = String(id);
    if (inFlight.has(key)) {
        return { status: 'busy', charged: 0 };
    }
    inFlight.add(key);
    try {
        // 1. Photo first — no photo, no spend.
        const imageId = await pickJoinPhoto(challenge, token, deps);
        if (!imageId) {
            return { status: 'skipped-no-photo', charged: 0 };
        }

        let charged = 0;
        let alreadyUnlocked = isUnlocked(deps.joinStateStore, id);

        // 2. Paid unlock (skipped when a prior pass already unlocked → retry submit only).
        if (needsCoins > 0 && !alreadyUnlocked) {
            // Cross-process lock around the check→claim→unlock section so a
            // concurrent process (GUI auto-join vs CLI join) cannot both unlock.
            const xlock = deps.acquireUnlockLock ? deps.acquireUnlockLock(id) : { ok: true, release: () => {} };
            if (!xlock.ok) {
                return { status: 'busy', charged: 0 };
            }
            try {
                // Re-read authoritatively under the lock — another process may
                // have unlocked between our first check and acquiring the lock.
                const { state, ok: stateOk } = readUnlockedState(deps.joinStateStore);
                if (!stateOk) {
                    // Cannot verify prior unlocks → refuse to spend (a re-charge
                    // is worse than skipping this candidate this cycle).
                    cat().error(
                        `${logger.challengeTag(challenge)}: join-state is unreadable — not spending coins`,
                        null,
                    );
                    return { status: 'failed-no-charge', charged: 0 };
                }
                if (Object.prototype.hasOwnProperty.call(state, key)) {
                    alreadyUnlocked = true; // another process already paid → retry submit only
                } else if (cancellation.isCancelled()) {
                    return { status: 'failed-no-charge', charged: 0 };
                } else {
                    // Persist the claim BEFORE spending, so a crash the instant
                    // after the charge can never let a later pass re-unlock. If
                    // the claim cannot be recorded, do not spend at all.
                    if (!markUnlocked(deps.joinStateStore, id)) {
                        cat().error(
                            `${logger.challengeTag(challenge)}: could not record the unlock claim — not spending coins`,
                            null,
                        );
                        return { status: 'failed-no-charge', charged: 0 };
                    }
                    const unlock = await deps.coinsUnlock(id, token);
                    if (!unlock?.ok) {
                        clearUnlocked(deps.joinStateStore, id);
                        cat().warning(
                            `coins_unlock failed for ${logger.challengeTag(challenge)} — no coins charged`,
                            null,
                        );
                        return { status: 'failed-no-charge', charged: 0 };
                    }
                    charged = needsCoins;
                }
            } finally {
                xlock.release();
            }
        }

        // 3. Submit the photo (the actual join). If cancelled now and coins are
        // already spent (this call or a prior cycle), report pending-submit — not
        // "no charge", which would misinform the user about money spent.
        if (cancellation.isCancelled()) {
            if (charged > 0 || alreadyUnlocked) {
                return { status: 'charged-pending-submit', charged };
            }
            return { status: 'failed-no-charge', charged: 0 };
        }
        const submit = await deps.submitToChallenge(id, [imageId], token);
        if (submit?.ok) {
            clearUnlocked(deps.joinStateStore, id);
            cat().success(
                `joined ${logger.challengeTag(challenge)}${needsCoins > 0 ? ` (spent ${needsCoins} coins)` : ''}`,
                null,
            );
            return { status: 'joined', charged, imageId };
        }

        // Submit failed. If we (or a prior pass) unlocked, coins are gone — keep
        // the marker so the next attempt retries submit only, never re-charges.
        if (needsCoins > 0 && (charged > 0 || alreadyUnlocked)) {
            cat().error(
                `${logger.challengeTag(challenge)}: coins were charged but the join did not complete — will retry the submit, not re-unlock`,
                null,
            );
            return { status: 'charged-pending-submit', charged };
        }
        return { status: 'failed-no-charge', charged: 0 };
    } finally {
        inFlight.delete(key);
    }
};

// ---- automatic per-cycle pass ----

/**
 * Automatic join pass — a pre-step in fetchChallengesAndVote, gated by the
 * global `autoJoin` setting (default off). Sequential, cancellation-aware.
 *
 * @param {string} token
 * @param {number} now epoch ms (unused today; kept for parity with other passes)
 * @param {object} deps
 * @returns {Promise<{ran:boolean, joined:number, results:Array<object>}>}
 */
const runJoinPass = async (token, now, deps) => {
    const empty = { ran: false, joined: 0, results: [] };
    if (settings.getEffectiveSetting('autoJoin', null) !== true) {
        return empty;
    }
    if (!token) return empty;

    let candidates;
    try {
        candidates = await deps.getMemberChallenges(token, 'open');
    } catch (error) {
        cat().warning(`could not list open challenges: ${error?.message || error}`, null);
        return empty;
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return { ran: true, joined: 0, results: [] };
    }

    // One balance read for the whole pass; kept locally accurate as we spend.
    // A throw here (or a null return) means "balance unknown" ⇒ no paid joins.
    let bankroll = null;
    try {
        bankroll = await deps.getBankroll(token);
    } catch (error) {
        cat().warning(`could not read balance (paid joins skipped this pass): ${error?.message || error}`, null);
    }
    let remainingBudget = Number(settings.getEffectiveSetting('autoJoinCycleCoinBudget', null)) || 0;

    const results = [];
    let joined = 0;
    for (const challenge of candidates) {
        if (cancellation.isCancelled()) {
            cat().warning('join pass cancelled by user', null);
            break;
        }
        const cfg = resolveCandidateConfig(challenge);
        const decision = shouldJoinChallenge({
            challenge,
            bankroll,
            remainingBudget,
            allowAll: cfg.allowAll,
            allowTypes: cfg.allowTypes,
            maxCoins: cfg.maxCoins,
            hasProfileMatch: cfg.hasProfileMatch,
        });
        if (!decision.join) {
            results.push({ id: challenge?.id, status: `skipped:${decision.reason}` });
            continue;
        }
        // Guard each candidate: one bad candidate (unexpected throw) must not
        // abort the rest of the pass — mirrors the per-challenge voting loop.
        let outcome;
        try {
            outcome = await performJoin(challenge, token, deps, decision.needsCoins);
        } catch (error) {
            cat().warning(`join failed for ${logger.challengeTag(challenge)}: ${error?.message || error}`, null);
            results.push({ id: challenge?.id, status: 'error' });
            continue;
        }
        if (outcome.charged > 0) {
            remainingBudget -= outcome.charged;
            if (bankroll && Number.isFinite(bankroll.coins)) {
                bankroll.coins -= outcome.charged;
            }
        }
        if (outcome.status === 'joined') joined += 1;
        results.push({ id: challenge?.id, status: outcome.status });
    }

    if (joined > 0) {
        cat().info(`join pass complete: joined ${joined} of ${candidates.length} open challenge(s)`, null);
    }
    return { ran: true, joined, results };
};

// ---- manual single join (explicit paid consent) ----

/**
 * Join ONE challenge by id, on user request. Re-fetches the live candidate so a
 * stale/closed entry in the renderer's cached list cannot trigger a wasted
 * spend. A paid challenge without `spendCoins` returns `needs-confirm` (with the
 * cost) and spends nothing.
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @param {object} deps
 * @param {{spendCoins?: boolean}} [opts]
 * @returns {Promise<{status:string, challengeId:(string|number), cost:number,
 *   coins?:number, imageId?:string}>}
 */
const joinChallengeSingle = async (challengeId, token, deps, { spendCoins = false } = {}) => {
    if (!token) return { status: 'not-authenticated', challengeId, cost: 0 };

    let candidates;
    try {
        candidates = await deps.getMemberChallenges(token, 'open');
    } catch (error) {
        cat().warning(`could not list open challenges: ${error?.message || error}`, null);
        return { status: 'fetch-failed', challengeId, cost: 0 };
    }
    const challenge = (candidates || []).find((c) => String(c?.id) === String(challengeId));
    if (!challenge) {
        // Not in the open list any more — already joined, or closed.
        return { status: 'unavailable', challengeId, cost: 0 };
    }

    const rawCost = Number(challenge.join_coins);
    const cost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0;

    if (cost > 0 && !spendCoins) {
        return { status: 'needs-confirm', challengeId, cost };
    }

    if (cost > 0) {
        const bankroll = await deps.getBankroll(token);
        const coins = Number(bankroll?.coins);
        if (bankroll == null || !Number.isFinite(coins)) {
            return { status: 'balance-unknown', challengeId, cost };
        }
        if (coins < cost) {
            return { status: 'skipped-unaffordable', challengeId, cost, coins };
        }
    }

    const outcome = await performJoin(challenge, token, deps, cost);
    return { status: outcome.status, challengeId, cost, imageId: outcome.imageId };
};

module.exports = {
    runJoinPass,
    joinChallengeSingle,
    // exported for tests
    performJoin,
    pickJoinPhoto,
    resolveJoinSetting,
    inFlight,
};
