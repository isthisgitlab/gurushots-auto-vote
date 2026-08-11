/**
 * GuruShots Auto Voter - Auto-Fill Service
 *
 * Decides when and how to submit photos into challenges that have
 * empty entry slots near their close time.
 *
 * Two entry points:
 *   - maybeAutoFillChallenge: cycle-driven, schedule-based. Fills at most
 *     one slot per call. The user-defined autoFillSchedule (rows of
 *     { count, seconds }) sets the target entry count for the time
 *     remaining: "have ≥ count entries once ≤ seconds remain". With the
 *     default schedule (2 @ 30m, 3 @ 20m, 4 @ 10m) fills land spaced out
 *     before close. Spacing matters because GuruShots' ranking algorithm
 *     dilutes votes per entry when several are submitted simultaneously;
 *     if the app starts behind schedule it catches up one photo per cycle.
 *   - fillChallengeNow: manual, batched. The GUI buttons call this and
 *     it ignores both the autoFill toggle and the schedule; manual
 *     means explicit user intent.
 *
 * API methods are injected so the scheduler (real API) and the IPC
 * handler (apiFactory strategy, may be mocked) can call the same logic
 * without entangling the modules.
 */

const {
    pickPhotosForChallenge,
    buildScoredCandidates,
    selectEnrichmentSet,
    finalizePick,
    buildSearchTerms,
    detectLetterPrefix,
} = require('./photoPicker');
const { getSemanticScores } = require('./semantic');
const { enrichCandidates, resetPassState: resetPhotoStatsPassState } = require('./photoStats');
const { oneLine } = require('../format/logSafe');
const { getScheduleShift, remapScheduleRows } = require('./scheduleRemap');

/**
 * Semantic match scores for an eligible set, computed once per fill and reused
 * across every picker call in that fill (the emergency path picks twice).
 * Always on: returns a Map<photoId, 0..1> to merge into the picker, or null
 * when the lexicon is unavailable / the challenge has no usable theme text — in
 * which case ranking stays lexical, exactly as before. The scorer
 * (`deps.getSemanticScores`, defaulting to the real module) is injectable so
 * tests can stub it. Never throws.
 *
 * @param {object} challenge
 * @param {Array<object>} eligible
 * @param {{getSemanticScores?: function}} deps
 * @returns {Promise<Map<string, number>|null>}
 */
const resolveSemanticScores = async (challenge, eligible, deps) => {
    const scorer = (deps && deps.getSemanticScores) || getSemanticScores;
    try {
        return await scorer(challenge, eligible);
    } catch {
        return null;
    }
};

/**
 * Extract a concise, human-readable reason from a failed submit_to_challenge
 * response so the ok=false warning is diagnosable instead of opaque. The server
 * returns success:false with a per-image reason (e.g. "This image has won a
 * challenge — it can't participate in another"), sometimes wrapped in HTML. We
 * strip tags and fall back to a truncated dump of whatever shape it is, since
 * the exact field name varies and an empty message is worse than raw JSON.
 *
 * @param {object|null} raw - the submitToChallenge `raw` response
 * @returns {string}
 */
const describeSubmitFailure = (raw) => {
    if (!raw || typeof raw !== 'object') return 'no response body';
    const stripHtml = (s) =>
        String(s)
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    // Common shapes: a top-level message/error, or a per-image errors map/array.
    const direct = raw.message || raw.error || raw.error_message;
    if (typeof direct === 'string' && direct.trim()) return stripHtml(direct);
    const firstErr = Array.isArray(raw.errors) ? raw.errors[0] : null;
    if (typeof firstErr === 'string' && firstErr.trim()) return stripHtml(firstErr);
    return stripHtml(JSON.stringify(raw)).slice(0, 300);
};

/**
 * Fetch the eligible-photo candidates for a challenge, narrowed to its theme.
 *
 * Derives server-side `search` terms from the challenge (Must/Should Include
 * Tags, else the title) via buildSearchTerms and unions the per-term results
 * (deduped by id) so auto-fill prefers on-theme photos — the GuruShots search
 * index is far better than our client-side label matcher. When there are no
 * terms, every search comes back empty, or none of the matches are allowed,
 * fall back to the full unfiltered library (today's behavior) so a slot still
 * gets filled. A single search term erroring is logged and skipped rather than
 * aborting the fill; the final unfiltered fetch lets its error propagate so the
 * caller's existing catch handles it exactly as before.
 *
 * The returned set is fed unchanged into pickPhotosForChallenge, so the
 * must/should/fillWithoutTagMatch ranking semantics are preserved.
 *
 * @param {object} challenge - challenge with id and (optional) title
 * @param {string} token
 * @param {{mustIncludeTags?: string[]|null, shouldIncludeTags?: string[]|null}} tagOpts
 * @param {{getEligiblePhotos: function, logger: object}} deps
 * @returns {Promise<Array<object>>}
 */
const fetchCandidatesForChallenge = async (challenge, token, tagOpts, { getEligiblePhotos, logger }) => {
    const challengeId = challenge.id;
    const terms = buildSearchTerms(challenge, tagOpts);
    // A letter challenge ("Begins With L") yields no search terms on purpose —
    // the library is fetched unfiltered and narrowed client-side by the letter
    // tag filter in pickPhotosForChallenge. Leave a breadcrumb so a "wrong photo"
    // report is traceable to that path.
    const letter = detectLetterPrefix(challenge?.title);
    if (letter && terms.length === 0) {
        logger
            .withCategory('autoFill')
            .debug(
                `autoFill: letter challenge "${letter.toUpperCase()}" for ${logger.challengeTag(challenge)}; fetching full library for client-side tag filtering`,
                null,
            );
    }
    if (terms.length > 0) {
        // Run the per-term searches concurrently — they're independent reads and
        // serialising them would add a round-trip of latency per extra term to
        // the fill path (which can run close to a deadline). allSettled keeps the
        // per-term fault tolerance: one term erroring is logged and skipped, the
        // others still contribute, and the unfiltered fallback below still runs.
        const settled = await Promise.allSettled(
            terms.map((term) => getEligiblePhotos(challengeId, token, { search: term })),
        );
        const byId = new Map();
        settled.forEach((result, i) => {
            if (result.status === 'rejected') {
                const reason = result.reason;
                logger
                    .withCategory('autoFill')
                    .debug(
                        `autoFill: search "${terms[i]}" failed for ${logger.challengeTag(challenge)}: ${(reason && reason.message) || reason}`,
                        null,
                    );
                return;
            }
            const items = result.value;
            if (Array.isArray(items)) {
                // First occurrence wins; dedupe follows term order. The same photo
                // carries the same permission regardless of which search surfaced
                // it (permission is a function of challenge + photo, not the query).
                for (const item of items) {
                    if (item && item.id !== undefined && item.id !== null && !byId.has(item.id)) {
                        byId.set(item.id, item);
                    }
                }
            }
        });
        const union = Array.from(byId.values());
        if (union.some((p) => p && p.permission && p.permission.allowed === true && p.id)) {
            return union;
        }
        // Terms existed but the themed search surfaced no eligible photo, so the
        // fill is about to relax to the full library and may submit an off-theme
        // photo. How loud that should be depends entirely on WHERE the terms came
        // from:
        //
        //   - From the user's own Must/Should Include Tags: their configuration is
        //     matching nothing. That is actionable and worth a warning — it is the
        //     only clue they get for "why did it submit that photo?".
        //   - From the challenge title (the default: no tags configured): this is
        //     routine. The picker's own header notes that a title often cannot be
        //     matched at all — vision labels are concrete nouns, titles are
        //     abstract. Warning here would fire on the common path for every user
        //     who never touched tag settings and train them to ignore warnings.
        //
        // buildSearchTerms with a null challenge yields ONLY the tag-derived terms
        // (its precedence is must -> should -> title), so an empty result proves the
        // terms above came from the title. Reusing it keeps the two in lockstep
        // rather than re-deriving the precedence rule here.
        const fromUserTags = buildSearchTerms(null, tagOpts).length > 0;
        const message =
            `autoFill: themed search (${terms.join(', ')}) for ${logger.challengeTag(challenge)} found no eligible photos; ` +
            `falling back to the full library — an off-theme photo may be submitted`;
        const log = logger.withCategory('autoFill');
        if (fromUserTags) {
            log.warning(`${message}. Your Must/Should Include Tags matched none of your photos.`, null);
        } else {
            log.debug(message, null);
        }
    }
    // paginate: the unfiltered fallback is the ONLY path that walks the whole
    // library. A single page is the 100 most recently uploaded eligible photos,
    // which silently excluded a user's older, strongest work from ever being a
    // candidate. The themed searches above stay single-page on purpose: they are
    // already narrowed by the server's own index, and paging each of them would
    // multiply sequential round-trips on a path that can run close to a deadline.
    return getEligiblePhotos(challengeId, token, { paginate: true });
};

const getEntries = (challenge) => {
    const entries = challenge?.member?.ranking?.entries;
    return Array.isArray(entries) ? entries : [];
};

const getSlotsRemaining = (challenge) => {
    const max = Number.isFinite(challenge?.max_photo_submits) ? challenge.max_photo_submits : 0;
    return Math.max(0, max - getEntries(challenge).length);
};

/**
 * Rows of an autoFillSchedule value that are actually usable. The value comes
 * straight off the persisted settings blob via getEffectiveSetting — no zod
 * re-validation happens on read — and these helpers sit on the per-challenge
 * dispatch path in api/main.js that has no per-challenge try/catch, so a throw
 * here would abort the whole voting cycle for every challenge. Anything that
 * isn't an array of { count, seconds } objects with finite numbers is silently
 * dropped (mirrors getSlotsRemaining's Number.isFinite convention). Length is
 * capped as defense-in-depth: the write path (zod) allows at most
 * MAX_SCHEDULE_ROWS = 3 rows (see settings/schema.js), so anything past a
 * generous read cap can only come from a corrupted blob and would otherwise
 * be iterated every scheduler cycle per challenge.
 *
 * @param {*} schedule
 * @returns {Array<{count: number, seconds: number}>}
 */
const MAX_SCHEDULE_ROWS_READ = 100;
const getValidScheduleRows = (schedule) =>
    Array.isArray(schedule)
        ? schedule
              .slice(0, MAX_SCHEDULE_ROWS_READ)
              .filter(
                  (row) => row && typeof row === 'object' && Number.isFinite(row.count) && Number.isFinite(row.seconds),
              )
        : [];

/**
 * The schedule as it effectively applies to one challenge: valid rows,
 * end-aligned to the challenge's photo limit by scheduleRemap (a 2-image
 * challenge fills its 2nd photo at the Image-4 row's time — see that module's
 * header for the rule). Both threshold computations below MUST go through
 * this so the fill trigger and the scheduler cadence always agree.
 *
 * @param {*} schedule - persisted autoFillSchedule value (untrusted shape)
 * @param {*} maxPhotoSubmits - challenge.max_photo_submits (untrusted shape)
 * @returns {Array<{count: number, seconds: number}>}
 */
const getEffectiveScheduleRows = (schedule, maxPhotoSubmits) =>
    remapScheduleRows(getValidScheduleRows(schedule), maxPhotoSubmits);

/**
 * Target entry count implied by the schedule for the time remaining: the
 * largest row count whose threshold has been reached, over the END-ALIGNED
 * effective rows (getEffectiveScheduleRows — a 2-image challenge's 2nd photo
 * follows the Image-4 row's time), each row clamped to the challenge's
 * max_photo_submits as a residual safety net. Row order is irrelevant.
 * Returns 0 for an empty/invalid schedule, a non-finite secondsRemaining, or
 * a non-finite max (never NaN — a NaN would poison orderDeadlineActions'
 * sort downstream).
 *
 * @param {*} schedule - persisted autoFillSchedule value (untrusted shape)
 * @param {number} secondsRemaining
 * @param {*} maxPhotoSubmits - challenge.max_photo_submits (untrusted shape)
 * @returns {number}
 */
const resolveScheduleTarget = (schedule, secondsRemaining, maxPhotoSubmits) => {
    const max = Number.isFinite(maxPhotoSubmits) ? maxPhotoSubmits : 0;
    if (!Number.isFinite(secondsRemaining)) return 0;
    let target = 0;
    for (const row of getEffectiveScheduleRows(schedule, maxPhotoSubmits)) {
        if (secondsRemaining <= row.seconds) {
            target = Math.max(target, Math.min(row.count, max));
        }
    }
    return target;
};

/**
 * Seconds-before-close at which the next auto-fill becomes due: the largest
 * threshold among END-ALIGNED effective rows (getEffectiveScheduleRows) whose
 * clamped count exceeds the current entry count. 0 when no further row can
 * ever apply (schedule empty/invalid, or every remaining row is already
 * satisfied / shifted away). Used by VotingLogic's orderDeadlineActions so
 * fills sort against boost/turbo/emergency correctly; the same defensive
 * rules as resolveScheduleTarget apply.
 *
 * @param {*} schedule - persisted autoFillSchedule value (untrusted shape)
 * @param {*} entryCount - current number of entries (untrusted shape)
 * @param {*} maxPhotoSubmits - challenge.max_photo_submits (untrusted shape)
 * @returns {number}
 */
const getNextScheduleThresholdSec = (schedule, entryCount, maxPhotoSubmits) => {
    const max = Number.isFinite(maxPhotoSubmits) ? maxPhotoSubmits : 0;
    const count = Number.isFinite(entryCount) ? entryCount : 0;
    let threshold = 0;
    for (const row of getEffectiveScheduleRows(schedule, maxPhotoSubmits)) {
        if (Math.min(row.count, max) > count) {
            threshold = Math.max(threshold, row.seconds);
        }
    }
    return threshold;
};

/**
 * Reflect a freshly submitted entry on the local challenge object so the rest of
 * this cycle sees the slot it consumed. Used by both the "fill-new" boost/turbo
 * path and the staggered/emergency auto-fill paths (which submit before a due
 * turbo/boost runs in timer order). The challenge isn't re-fetched mid-cycle, so
 * without this getSlotsRemaining would still count the just-used slot as free and
 * could over-submit, and a due turbo/boost couldn't act on the new entry. The
 * minimal shape carries the conflict flags that boost/turbo entry selection reads
 * (boosted/turbo).
 */
const reflectNewEntry = (challenge, imageId) => {
    const ranking = challenge?.member?.ranking;
    if (!ranking || !imageId) return;
    if (!Array.isArray(ranking.entries)) ranking.entries = [];
    // Coerce the server-supplied id to a string before it joins shared
    // challenge state (mirrors how _postBoost stringifies the image_id).
    ranking.entries.push({ id: String(imageId), turbo: false, boosted: false, boost: -1, boosting: false });
};

/**
 * Re-fetch live challenge state right before a submit so an entry added
 * outside this pass (e.g. a manual submission made while autorun was working
 * through earlier challenges) is seen before we consume a slot. The
 * pass-start snapshot can be minutes old by the time a fill fires; there is
 * no single-challenge endpoint, so this re-fetches the full active list.
 *
 * Returns:
 *   'refreshed'   – fresh member state merged into `challenge` (in place)
 *   'gone'        – fetch succeeded with a non-empty list that does not
 *                   contain this challenge → caller must skip the submit
 *   'unavailable' – dep not wired, fetch threw, payload malformed, or the
 *                   challenges list came back empty → caller proceeds with
 *                   the pass-start data (stale-over-skip policy)
 *
 * An empty list is 'unavailable', NOT 'gone': makePostRequest never rejects
 * on transport failure — it returns null and getActiveChallenges resolves
 * with { challenges: [] } — so an empty list is exactly what a network blip
 * looks like. Treating it as 'gone' would silently skip legitimate fills on
 * every API hiccup.
 *
 * @param {object} challenge
 * @param {string} token
 * @param {{getActiveChallenges?: function, logger: object}} deps
 * @param {string} label - calling flow (autoFill/emergencyFill/fillNew)
 * @returns {Promise<'refreshed'|'gone'|'unavailable'>}
 */
const refreshChallengeState = async (challenge, token, { getActiveChallenges, logger }, label) => {
    if (typeof getActiveChallenges !== 'function') return 'unavailable';
    const log = logger.withCategory('autoFill');
    // Collapse CR/LF in the cause before interpolation (same forgery guard
    // challengeTag applies): the message can carry server-influenced text.
    const staleWarning = (cause) =>
        log.warning(
            `${label}: could not refresh live challenge state for ${logger.challengeTag(challenge)}${cause ? ` (${String(cause).replace(/[\r\n]+/g, ' ')})` : ''}; ` +
                'proceeding with pass-start data — a manually submitted entry may not be seen and could be duplicated',
            null,
        );
    let response;
    try {
        response = await getActiveChallenges(token);
    } catch (error) {
        staleWarning((error && error.message) || error);
        return 'unavailable';
    }
    if (!Array.isArray(response?.challenges) || response.challenges.length === 0) {
        staleWarning('empty challenge list — likely a transport failure');
        return 'unavailable';
    }
    const fresh = response.challenges.find((c) => String(c?.id) === String(challenge.id));
    if (!fresh) {
        log.info(
            `${label}: ${logger.challengeTag(challenge)} is no longer in the active challenge list — not submitting a new photo to it`,
            null,
        );
        return 'gone';
    }
    // Adopt only a member shape every later consumer of THIS challenge object
    // can survive: the entries array (the guards here), member.boost (runBoost
    // destructures it without a guard and reads .timeout), and ranking.exposure
    // (evaluateVotingDecision reads .exposure_factor off it unguarded). A
    // partial payload would otherwise crash the whole voting pass, not just
    // this challenge — stale beats crashed.
    const member = fresh.member;
    if (
        !member ||
        typeof member !== 'object' ||
        !Array.isArray(member.ranking?.entries) ||
        member.ranking?.exposure == null ||
        !member.boost ||
        typeof member.boost !== 'object'
    ) {
        staleWarning('malformed challenge payload');
        return 'unavailable';
    }
    // Merge, don't blindly replace: entries reflected locally earlier this
    // cycle (reflectNewEntry after a fill-new submit) may not have propagated
    // into get_my_active_challenges yet — dropping them would resurrect the
    // very double-submit this refresh exists to prevent. Union by id only
    // grows the entry count, which errs toward fewer submits. prevEntries is
    // sliced because in mock mode `fresh` can be the identical cached object,
    // making prev and fresh the same array. An id-less prev entry (malformed)
    // can't be matched, so it is kept — again the fewer-submits direction.
    const prevEntries = getEntries(challenge).slice();
    challenge.member = member;
    const freshEntries = member.ranking.entries;
    const freshIds = new Set(
        freshEntries.filter((entry) => entry && entry.id != null).map((entry) => String(entry.id)),
    );
    for (const entry of prevEntries) {
        // An id-less entry (malformed upstream data) can't be matched by id;
        // dedupe it by object identity instead so a repeated refresh — or the
        // mock-mode case where prev and fresh are the same array — never
        // appends a second copy of it.
        const isDuplicate = entry?.id == null ? freshEntries.includes(entry) : freshIds.has(String(entry.id));
        if (entry && !isDuplicate) {
            freshEntries.push(entry);
        }
    }
    return 'refreshed';
};

/**
 * Build the pickPhotosForChallenge onFallback callback for a submission-bound
 * pick. Logs at WARNING level — the debug/info channels are compiled out of
 * packaged builds (logger gates them on isSourceCode), so anything quieter
 * would leave a real user with an unexplained off-theme submission and no
 * trace. `prefix` names the calling flow (autoFill/emergencyFill/manualFill/
 * fillNew) so the line reads like that flow's other logs. Dry-run picks (the
 * emergency-fill probe) must NOT pass this: a probe never submits, so it must
 * never warn.
 */
const makeFallbackLogger = (prefix, challenge, logger) => {
    return ({ letterPrefix, mustStems }) => {
        const reasons = [];
        if (letterPrefix) {
            const letter = letterPrefix.toUpperCase();
            reasons.push(`letter challenge "${letter}" — no eligible photo has a label starting with "${letter}"`);
        }
        if (Array.isArray(mustStems) && mustStems.length > 0) {
            reasons.push('no photo matched every Must Include Tag');
        }
        const why = reasons.join('; ') || 'a hard filter matched no photo';
        logger
            .withCategory('autoFill')
            .warning(
                `${prefix}: ${why} for ${logger.challengeTag(challenge)}; falling back to the full library (an off-theme photo may be submitted)`,
                null,
            );
    };
};

/**
 * Explain a pick that the popularity tiers decided rather than the theme.
 *
 * WARNING level on purpose. debug/info are compiled out of packaged builds (see
 * makeFallbackLogger), and this is the ONLY trace a real user gets for "why did
 * it submit THAT photo?" when a challenge title is too abstract to match
 * anything — which for titles like "Your Legacy" is the normal case, not an
 * edge case.
 *
 * Carries the deciding numbers and the stat coverage, because partial coverage
 * is the one way this can still pick a weaker photo: only photos whose real
 * votes were fetched can be ranked on them, and the per-fill fetch budget means
 * a large library is measured over several fills. Saying "12 of 340" turns that
 * from a silent limitation into something the user can see and wait out.
 */
const logPopularityPick = (prefix, challenge, scored, contestedIds, picked, logger) => {
    // Only the SUBMITTED photos that were actually in the contested group belong
    // in this message. picked[0] is not a safe proxy: a multi-slot fill
    // (emergency fill and manual fill-all both pass wantCount = slotsRemaining)
    // can award slot 1 to a genuine theme match and only later slots on
    // popularity, and naming that first photo would claim "nothing matched the
    // theme" about a photo that did — while leaving the photos that really were
    // chosen blind unexplained.
    const explained = picked
        .map((id) => scored.find((entry) => String(entry.id) === String(id)))
        .filter((entry) => entry && contestedIds.has(String(entry.id)));
    if (explained.length === 0) return;

    // Coverage is read off the SCORED entries, not the photo objects handed to
    // selectEnrichmentSet: enrichCandidates returns copies, so `statsKnown`
    // only ever lands on the scored entries the loop above patched.
    const contestedEntries = scored.filter((entry) => contestedIds.has(String(entry.id)));
    const known = contestedEntries.filter((entry) => entry.statsKnown === true).length;
    const coverage =
        known < contestedEntries.length
            ? `; past-performance figures have been looked up for ${known} of ${contestedEntries.length} of them so far, and the rest are looked up a batch per fill`
            : '';

    // An unmeasured photo still carries the library endpoint's flat votes:0.
    // Printing that as "0 votes" would repeat the exact misreading this feature
    // exists to remove, so say so instead of showing a number we do not have.
    // Photo ids come from the API: collapse CR/LF before interpolating, or a
    // crafted value could forge log lines (CWE-117).
    const describe = (entry) =>
        entry.statsKnown === true
            ? `${oneLine(entry.id)} (${entry.votes} votes, ${entry.achievementCount} achievements, ${entry.views} views)`
            : `${oneLine(entry.id)} (past performance not looked up yet — ranked below any photo that was)`;

    logger
        .withCategory('autoFill')
        .warning(
            `${prefix}: nothing in ${logger.challengeTag(challenge)} matched the challenge theme, so ` +
                `${explained.length === 1 ? 'the entry was' : `${explained.length} entries were`} chosen on past performance — ` +
                `${explained.map(describe).join('; ')} ` +
                `out of ${contestedEntries.length} equally off-theme candidates${coverage}. ` +
                `Set a Per-Title Tag Rule for this challenge title in Settings to steer which photos qualify.`,
            null,
        );
};

/**
 * The one fill pipeline all four public entry points share:
 *
 *   fetch candidates → semantic scores → (optional probe) → pick →
 *   (optional pick guard) → (optional pre-submit live re-check) → submit
 *
 * maybeAutoFillChallenge / maybeEmergencyFillChallenge / fillChallengeNow /
 * submitNewEntryForAction all run this exact sequence and differ only in
 * their entry guards, their per-path hooks, and how they map the outcome to
 * their own return shape — so the sequence lives here once, parameterized by
 * `label` (the log prefix: autoFill/emergencyFill/manualFill/fillNew, which
 * also names the refresh flow) and the hooks below. Every log line the
 * pipeline emits keeps the exact wording the four paths always had.
 *
 * IMPORTANT — reflectNewEntry is deliberately NOT called here. The four
 * paths disagree about it:
 *   - maybeAutoFillChallenge and maybeEmergencyFillChallenge reflect
 *     internally after a successful submit;
 *   - fillChallengeNow never reflects;
 *   - submitNewEntryForAction leaves the reflect to its orchestrator
 *     callers, which call autoFill.reflectNewEntry(challenge, imageId)
 *     after a successful return.
 * Reflecting in this helper would make those orchestrator callers reflect
 * TWICE, silently duplicating the entry in challenge.member.ranking.entries
 * and corrupting getSlotsRemaining plus boost/turbo entry selection for the
 * rest of the voting pass. The helper only returns the submitted `picked`
 * ids; each entry point owns its reflect behavior.
 *
 * Hooks (each used by exactly one path; all optional):
 *   - probeStandDown({ eligible, semanticScores }) → truthy to stand down
 *     before the real pick (emergency fill's dry-run "would the staggered
 *     path have filled this?" probe — it must not emit fallback warnings,
 *     so the hook runs its own picker call without onFallback).
 *   - onEmptyPick(eligible) → replaces the default
 *     "`label`: no eligible photos" info line; its return value comes back
 *     as `detail` (manual fill derives its user-facing error string here).
 *   - guardPick(picked) → truthy to abort after the pick but before the
 *     refresh/submit (fill-new's defensive empty-image-id check).
 *   - onRefreshed(picked) → runs after refreshChallengeState returns
 *     'refreshed'; return { standDown: true } to abort, { picked } to
 *     replace the batch (emergency fill truncates to the fresh free-slot
 *     count), or null to proceed. When the hook is absent the live
 *     re-check is skipped entirely (manual fill).
 *
 * @param {{
 *   label: 'autoFill'|'emergencyFill'|'manualFill'|'fillNew',
 *   challenge: object,
 *   token: string,
 *   deps: object,
 *   wantCount: number,
 *   mustIncludeTags: string[]|null,
 *   shouldIncludeTags: string[]|null,
 *   fillWithoutTagMatch: *,
 *   probeStandDown?: (function({eligible: Array<object>, semanticScores: Map<string, number>|null}): boolean)|null,
 *   onEmptyPick?: (function(Array<object>): *)|null,
 *   guardPick?: (function(Array<string>): boolean)|null,
 *   onRefreshed?: (function(Array<string>): ({standDown?: boolean, picked?: Array<string>}|null))|null,
 * }} params
 * @returns {Promise<
 *   {status: 'fetch-error', error: *}
 *   | {status: 'probe-stand-down'}
 *   | {status: 'no-pick', detail: *}
 *   | {status: 'bad-pick'}
 *   | {status: 'gone'}
 *   | {status: 'refresh-stand-down'}
 *   | {status: 'submitted', picked: Array<string>}
 *   | {status: 'submit-rejected', reason: string}
 *   | {status: 'submit-threw', error: *}
 * >}
 */
const runFillAttempt = async ({
    label,
    challenge,
    token,
    deps,
    wantCount,
    mustIncludeTags,
    shouldIncludeTags,
    fillWithoutTagMatch,
    probeStandDown = null,
    onEmptyPick = null,
    guardPick = null,
    onRefreshed = null,
}) => {
    const { logger, getEligiblePhotos, submitToChallenge } = deps;

    let eligible;
    try {
        eligible = await fetchCandidatesForChallenge(
            challenge,
            token,
            { mustIncludeTags, shouldIncludeTags },
            { getEligiblePhotos, logger },
        );
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(
                `${label}: failed to fetch eligible photos for ${logger.challengeTag(challenge)}: ${error.message || error}`,
                null,
            );
        return { status: 'fetch-error', error };
    }

    // Score once and reuse for every picker call in this fill (the emergency
    // probe and its actual pick rank the same eligible set, so they must see
    // the same map).
    const semanticScores = await resolveSemanticScores(challenge, eligible, deps);

    if (probeStandDown && probeStandDown({ eligible, semanticScores })) {
        return { status: 'probe-stand-down' };
    }

    // Everything below is submission-bound. The probe above deliberately runs
    // FIRST and on unenriched data: it decides only WHETHER to stand down, never
    // WHICH photo to submit, so it does not need real vote counts — and it runs
    // on every scheduler cycle inside the emergency window, usually to stand
    // down. Enriching before it would spend a burst of get_image_data requests
    // per cycle to submit nothing. Do not "fix" this asymmetry.
    const scored = buildScoredCandidates(challenge, eligible, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        semanticScores,
        onFallback: makeFallbackLogger(label, challenge, logger),
    });

    // Stat enrichment. selectEnrichmentSet returns the candidates still
    // competing for the last slot after the theme tiers — i.e. exactly the set
    // whose order the popularity tiers decide. It is empty whenever the theme
    // settled things, so a clean match costs no extra requests.
    const contested = selectEnrichmentSet(scored, wantCount);
    const contestedIds = new Set(contested.map((photo) => String(photo.id)));
    if (contested.length > 0) {
        const enriched = await enrichCandidates(contested, token, deps);
        const statsById = new Map(enriched.map((photo) => [String(photo.id), photo]));
        for (const entry of scored) {
            const fresh = statsById.get(String(entry.id));
            if (!fresh) continue;
            entry.statsKnown = fresh.statsKnown === true;
            if (entry.statsKnown) {
                entry.votes = Number.isFinite(fresh.votes) ? fresh.votes : entry.votes;
                entry.views = Number.isFinite(fresh.views) ? fresh.views : entry.views;
                entry.achievementCount = Number.isFinite(fresh.achievementCount)
                    ? fresh.achievementCount
                    : entry.achievementCount;
            }
        }
    }

    let picked = finalizePick(scored, wantCount);
    if (picked.length === 0) {
        if (onEmptyPick) {
            return { status: 'no-pick', detail: onEmptyPick(eligible) };
        }
        logger
            .withCategory('autoFill')
            .info(`${label}: no eligible photos for ${logger.challengeTag(challenge)}`, null);
        return { status: 'no-pick', detail: null };
    }

    if (guardPick && guardPick(picked)) {
        return { status: 'bad-pick' };
    }

    // Live re-check just before consuming a slot: the pass-start snapshot can
    // be minutes old, and an entry added outside this run (e.g. a manual
    // submission) must stand the fill down instead of over-submitting.
    if (onRefreshed) {
        const refresh = await refreshChallengeState(challenge, token, deps, label);
        if (refresh === 'gone') {
            return { status: 'gone' };
        }
        if (refresh === 'refreshed') {
            const verdict = onRefreshed(picked);
            if (verdict && verdict.standDown) {
                return { status: 'refresh-stand-down' };
            }
            if (verdict && Array.isArray(verdict.picked)) {
                picked = verdict.picked;
            }
        }
    }

    try {
        const result = await submitToChallenge(challenge.id, picked, token);
        if (result && result.ok) {
            // Explain the pick only once it actually became an entry. Logging
            // earlier would tell the user "this photo was chosen" for a fill
            // that then stood down on the live re-check or was rejected — an
            // entry they would go looking for and never find. `picked` is also
            // final only here: onRefreshed can replace it.
            if (contested.length > 0) {
                logPopularityPick(label, challenge, scored, contestedIds, picked, logger);
            }
            return { status: 'submitted', picked };
        }
        const reason = describeSubmitFailure(result && result.raw);
        logger
            .withCategory('autoFill')
            .warning(`${label}: submit rejected for ${logger.challengeTag(challenge)}: ${reason}`, null);
        return { status: 'submit-rejected', reason };
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(`${label}: submit threw for ${logger.challengeTag(challenge)}: ${error.message || error}`, null);
        return { status: 'submit-threw', error };
    }
};

/**
 * Cycle-driven, schedule-based auto-fill. Submits at most one photo per
 * call; the next call (next scheduler cycle) will see the updated
 * entries.length and either skip (target met) or submit again — so a
 * challenge behind schedule catches up one photo per cycle.
 *
 * @param {object} challenge - challenge with member.ranking.entries
 * @param {string} token
 * @param {number} now - unix seconds
 * @param {{
 *   settings: object,
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 *   getActiveChallenges?: function,
 * }} deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data (legacy behavior).
 * @returns {Promise<'submitted'|'skipped'|'disabled'|'no-schedule'|'no-eligible-photos'|'error'>}
 */
const maybeAutoFillChallenge = async (challenge, token, now, deps) => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) return 'skipped';

    const enabled = settings.getEffectiveSetting('autoFill', String(challengeId));
    if (enabled !== true) return 'disabled';

    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return 'skipped';
    const secondsRemaining = closeTime - now;
    if (secondsRemaining <= 0) return 'skipped';

    let slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) return 'skipped';

    const schedule = settings.getEffectiveSetting('autoFillSchedule', String(challengeId));
    // Distinct from 'disabled' (toggle off): the toggle is on but there is no
    // schedule to act on — a deliberate opt-out state the GUI editor warns about.
    if (!Array.isArray(schedule) || schedule.length === 0) return 'no-schedule';

    const desired = resolveScheduleTarget(schedule, secondsRemaining, challenge.max_photo_submits);
    if (getEntries(challenge).length >= desired) {
        // Schedule satisfied but free slots remain and no further row will ever
        // raise the target — the schedule tops out below what the challenge
        // allows. WARNING (not debug/info, which are compiled out of packaged
        // builds — see makeFallbackLogger) so a real user has a trace for why
        // those slots stay empty until emergency fill.
        const max = Number.isFinite(challenge.max_photo_submits) ? challenge.max_photo_submits : 0;
        // Highest target the schedule can ever demand = the target as time
        // runs out (secondsRemaining → 0 matches every row), so reuse
        // resolveScheduleTarget instead of re-deriving the clamp-and-max here.
        const maxTarget = resolveScheduleTarget(schedule, 0, max);
        if (desired > 0 && desired === maxTarget && maxTarget < max) {
            logger
                .withCategory('autoFill')
                .warning(
                    `autoFill: schedule tops out at ${maxTarget} entries but ${logger.challengeTag(challenge)} allows ${max} — remaining slots are left to emergency fill`,
                    null,
                );
        }
        return 'skipped';
    }

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

    const attempt = await runFillAttempt({
        label: 'autoFill',
        challenge,
        token,
        deps,
        wantCount: 1,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        onRefreshed: () => {
            slotsRemaining = getSlotsRemaining(challenge);
            const entryCount = getEntries(challenge).length;
            if (slotsRemaining <= 0 || entryCount >= desired) {
                logger
                    .withCategory('autoFill')
                    .info(
                        `autoFill: live re-check shows ${logger.challengeTag(challenge)} already has ${entryCount} entries (target ${desired}) — an entry was added outside this run (e.g. a manual submission); standing down`,
                        null,
                    );
                return { standDown: true };
            }
            return null;
        },
    });
    if (attempt.status === 'no-pick') return 'no-eligible-photos';
    if (attempt.status === 'gone' || attempt.status === 'refresh-stand-down') return 'skipped';
    if (attempt.status !== 'submitted') return 'error';

    // Reflect the consumed slot locally so a due turbo/boost later this
    // cycle (timer order) sees the new entry and correct slot count.
    reflectNewEntry(challenge, attempt.picked[0]);
    // When the schedule was end-aligned (challenge allows fewer images
    // than the schedule's span), say which row's time governed this fill
    // — the resolved mapping, not a bare shift count. Success-level on
    // purpose: debug/info are compiled out of packaged builds, and the
    // remapped timing is exactly what a user checking "why did it fill
    // now?" needs to see. Attribute the TARGET's row (`desired + shift`
    // maps back to the original image number that set the current
    // target), not the entry number: during catch-up the entry being
    // submitted may sit on an off row and was never scheduled itself.
    // Sanitize max before it reaches the log line: the challenge object
    // is untrusted API shape, and interpolating the raw field would let
    // a malformed value (e.g. a string with newlines) forge log lines.
    const maxSubmits = Number.isFinite(challenge.max_photo_submits) ? challenge.max_photo_submits : 0;
    const shift = getScheduleShift(getValidScheduleRows(schedule), maxSubmits);
    const shiftNote =
        shift > 0
            ? `; ${maxSubmits}-image challenge — the target of ${desired} entries follows the Image ${desired + shift} time`
            : '';
    // `slotsRemaining` is the pre-reflect snapshot (updated by onRefreshed when
    // the live re-check merged fresh state), so `- 1` is the post-submit count
    // — keep this log after the reflect, not before.
    logger
        .withCategory('autoFill')
        .success(
            `autoFill: submitted 1 entry for ${logger.challengeTag(challenge)} (${slotsRemaining - 1} slots remain${shiftNote})`,
            null,
        );
    return 'submitted';
};

/**
 * Emergency fill — a safety net for the two cases the staggered
 * auto-fill path deliberately leaves empty right up to the deadline:
 *   (a) auto-fill is off for the challenge, or
 *   (b) a Must Include Tags filter is set, nothing matches it, and
 *       fillWithoutTagMatch is off (so the slot would stay empty).
 *
 * When the challenge is within `emergencyFill` seconds of closing and in
 * one of those states, fill every remaining slot in a single submission,
 * relaxing the must-include hard filter (the whole point is "don't leave
 * slots empty at the buzzer"). There's no time to stagger this close to
 * the end, so unlike maybeAutoFillChallenge it batches all slots at once,
 * like the manual "fill all" button. Self-guarding: if auto-fill would
 * already handle the challenge, it returns 'skipped' so it never
 * double-fills.
 *
 * @param {object} challenge - challenge with member.ranking.entries
 * @param {string} token
 * @param {number} now - unix seconds
 * @param {{
 *   settings: object,
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 *   getActiveChallenges?: function,
 * }} deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data (legacy behavior).
 * @returns {Promise<'submitted'|'skipped'|'disabled'|'no-eligible-photos'|'error'>}
 */
const maybeEmergencyFillChallenge = async (challenge, token, now, deps) => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) return 'skipped';

    const emergencySeconds = settings.getEffectiveSetting('emergencyFill', String(challengeId));
    if (!Number.isFinite(emergencySeconds) || emergencySeconds <= 0) return 'disabled';

    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return 'skipped';
    const secondsRemaining = closeTime - now;
    if (secondsRemaining <= 0) return 'skipped';
    if (secondsRemaining > emergencySeconds) return 'skipped'; // not in the emergency window yet

    let slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) return 'skipped';

    const autoFillEnabled = settings.getEffectiveSetting('autoFill', String(challengeId)) === true;
    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

    // Stand down before any network call when normal auto-fill already owns
    // this challenge: auto-fill on with no must-include filter means the
    // staggered path fills the slots, so emergency fill has nothing to add.
    // This is the common configuration, so the early return avoids fetching
    // eligible photos every cycle just to discard them.
    const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;
    if (autoFillEnabled && !mustActive) return 'skipped';

    const attempt = await runFillAttempt({
        label: 'emergencyFill',
        challenge,
        token,
        deps,
        // Fill every remaining slot. Keep the user's tag preferences (must
        // photos still win when they exist) but force fillWithoutTagMatch on so
        // a missing match never leaves a slot empty at the deadline — that
        // override is the whole point of emergency fill.
        wantCount: slotsRemaining,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch: true,
        // With auto-fill on and a must-include filter set, only step in if that
        // filter would leave the slot empty (a non-empty result means the normal
        // staggered path can still fill it, so stand down). With auto-fill off,
        // always step in — nothing else will fill the slot. Dry-run probe: no
        // onFallback, and the user's real fillWithoutTagMatch setting applies.
        probeStandDown: autoFillEnabled
            ? ({ eligible, semanticScores }) =>
                  pickPhotosForChallenge(challenge, eligible, 1, {
                      mustIncludeTags,
                      shouldIncludeTags,
                      fillWithoutTagMatch,
                      semanticScores,
                  }).length > 0
            : null,
        // Live re-check just before the batch submit: an entry added outside
        // this run (e.g. a manual submission) shrinks the free-slot count, and
        // the batch must never over-fill past it.
        onRefreshed: (picked) => {
            slotsRemaining = getSlotsRemaining(challenge);
            if (slotsRemaining <= 0) {
                logger
                    .withCategory('autoFill')
                    .info(
                        `emergencyFill: live re-check shows ${logger.challengeTag(challenge)} has no free slots — an entry was added outside this run (e.g. a manual submission); standing down`,
                        null,
                    );
                return { standDown: true };
            }
            if (picked.length > slotsRemaining) {
                return { picked: picked.slice(0, slotsRemaining) };
            }
            return null;
        },
    });
    if (attempt.status === 'no-pick') return 'no-eligible-photos';
    if (attempt.status === 'probe-stand-down' || attempt.status === 'gone' || attempt.status === 'refresh-stand-down') {
        return 'skipped';
    }
    if (attempt.status !== 'submitted') return 'error';

    // Reflect every consumed slot locally so a due turbo/boost later this
    // cycle (timer order) sees the new entries and correct slot count.
    for (const id of attempt.picked) reflectNewEntry(challenge, id);
    logger
        .withCategory('autoFill')
        .success(
            `emergencyFill: submitted ${attempt.picked.length} entr${attempt.picked.length === 1 ? 'y' : 'ies'} for ${logger.challengeTag(challenge)} near deadline`,
            null,
        );
    return 'submitted';
};

/**
 * Manual fill (GUI button). Submits one or all missing slots in a
 * single request. Ignores the autoFill toggle and the spacing math,
 * but still honors mustIncludeTags / shouldIncludeTags so the tag
 * rules mean the same thing whether triggered by the user or the
 * scheduler.
 *
 * @param {object} challenge
 * @param {string} token
 * @param {'one'|'all'} mode
 * @param {{
 *   settings?: object,
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 * }} deps - settings is required in production (the IPC handler always
 *   passes it); it is optional only so legacy failure-path unit tests can
 *   omit it, in which case tag rules degrade to "no filter".
 * @returns {Promise<{success: boolean, submitted: number, skipped: number, error?: string}>}
 */
const fillChallengeNow = async (challenge, token, mode, deps) => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) {
        return { success: false, submitted: 0, skipped: 0, error: 'Invalid challenge' };
    }

    const slotsRemaining = getSlotsRemaining(challenge);
    if (slotsRemaining <= 0) {
        return { success: true, submitted: 0, skipped: 0 };
    }

    // Manual "Fill Now" is its own operation, not part of a voting pass, so it
    // gets a fresh photo-stats budget and failure breaker. Without this an
    // earlier background pass that tripped the breaker would silently deny stat
    // enrichment to every manual fill until the next pass happened to reset it.
    resetPhotoStatsPassState();

    // settings is optional for fillChallengeNow — unit tests for legacy
    // failure paths invoke without it. The production IPC handler always
    // passes settings, so this branch firing in real runs would mean a
    // caller forgot to wire deps; emit a debug line so it's observable.
    let mustIncludeTags = null;
    let shouldIncludeTags = null;
    let fillWithoutTagMatch; // undefined → picker treats as default (true)
    if (settings) {
        mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
        shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
        fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));
    } else {
        logger
            .withCategory('autoFill')
            .debug(
                `manualFill: settings module not provided to fillChallengeNow for ${logger.challengeTag(challenge)}; tag rules will not apply`,
                null,
            );
    }

    const attempt = await runFillAttempt({
        label: 'manualFill',
        challenge,
        token,
        deps,
        wantCount: mode === 'all' ? slotsRemaining : 1,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        // No onRefreshed hook: manual fill is explicit user intent acting on
        // the state the user is looking at — it never ran the pre-submit live
        // re-check, and keeps not running it.
        onEmptyPick: (eligible) => {
            // When the "must include" filter is active and there were photos to
            // consider, it's the most likely reason nothing was picked — say so,
            // otherwise the user sees a generic message and can't tell their own
            // tag filter is the cause.
            const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;
            const hadCandidates = Array.isArray(eligible) && eligible.length > 0;
            const error =
                mustActive && hadCandidates
                    ? 'No photos matched the Must Include Tags filter'
                    : 'No eligible photos found';
            logger
                .withCategory('autoFill')
                .info(`manualFill: ${error.toLowerCase()} for ${logger.challengeTag(challenge)}`, null);
            return error;
        },
    });
    if (attempt.status === 'fetch-error') {
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: attempt.error.message || 'Failed to fetch photos',
        };
    }
    if (attempt.status === 'no-pick') {
        return { success: false, submitted: 0, skipped: slotsRemaining, error: attempt.detail };
    }
    if (attempt.status === 'submit-rejected') {
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: `Submit rejected: ${attempt.reason}`,
        };
    }
    if (attempt.status !== 'submitted') {
        // Only 'submit-threw' can reach here — manual fill wires no probe,
        // pick-guard, or refresh hook, so those statuses cannot occur.
        return {
            success: false,
            submitted: 0,
            skipped: slotsRemaining,
            error: attempt.error.message || 'Submit failed',
        };
    }

    // No reflectNewEntry here: manual fill has always left the local challenge
    // object untouched (the GUI re-fetches state after the IPC call returns).
    logger
        .withCategory('autoFill')
        .success(`manualFill: submitted ${attempt.picked.length} entries for ${logger.challengeTag(challenge)}`, null);
    return {
        success: true,
        submitted: attempt.picked.length,
        skipped: Math.max(0, slotsRemaining - attempt.picked.length),
    };
};

/**
 * Submit exactly one new photo into a challenge and return its id, so the
 * caller can immediately boost/turbo that fresh entry (the "fill new"
 * boost/turbo options). Unlike maybeAutoFillChallenge/fillChallengeNow this
 * returns the submitted photo id rather than a count — boost/turbo need the
 * id to act on. Photo selection reuses the same tag rules and picker as
 * auto-fill so "fill new" honors the user's Must/Should Include Tags config.
 *
 * Never submits when the challenge is already full (getSlotsRemaining guard),
 * so callers can safely fall back to acting on an existing entry.
 *
 * @param {object} challenge - challenge with member.ranking.entries
 * @param {string} token
 * @param {{
 *   settings: object,
 *   logger: object,
 *   getEligiblePhotos: function,
 *   submitToChallenge: function,
 *   getActiveChallenges?: function,
 * }} deps - getActiveChallenges enables the pre-submit live re-check; when
 *   absent the fill proceeds on pass-start data (legacy behavior).
 * @returns {Promise<{ok: boolean, imageId: string|null, reason: string}>}
 *   reason ∈ 'submitted'|'no-slots'|'challenge-gone'|'no-eligible'|'fetch-error'|'submit-failed'|'invalid-challenge'
 */
const submitNewEntryForAction = async (challenge, token, deps) => {
    const { settings, logger } = deps;
    const challengeId = challenge?.id;
    if (challengeId === undefined || challengeId === null) {
        return { ok: false, imageId: null, reason: 'invalid-challenge' };
    }

    // Slots-full is guarded here so callers never submit beyond the limit;
    // they fall back to acting on an existing entry instead.
    if (getSlotsRemaining(challenge) <= 0) {
        return { ok: false, imageId: null, reason: 'no-slots' };
    }

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

    const attempt = await runFillAttempt({
        label: 'fillNew',
        challenge,
        token,
        deps,
        wantCount: 1,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        guardPick: (picked) => {
            if (picked[0]) return false;
            // Defensive: pickPhotosForChallenge only returns truthy ids, but guard
            // so an empty value never propagates to the boost/turbo image_id —
            // applyBoostToEntry has no own null-guard (unlike applyTurbo).
            logger
                .withCategory('autoFill')
                .info(`fillNew: picked an empty photo id for ${logger.challengeTag(challenge)}`, null);
            return true;
        },
        // Live re-check just before consuming a slot: an entry added outside
        // this run (e.g. a manual submission) may have filled the challenge
        // since the pass-start snapshot; callers fall back to acting on an
        // existing entry.
        onRefreshed: () => {
            if (getSlotsRemaining(challenge) <= 0) {
                logger
                    .withCategory('autoFill')
                    .info(
                        `fillNew: live re-check shows ${logger.challengeTag(challenge)} has no free slots — an entry was added outside this run (e.g. a manual submission); not submitting a new photo`,
                        null,
                    );
                return { standDown: true };
            }
            return null;
        },
    });
    if (attempt.status === 'fetch-error') return { ok: false, imageId: null, reason: 'fetch-error' };
    if (attempt.status === 'no-pick' || attempt.status === 'bad-pick') {
        return { ok: false, imageId: null, reason: 'no-eligible' };
    }
    if (attempt.status === 'gone') return { ok: false, imageId: null, reason: 'challenge-gone' };
    if (attempt.status === 'refresh-stand-down') return { ok: false, imageId: null, reason: 'no-slots' };
    if (attempt.status !== 'submitted') return { ok: false, imageId: null, reason: 'submit-failed' };

    // No reflectNewEntry here — on purpose. The orchestrator callers reflect
    // the returned id themselves (autoFill.reflectNewEntry(challenge,
    // filled.imageId) after a successful return); reflecting here too would
    // duplicate the entry. See runFillAttempt's header.
    const imageId = attempt.picked[0];
    logger
        .withCategory('autoFill')
        .success(`fillNew: submitted entry ${imageId} for ${logger.challengeTag(challenge)}`, null);
    return { ok: true, imageId, reason: 'submitted' };
};

module.exports = {
    maybeAutoFillChallenge,
    maybeEmergencyFillChallenge,
    fillChallengeNow,
    submitNewEntryForAction,
    reflectNewEntry,
    resolveScheduleTarget,
    getNextScheduleThresholdSec,
    // exported for tests
    getEffectiveScheduleRows,
    getSlotsRemaining,
    fetchCandidatesForChallenge,
    resolveSemanticScores,
    describeSubmitFailure,
    refreshChallengeState,
};
