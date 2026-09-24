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
 * deps (injected by strategies/real/index.js real / mock/strategy.js mock):
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
const { rankVisually } = require('./visionVerifier');

// Shared across the manual handler and the automatic pass IN THIS PROCESS so the
// two cannot double-spend the same challenge. Module-level = one Set per process;
// cross-process racing is bounded by the persisted claim (see header residual).
const inFlight = new Set();

const cat = () => logger.withCategory('join');

// ---- settings resolution (by RULE — un-joined ids are not in the id cache) ----

/**
 * Resolve one setting for an un-joined candidate. The id-keyed
 * getEffectiveSetting(key, id) cannot see a rule for a challenge the user has
 * not joined (its id was never cached from get_my_active_challenges), so we
 * match the rules against the candidate payload itself and fall back to the
 * global default.
 *
 * Precedence: rules in list order, the first matching rule that sets the key
 * wins — a rule's inline override before the profile it names — then the
 * global default. See `ruleValuesFor` in settings/ruleResolution.js.
 */
const resolveJoinSetting = (key, challenge) => {
    // Pass the whole candidate, never just its title: a rule may be keyed on the
    // challenge's own tags, type, photo count or runtime, and an un-joined
    // candidate carries them. Optional-chained like every other per-challenge
    // settings read here: an older persisted facade (or a partial stub in a
    // test) must degrade to "no rule", never throw mid-pass.
    const fromRules = settings.resolveRuleSetting?.(key, challenge);
    if (fromRules) return fromRules.value;
    return settings.getEffectiveSetting(key, null);
};

const parseTypeList = (value) =>
    typeof value === 'string'
        ? value
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter((t) => t !== '')
        : [];

/** The saved title rules, or null when they cannot be read. */
const readTitleRules = () => {
    try {
        return settings.getTitleRules();
    } catch {
        return null;
    }
};

/**
 * Whether one rule turns auto-join ON by itself. Reads the rule's OWN values
 * directly. Going back through the matcher here would be wrong: a `contains`
 * or class-keyed rule has no single challenge to match against at arming time,
 * and a higher rule could win and hide this one's `autoJoin: true`. Arming only
 * asks "could any rule ever turn joining on?", which the rule answers itself.
 *
 * @param {*} rule
 * @param {() => Object} readProfiles - lazily loads the profiles map once per scan
 */
const ruleEnablesAutoJoin = (rule, readProfiles) => {
    if (rule && Object.prototype.hasOwnProperty.call(rule, 'autoJoin')) return rule.autoJoin === true;
    const profileName = typeof rule?.profile === 'string' ? rule.profile : '';
    if (!profileName) return false;
    return readProfiles()[profileName]?.autoJoin === true;
};

/**
 * True when at least one saved rule turns auto-join ON — either inline on the
 * rule or through the named profile it inherits — i.e. some challenge would
 * auto-join even with the master default off. Used only as the pass-level
 * fast-path check.
 *
 * A rule that only adds photo tags (no inline autoJoin, no profile) still
 * returns false, so it must never keep the pass alive every cycle.
 */
const anyTitleRuleEnablesAutoJoin = () => {
    const rules = readTitleRules();
    if (!Array.isArray(rules)) return false;
    let profiles = null;
    const readProfiles = () => {
        profiles = profiles || settings.getChallengeProfiles() || {};
        return profiles;
    };
    for (const rule of rules) {
        if (ruleEnablesAutoJoin(rule, readProfiles)) return true;
    }
    return false;
};

/**
 * Whether auto-join is armed at all — the master default is on, OR some rule
 * enables it (inline or via its profile). Mirrors the pass short-circuit
 * condition; used to drive the "auto-join active" UI indicator so it reflects
 * the per-rule case too.
 * @returns {boolean}
 */
const isAutoJoinActive = () => {
    if (settings.getEffectiveSetting('autoJoin', null) === true) return true;
    return anyTitleRuleEnablesAutoJoin();
};

/**
 * A rule opt-in deliberate enough to bypass the type filters — see
 * `hasRuleJoinOptIn` in settings/titleRules.js: the rules resolve `autoJoin` to true, or
 * the applying profile comes from a rule naming a title or challenge tag.
 *
 * An inline WINDOW alone is deliberately not enough — "join this late" says
 * when, not whether, so it must not smuggle an excluded type into scope.
 */
const hasTitleOptIn = (challenge) => settings.hasRuleJoinOptIn?.(challenge) === true;

/** Per-candidate scope/coin/timing config, resolved by rule (inline → profile → global). */
const resolveCandidateConfig = (challenge) => ({
    // Empty include list = all types (the default scope once auto-join is on).
    includeTypes: parseTypeList(resolveJoinSetting('autoJoinTypes', challenge)),
    excludeTypes: parseTypeList(resolveJoinSetting('autoJoinExcludeTypes', challenge)),
    // The challenge's OWN tags (Exhibition / Comm / Turbo / …), not photo tags.
    includeTags: parseTypeList(resolveJoinSetting('autoJoinChallengeTags', challenge)),
    excludeTags: parseTypeList(resolveJoinSetting('autoJoinExcludeChallengeTags', challenge)),
    maxCoins: Number(resolveJoinSetting('autoJoinMaxCoins', challenge)) || 0,
    // Hours → seconds, to match close_time's unit. A non-finite/negative value
    // degrades to 0 = "no window", i.e. join as soon as seen.
    joinWithinSec: Math.max(0, Number(resolveJoinSetting('autoJoinWithinHoursOfEnd', challenge)) || 0) * 3600,
    // Elapsed-fraction anchor, resolved through the same tier chain. Percent and
    // hours never combine: resolveJoinWindow picks ONE (percent wins), so a
    // category row saying "90%" fully replaces an inherited hours window rather
    // than intersecting with it.
    joinAfterPercentElapsed: Math.max(0, Number(resolveJoinSetting('autoJoinAfterPercentElapsed', challenge)) || 0),
    hasProfileMatch: hasTitleOptIn(challenge),
});

/**
 * Report a candidate the join window could not evaluate.
 *
 * The live get_member_challenges response DOES carry close_time AND start_time
 * on every open challenge — verified 2026-09-19 — so this should never fire in
 * practice. `reason` names which of the two the gate could not read (only the
 * percent-elapsed anchor reads start_time). It stays because the fail-closed gate skips such a candidate, which
 * would otherwise be indistinguishable from "nothing to join": if GuruShots ever
 * drops or renames the field, the window would silently stop every join. Naming
 * the fields that ARE present makes that diagnosable from one run.
 */
const warnMissingCloseTime = (challenge, reason) => {
    const fields = Object.keys(challenge || {}).join(', ') || '(none)';
    // start_time is only read by the percent-elapsed anchor, so name the field
    // the gate actually could not read rather than a generic "timing" message.
    const field = reason === 'start-time-unknown' ? 'start_time' : 'close_time';
    cat().warning(
        `join window set but ${logger.challengeTag(challenge)} has no readable ${field} — ` +
            `candidate deferred. Fields present: ${fields}`,
        null,
    );
};

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
        // JSON.parse only ever throws a SyntaxError here (readRaw returns a string).
        cat().warning(`join-state file is corrupt: ${error.message}`, null);
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

// Same shortlist length the fill path hands the visual re-rank.
const VISUAL_SHORTLIST = 12;

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
    // Same list the fill path uses; resolved here because join does its own
    // fetch/score/pick rather than going through runFillAttempt.
    // Optional-chained like every other per-challenge settings read here: a
    // partial settings stub (or an older persisted facade) must degrade to "no
    // list", never throw mid-join.
    const ignoreWords = settings.getEffectiveIgnoreTitleWords?.(challenge) ?? null;

    let eligible;
    try {
        eligible = await fetchCandidatesForChallenge(
            challenge,
            token,
            { mustIncludeTags, shouldIncludeTags, ignoreWords },
            // logLabel 'join' so photo-library warnings are attributed to the join
            // flow, not auto-fill (the picker is shared).
            {
                getEligiblePhotos: deps.getEligiblePhotos,
                logger,
                logLabel: 'join',
                // Passed through so a join narrows to on-theme photos the same
                // way a fill does — the picker is shared, so the candidate set
                // has to be too.
                searchTagAutocomplete: deps.searchTagAutocomplete,
                getCurrentMemberProfile: deps.getCurrentMemberProfile,
            },
        );
    } catch (error) {
        cat().warning(`could not read eligible photos for ${challenge?.id}: ${error?.message || error}`, null);
        return null;
    }
    const semanticScores = await resolveSemanticScores(challenge, eligible, { ignoreWords });
    // A shortlist, not one photo, so the visual re-rank a fill applies can
    // promote an on-theme alternative here too.
    const shortlist = pickPhotosForChallenge(challenge, eligible, VISUAL_SHORTLIST, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        semanticScores,
        ignoreWords,
    });
    if (!shortlist || shortlist.length === 0) return null;
    const [picked] = await (deps.rankVisually || rankVisually)(challenge, shortlist, eligible, 1, {
        logger,
        ignoreWords,
    });
    return picked;
};

// ---- the join itself (shared by pass + manual) ----

const failedNoCharge = () => ({ status: 'failed-no-charge', charged: 0 });

/**
 * The check→claim→unlock section, run under the cross-process lock. Re-reads
 * the unlock claim authoritatively — another process may have unlocked between
 * the caller's first check and acquiring the lock.
 *
 * @returns {Promise<{outcome: {status:string, charged:number}}|{charged:number, alreadyUnlocked:boolean}>}
 *   `outcome` ends the join with that result; otherwise the unlock state the
 *   submit continues from.
 */
const claimAndUnlock = async (challenge, token, deps, needsCoins) => {
    const id = challenge?.id;
    const { state, ok: stateOk } = readUnlockedState(deps.joinStateStore);
    if (!stateOk) {
        // Cannot verify prior unlocks → refuse to spend (a re-charge
        // is worse than skipping this candidate this cycle).
        cat().error(`${logger.challengeTag(challenge)}: join-state is unreadable — not spending coins`, null);
        return { outcome: failedNoCharge() };
    }
    if (Object.prototype.hasOwnProperty.call(state, String(id))) {
        return { charged: 0, alreadyUnlocked: true }; // another process already paid → retry submit only
    }
    if (cancellation.isCancelled()) return { outcome: failedNoCharge() };
    // Persist the claim BEFORE spending, so a crash the instant
    // after the charge can never let a later pass re-unlock. If
    // the claim cannot be recorded, do not spend at all.
    if (!markUnlocked(deps.joinStateStore, id)) {
        cat().error(`${logger.challengeTag(challenge)}: could not record the unlock claim — not spending coins`, null);
        return { outcome: failedNoCharge() };
    }
    const unlock = await deps.coinsUnlock(id, token);
    if (!unlock?.ok) {
        clearUnlocked(deps.joinStateStore, id);
        cat().warning(`coins_unlock failed for ${logger.challengeTag(challenge)} — no coins charged`, null);
        return { outcome: failedNoCharge() };
    }
    return { charged: needsCoins, alreadyUnlocked: false };
};

/**
 * Paid unlock, wrapped in the cross-process lock around the check→claim→unlock
 * section so a concurrent process (GUI auto-join vs CLI join) cannot both unlock.
 *
 * @returns {ReturnType<typeof claimAndUnlock>}
 */
const unlockUnderLock = async (challenge, token, deps, needsCoins) => {
    const id = challenge?.id;
    const xlock = deps.acquireUnlockLock ? deps.acquireUnlockLock(id) : { ok: true, release: () => {} };
    if (!xlock.ok) {
        return { outcome: { status: 'busy', charged: 0 } };
    }
    try {
        return await claimAndUnlock(challenge, token, deps, needsCoins);
    } finally {
        xlock.release();
    }
};

/**
 * Submit the photo (the actual join).
 *
 * @param {{charged:number, alreadyUnlocked:boolean}} unlock - coins spent this
 *   call, and whether a prior pass/process already unlocked
 */
const submitJoin = async (challenge, token, deps, needsCoins, imageId, { charged, alreadyUnlocked }) => {
    const id = challenge?.id;
    const coinsSpent = charged > 0 || alreadyUnlocked;
    // If cancelled now and coins are already spent (this call or a prior
    // cycle), report pending-submit — not "no charge", which would misinform
    // the user about money spent.
    if (cancellation.isCancelled()) {
        return coinsSpent ? { status: 'charged-pending-submit', charged } : failedNoCharge();
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
    if (needsCoins > 0 && coinsSpent) {
        cat().error(
            `${logger.challengeTag(challenge)}: coins were charged but the join did not complete — will retry the submit, not re-unlock`,
            null,
        );
        return { status: 'charged-pending-submit', charged };
    }
    return failedNoCharge();
};

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

        let unlock = { charged: 0, alreadyUnlocked: isUnlocked(deps.joinStateStore, id) };

        // 2. Paid unlock (skipped when a prior pass already unlocked → retry submit only).
        if (needsCoins > 0 && !unlock.alreadyUnlocked) {
            const claimed = await unlockUnderLock(challenge, token, deps, needsCoins);
            if ('outcome' in claimed) return claimed.outcome;
            unlock = claimed;
        }

        // 3. Submit the photo (the actual join).
        return await submitJoin(challenge, token, deps, needsCoins, imageId, unlock);
    } finally {
        inFlight.delete(key);
    }
};

// ---- automatic per-cycle pass ----

/**
 * Mutable per-pass join state: the balance and budget kept locally accurate as
 * the pass spends, the clock the join window is measured against, and whether
 * the one-per-pass missing-timing diagnostic has fired.
 *
 * @typedef {{
 *   bankroll: ({coins?: number}|null),
 *   remainingBudget: number,
 *   nowSec: number,
 *   missingCloseTimeLogged: boolean,
 * }} JoinPassState
 */

/**
 * One balance read for the whole pass. A throw here (or a null return) means
 * "balance unknown" ⇒ no paid joins.
 */
const readPassBankroll = async (token, deps) => {
    try {
        return await deps.getBankroll(token);
    } catch (error) {
        cat().warning(`could not read balance (paid joins skipped this pass): ${error?.message || error}`, null);
        return null;
    }
};

/**
 * close_time is epoch SECONDS everywhere in this codebase; `now` arrives as
 * epoch ms. A caller that omits it falls back to the wall clock rather than
 * computing a window against 0, which would fail every candidate closed.
 */
const toPassNowSec = (now) => Math.floor((Number.isFinite(now) && now > 0 ? now : Date.now()) / 1000);

/**
 * @param {object} challenge
 * @param {JoinPassState} pass
 */
const decideCandidateJoin = (challenge, pass) => {
    const cfg = resolveCandidateConfig(challenge);
    return shouldJoinChallenge({
        challenge,
        bankroll: pass.bankroll,
        remainingBudget: pass.remainingBudget,
        includeTypes: cfg.includeTypes,
        excludeTypes: cfg.excludeTypes,
        maxCoins: cfg.maxCoins,
        hasProfileMatch: cfg.hasProfileMatch,
        includeTags: cfg.includeTags,
        excludeTags: cfg.excludeTags,
        joinWithinSec: cfg.joinWithinSec,
        joinAfterPercentElapsed: cfg.joinAfterPercentElapsed,
        nowSec: pass.nowSec,
    });
};

/**
 * Both timing fields get the same one-per-pass diagnostic: each means the window
 * silently stopped joining, which is otherwise indistinguishable from "nothing
 * to join".
 *
 * @param {object} challenge
 * @param {string} reason
 * @param {JoinPassState} pass
 */
const noteTimingRefusal = (challenge, reason, pass) => {
    if (reason !== 'close-time-unknown' && reason !== 'start-time-unknown') return;
    if (pass.missingCloseTimeLogged) return;
    pass.missingCloseTimeLogged = true;
    warnMissingCloseTime(challenge, reason);
};

/**
 * Decide and (when due) perform one candidate's join, keeping the pass's
 * balance and budget in step with what it spent.
 *
 * @param {object} challenge
 * @param {string} token
 * @param {object} deps
 * @param {JoinPassState} pass
 * @returns {Promise<string>} the candidate's result status
 */
const joinCandidate = async (challenge, token, deps, pass) => {
    // Per-candidate enable (master → profile): skip titles auto-join is off
    // for, BEFORE resolving the rest of the config (avoid redundant work).
    if (resolveJoinSetting('autoJoin', challenge) !== true) {
        return 'skipped:autojoin-off';
    }
    const decision = decideCandidateJoin(challenge, pass);
    if (!decision.join) {
        noteTimingRefusal(challenge, decision.reason, pass);
        return `skipped:${decision.reason}`;
    }
    // Guard each candidate: one bad candidate (unexpected throw) must not
    // abort the rest of the pass — mirrors the per-challenge voting loop.
    let outcome;
    try {
        outcome = await performJoin(challenge, token, deps, decision.needsCoins);
    } catch (error) {
        cat().warning(`join failed for ${logger.challengeTag(challenge)}: ${error?.message || error}`, null);
        return 'error';
    }
    if (outcome.charged > 0) {
        pass.remainingBudget -= outcome.charged;
        // A charge only follows a passed affordability check, which already
        // proved Number(bankroll.coins) finite. Coerce the same way so a
        // numeric-string balance is still decremented for the rest of the pass.
        pass.bankroll.coins = Number(pass.bankroll.coins) - outcome.charged;
    }
    return outcome.status;
};

/**
 * Automatic join pass — a pre-step in fetchChallengesAndVote. The `autoJoin`
 * enable is resolved per candidate by title (rule-inline → profile → master), so
 * a titled candidate joins even when the master default is off; the pass only
 * skips wholesale when the master is off AND no title rule turns it on.
 * Sequential, cancellation-aware.
 *
 * Candidates are additionally gated by the join WINDOW
 * (`autoJoinWithinHoursOfEnd`, 0 = off): a candidate outside it is deferred with
 * `skipped:too-early` and reconsidered next cycle, so entries land near a
 * challenge's end rather than the moment it appears.
 *
 * @param {string} token
 * @param {number} now epoch ms — the clock the join window is measured against
 *   (converted to seconds to match `close_time`); defaults to Date.now()
 * @param {object} deps
 * @returns {Promise<{ran:boolean, joined:number, results:Array<object>}>}
 */
const runJoinPass = async (token, now, deps) => {
    const empty = { ran: false, joined: 0, results: [] };
    if (!token) return empty;
    // The master autoJoin is only the default; a title profile can enable joining
    // for its title even when the master is off (resolved master → profile — an
    // un-joined candidate has no cached id for a per-challenge override to key
    // off). So we can only skip the pass entirely when the master is off AND no
    // title profile turns it on. Effective per-candidate enable is resolved in
    // joinCandidate.
    const masterOn = settings.getEffectiveSetting('autoJoin', null) === true;
    // When the master default is off, the pass is still needed if any saved title
    // profile turns autoJoin ON for its title. Check that precisely (a tag-only
    // title rule — an auto-fill tag rule — carries no profile and can never
    // enable joining, so it must NOT keep the pass alive every cycle).
    if (!masterOn && !anyTitleRuleEnablesAutoJoin()) {
        return empty;
    }

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

    const bankroll = await readPassBankroll(token, deps);
    /** @type {JoinPassState} */
    const pass = {
        bankroll,
        remainingBudget: Number(settings.getEffectiveSetting('autoJoinCycleCoinBudget', null)) || 0,
        nowSec: toPassNowSec(now),
        // One diagnostic per pass, not per candidate (see warnMissingCloseTime).
        missingCloseTimeLogged: false,
    };

    const results = [];
    let joined = 0;
    for (const challenge of candidates) {
        if (cancellation.isCancelled()) {
            cat().warning('join pass cancelled by user', null);
            break;
        }
        const status = await joinCandidate(challenge, token, deps, pass);
        if (status === 'joined') joined += 1;
        results.push({ id: challenge?.id, status });
    }

    if (joined > 0) {
        cat().info(`join pass complete: joined ${joined} of ${candidates.length} open challenge(s)`, null);
    }
    return { ran: true, joined, results };
};

// ---- manual single join (explicit paid consent) ----

/**
 * Live balance check for a confirmed paid manual join.
 *
 * @returns {Promise<{status:string, challengeId:(string|number), cost:number, coins?:number}|null>}
 *   the refusal result, or null when the balance covers the cost
 */
const checkAffordable = async (challengeId, cost, token, deps) => {
    const bankroll = await deps.getBankroll(token);
    const coins = Number(bankroll?.coins);
    if (bankroll == null || !Number.isFinite(coins)) {
        return { status: 'balance-unknown', challengeId, cost };
    }
    if (coins < cost) {
        return { status: 'skipped-unaffordable', challengeId, cost, coins };
    }
    return null;
};

/**
 * Join ONE challenge by id, on user request. The `autoJoinWithinHoursOfEnd`
 * window deliberately does NOT apply here — it defers the AUTOMATIC pass, and an
 * explicit click is the user overriding that timing on purpose.
 *
 * Re-fetches the live candidate so a
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
        const refusal = await checkAffordable(challengeId, cost, token, deps);
        if (refusal) return refusal;
    }

    const outcome = await performJoin(challenge, token, deps, cost);
    return { status: outcome.status, challengeId, cost, imageId: outcome.imageId };
};

module.exports = {
    runJoinPass,
    joinChallengeSingle,
    isAutoJoinActive,
    // exported for tests
    performJoin,
    pickJoinPhoto,
    resolveJoinSetting,
    inFlight,
};
