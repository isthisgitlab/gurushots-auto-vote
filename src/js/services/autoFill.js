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
    parseNegation,
    hasThemeMatch,
} = require('./photoPicker');
const { getSemanticScores } = require('./semantic');
const { rankVisually } = require('./visionVerifier');
const lexicon = require('./semantic/lexicon');
const { resolveTermsToTags } = require('./tagResolver');
const { enrichCandidates, resetPassState: resetPhotoStatsPassState } = require('./photoStats');
const { oneLine } = require('../format/logSafe');
const { getScheduleShift, remapScheduleRows } = require('./scheduleRemap');

/**
 * Semantic match scores for an eligible set, computed once per fill and reused
 * across every picker call in that fill (the emergency path picks twice).
 * Always on: returns a Map<photoId, {score, support}> to merge into the picker
 * — best-label similarity plus how many labels are on theme — or null
 * when the lexicon is unavailable / the challenge has no usable theme text — in
 * which case ranking stays lexical, exactly as before. The scorer
 * (`deps.getSemanticScores`, defaulting to the real module) is injectable so
 * tests can stub it. Never throws.
 *
 * @param {object} challenge
 * @param {Array<object>} eligible
 * @param {{getSemanticScores?: function}} deps
 * @returns {Promise<Map<string, {score: number, support: number}>|null>}
 */
const resolveSemanticScores = async (challenge, eligible, deps) => {
    const scorer = (deps && deps.getSemanticScores) || getSemanticScores;
    try {
        return await scorer(challenge, eligible, (deps && deps.ignoreWords) || null);
    } catch {
        return null;
    }
};

/**
 * The user's ignore-words list for this challenge, or null.
 *
 * Resolved HERE rather than threaded from each caller: mustIncludeTags and
 * shouldIncludeTags are already read at six separate sites and passed down by
 * hand, and a value that has to be repeated six times is a value that will be
 * forgotten at one of them — which is exactly how tag resolution shipped wired
 * everywhere except the shared runner. runFillAttempt already receives
 * `settings` in deps, so one lookup here covers every fill path at once.
 *
 * @param {object} settings - the settings facade from deps
 * @param {object} challenge
 * @returns {Array<string>|null}
 */
const resolveIgnoreWords = (settings, challenge) => {
    try {
        if (!settings || typeof settings.getEffectiveIgnoreTitleWords !== 'function') return null;
        return settings.getEffectiveIgnoreTitleWords(challenge);
    } catch {
        // A settings read must never fail a fill.
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

// Member identity for tag resolution, memoised per token.
//
// get_current_member_profile is a token-only read whose answer cannot change
// within a run, while a fill pass touches every active challenge — so without
// this the identity lookup would repeat on each one. Keyed by token so a
// re-login naturally misses; bounded because an unbounded map keyed by a
// credential is a leak waiting to happen, and one entry is the realistic case.
const memberIdCache = new Map();
const MAX_MEMBER_ID_CACHE = 4;

// How long a FAILED identity lookup stays cached before it is retried.
//
// A successful id cannot change under a given token, so it is cached for the
// process lifetime. A null is different: the common cause is a transient
// network blip, not "this account cannot do it", and caching that permanently
// would let one flaky request silently disable tag resolution for the whole
// session — reverting to the off-theme fills this feature exists to stop, with
// nothing in the UI to explain it. Expiring the negative keeps the retry cheap
// (one call a minute at worst) without hammering a genuinely broken endpoint.
const NEGATIVE_IDENTITY_TTL_MS = 60_000;

/**
 * The member id tag resolution needs, or null when it cannot be determined.
 *
 * Resolved from the session token rather than the login field on purpose: the
 * app authenticates with an email, and search_autocomplete rejects an email
 * ("Couldn't find username"). The profile's own id is what it accepts.
 *
 * @param {string} token
 * @param {function} getCurrentMemberProfile
 * @returns {Promise<string|null>}
 */
const resolveMemberId = async (token, getCurrentMemberProfile, logger, logLabel) => {
    const cached = memberIdCache.get(token);
    // A resolved id never expires; a cached null does (see NEGATIVE_IDENTITY_TTL_MS).
    if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) return cached.promise;

    // Cache the PROMISE, not the value, so two fills racing on the same token
    // share one request instead of both missing an empty cache and issuing it.
    // A voting pass is sequential, but manual "Fill Now" is not.
    const promise = (async () => {
        try {
            const profile = await getCurrentMemberProfile(token);
            if (profile && typeof profile.id === 'string' && profile.id !== '') return profile.id;
            return null;
        } catch (error) {
            // Never fails a fill — but say so at debug level, or the eventual
            // "why did tag resolution stop firing?" has no thread to pull.
            if (logger) {
                logger
                    .withCategory(logLabel || 'autoFill')
                    .debug(
                        `${logLabel || 'autoFill'}: identity lookup failed: ${(error && error.message) || error}`,
                        null,
                    );
            }
            return null;
        }
    })();

    if (memberIdCache.size >= MAX_MEMBER_ID_CACHE) memberIdCache.clear();
    const entry = { promise, expiresAt: null };
    memberIdCache.set(token, entry);
    // Fire-and-forget by design: the caller awaits `promise` itself, this only
    // stamps the expiry afterwards. `void` because the inner function catches
    // everything and resolves to null, so there is no rejection to handle.
    void promise.then((id) => {
        if (id === null) entry.expiresAt = Date.now() + NEGATIVE_IDENTITY_TTL_MS;
    });
    return promise;
};

/**
 * Resolve challenge terms to real library tags, or [] when resolution is
 * unavailable for any reason (deps not injected, no identity, nothing on
 * theme). Never throws — the caller falls back exactly as it did before.
 *
 * @param {Array<string>} terms
 * @param {object} challenge
 * @param {object} opts
 * @returns {Promise<Array<string>>}
 */
const resolveTagsForTerms = async (terms, challenge, opts) => {
    const { token, searchTagAutocomplete, getCurrentMemberProfile, logger, logLabel } = opts;
    if (typeof searchTagAutocomplete !== 'function' || typeof getCurrentMemberProfile !== 'function') return [];
    try {
        const memberId = await resolveMemberId(token, getCurrentMemberProfile, logger, logLabel);
        if (!memberId) return [];
        return await resolveTermsToTags(terms, challenge, {
            token,
            memberId,
            searchTagAutocomplete,
            logger,
            logLabel,
            ignoreWords: opts.ignoreWords || null,
        });
    } catch (error) {
        logger
            .withCategory(logLabel)
            .debug(`${logLabel}: tag resolution unavailable: ${(error && error.message) || error}`, null);
        return [];
    }
};

// Test-only: drop the memoised identity between cases.
const __resetMemberIdCache = () => memberIdCache.clear();

// Wall-clock budget for the THEMED PHASE of one candidate fetch — not for one
// searchUnion call. The distinction is load-bearing: fetchCandidatesForChallenge
// can run searchUnion TWICE in sequence (once on the raw terms, then again on
// the tag-resolver's output when the first missed), so a per-call budget would
// silently stack to double this before the unfiltered fallback's own
// PAGINATE_BUDGET_MS even starts. searchUnion therefore spends what is LEFT of
// this budget, making the whole themed phase bounded by it however many times it
// runs.
//
// Deliberately well under api/submissions.js's PAGINATE_BUDGET_MS default: up to
// SEARCH_TERMS_CAP walks run concurrently inside one call, and this path can
// fire seconds before a challenge closes, where returning fewer candidates
// always beats missing the close. Page 1 is fetched regardless of the budget —
// getEligiblePhotos only tests it before fetching a SECOND page — so a term that
// fits in one page can never be cut short, and the floor below keeps a
// late-running resolved search from being handed a budget of zero.
const THEMED_SEARCH_BUDGET_MS = 8000;
const THEMED_SEARCH_MIN_BUDGET_MS = 1500;

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
 * @param {{getEligiblePhotos: function, logger: object, logLabel?: string,
 *   searchTagAutocomplete?: function, getCurrentMemberProfile?: function}} deps
 *   logLabel: the calling flow ('autoFill' default, or 'join') — used as the log
 *   category and message prefix so a join's messages aren't attributed to auto-fill.
 *   searchTagAutocomplete / getCurrentMemberProfile: OPTIONAL. Supplying both
 *   enables tag resolution on the miss path (see the retry below). Omit either
 *   and the function behaves exactly as it did before resolution existed, which
 *   is what keeps every existing caller and test valid.
 *   usage: 'submit' (default) or 'swap' — which server-side eligibility view the
 *   library reads (a swap replaces an entry instead of adding one).
 * @returns {Promise<Array<object>>}
 */
const fetchCandidatesForChallenge = async (
    challenge,
    token,
    tagOpts,
    {
        getEligiblePhotos,
        logger,
        logLabel = 'autoFill',
        searchTagAutocomplete,
        getCurrentMemberProfile,
        usage = 'submit',
    },
) => {
    const challengeId = challenge.id;
    // Only a swap asks the server for its own eligibility view; every existing
    // caller keeps the exact option shape it always sent (usage defaults to submit).
    const usageOpt = usage === 'swap' ? { usage } : {};
    const ignoreWords = (tagOpts && tagOpts.ignoreWords) || null;
    // buildSearchTerms reads the lexicon synchronously to tell a title's subject
    // from its mood word (see abstractTitleWords) and falls back to word order
    // when it is not loaded yet — so load it first, or the very first fill after
    // launch would search "fun" before "balloon". Every fill and join enters
    // here, so this one await covers the scoring that follows too. Never
    // rejects: an unavailable asset resolves false and ordering stays positional.
    await lexicon.isAvailable();
    const terms = buildSearchTerms(challenge, tagOpts);
    // A letter challenge ("Begins With L") yields no search terms on purpose —
    // the library is fetched unfiltered and narrowed client-side by the letter
    // tag filter in pickPhotosForChallenge. Leave a breadcrumb so a "wrong photo"
    // report is traceable to that path.
    const letter = detectLetterPrefix(challenge?.title);
    const negation = parseNegation(challenge?.title, ignoreWords);
    if (letter && terms.length === 0) {
        logger
            .withCategory(logLabel)
            .debug(
                `${logLabel}: letter challenge "${letter.toUpperCase()}" for ${logger.challengeTag(challenge)}; fetching full library for client-side tag filtering`,
                null,
            );
    } else if (terms.length === 0 && negation.active) {
        // "No Humans": the title only names what to leave OUT, so there is
        // nothing to search for — the library is fetched unfiltered and the
        // picker drops the photos showing the negated subject. Intended, so not a
        // warning; info still reaches a packaged build's log.
        logger
            .withCategory(logLabel)
            .info(
                `${logLabel}: ${logger.challengeTag(challenge)} only names what to leave out ` +
                    `(${negation.stems.join(', ')}); ranking your whole ` +
                    `library with photos showing it excluded`,
                null,
            );
    } else if (terms.length === 0) {
        // No searchable term at all: every word in the title was boilerplate or a
        // contest-cadence word ("Guru of The Week"). There is no theme to match,
        // so the whole library is ranked and the most popular eligible photo is
        // submitted. That is the best available answer rather than a failure —
        // but say so, because from the outside it looks identical to the bug
        // where a theme existed and was missed.
        logger
            .withCategory(logLabel)
            .warning(
                `${logLabel}: no searchable theme for ${logger.challengeTag(challenge)} — its title is all ` +
                    `boilerplate and no Must/Should Include Tag is usable; submitting your most popular ` +
                    `eligible photo instead`,
                null,
            );
    }
    // Shared deadline for the whole themed phase, so the raw-term searches and
    // the tag-resolver retry that may follow them split ONE budget instead of
    // each taking a full one (see THEMED_SEARCH_BUDGET_MS). Floored rather than
    // clamped to zero: a resolved search handed 0ms would stop after page 1 and
    // quietly reintroduce the truncation this change removes.
    const themedPhaseStartedAt = Date.now();
    const remainingThemedBudgetMs = () =>
        Math.max(THEMED_SEARCH_MIN_BUDGET_MS, THEMED_SEARCH_BUDGET_MS - (Date.now() - themedPhaseStartedAt));

    // One search per term, unioned by id. Extracted so the resolution retry
    // below runs the identical fetch/dedupe/fault-tolerance path rather than a
    // second copy of it.
    const searchUnion = async (searchTerms) => {
        // Run the per-term searches concurrently — they're independent reads and
        // serialising them would add a round-trip of latency per extra term to
        // the fill path (which can run close to a deadline). allSettled keeps the
        // per-term fault tolerance: one term erroring is logged and skipped, the
        // others still contribute, and the unfiltered fallback below still runs.
        const settled = await Promise.allSettled(
            // Paginated, but only where it costs something. getEligiblePhotos
            // stops a walk at the first SHORT page, so a term matching fewer
            // than one page of photos issues exactly ONE request — identical to
            // the single-page fetch this replaced. The walk only continues when
            // page 1 comes back FULL, which is precisely the case that used to
            // be truncated: the server orders by date desc, so a member with
            // more than a page of photos under the resolved tag had their older
            // work silently excluded from every themed fill, while the
            // UNFILTERED fallback below happily walked ten pages. The app was
            // searching harder when it had no theme than when it had one.
            //
            // Budgeted tighter than the fallback's own PAGINATE_BUDGET_MS: these
            // chains run concurrently on a path that can fire seconds before a
            // deadline, and a partial candidate set beats a missed close. The
            // logLabel is now needed — a walk can emit the library-walk warnings.
            searchTerms.map((term) =>
                getEligiblePhotos(challengeId, token, {
                    search: term,
                    paginate: true,
                    budgetMs: remainingThemedBudgetMs(),
                    logLabel,
                    ...usageOpt,
                }),
            ),
        );
        const byId = new Map();
        settled.forEach((result, i) => {
            if (result.status === 'rejected') {
                const reason = result.reason;
                logger
                    .withCategory(logLabel)
                    .debug(
                        `${logLabel}: search "${searchTerms[i]}" failed for ${logger.challengeTag(challenge)}: ${(reason && reason.message) || reason}`,
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
        return Array.from(byId.values());
    };
    const hasEligible = (list) => list.some((p) => p && p.permission && p.permission.allowed === true && p.id);

    if (terms.length > 0) {
        const union = await searchUnion(terms);
        if (hasEligible(union)) {
            return union;
        }

        // The exact-tag search found nothing. Before giving up on the theme
        // entirely, ask the member's own tag vocabulary what these terms are
        // actually called: get_photos_private matches a tag EXACTLY, so a
        // "Stairs" challenge searching "stair" misses a library full of
        // "staircase". search_autocomplete matches inside a tag and answers
        // "stair" -> ["staircase"], which the search CAN use.
        //
        // This is strictly a repair of the miss path — on the happy path above
        // we have already returned, so a fill that works today pays nothing.
        const resolved = await resolveTagsForTerms(terms, challenge, {
            token,
            searchTagAutocomplete,
            getCurrentMemberProfile,
            logger,
            logLabel,
            ignoreWords,
        });
        if (resolved.length > 0) {
            const resolvedUnion = await searchUnion(resolved);
            if (hasEligible(resolvedUnion)) {
                logger
                    .withCategory(logLabel)
                    .info(
                        `${logLabel}: resolved theme (${terms.join(', ')}) to library tag(s) ${resolved.map((t) => `"${t}"`).join(', ')} for ${logger.challengeTag(challenge)} — ${resolvedUnion.length} on-theme candidate(s)`,
                        null,
                    );
                return resolvedUnion;
            }
        }
        // Nothing matched the theme: the exact-tag search missed AND resolving
        // those terms against the member's own tag vocabulary produced nothing
        // usable. The fill is about to relax to the full library, where every
        // candidate ties at zero on theme and popularity alone decides — i.e.
        // an off-theme photo is about to be submitted.
        //
        // This warns rather than whispers. It used to debug-log the title case as
        // "routine", on the reasoning that abstract titles can't be matched and a
        // warning would cry wolf. Resolution changes that calculus: a concrete
        // subject now has a real chance of being found, so reaching here means
        // either the theme is genuinely unmatchable ("Guru of The Week") or the
        // library truly has nothing on it. Both are worth seeing, because the
        // alternative is the user watching an unrelated photo get submitted with
        // no explanation anywhere — which is exactly the report that prompted
        // this. The text names the terms so the two cases are distinguishable.
        //
        // buildSearchTerms with a null challenge yields ONLY the tag-derived terms
        // (its precedence is must -> should -> title), so an empty result proves the
        // terms above came from the title. Reusing it keeps the two in lockstep
        // rather than re-deriving the precedence rule here.
        const fromUserTags = buildSearchTerms(null, tagOpts).length > 0;
        // what happened -> why -> what next, once each. The searched terms are the
        // STEMMED forms ("stair" for a challenge titled "Stairs"), so say that
        // rather than letting it read like a typo of the user's own title.
        const next = fromUserTags
            ? 'Your Must/Should Include Tags matched none of your photos — widen or clear them to change this.'
            : 'Tag some of your photos to match this theme to change this.';
        logger
            .withCategory(logLabel)
            .warning(
                `${logLabel}: nothing on theme for ${logger.challengeTag(challenge)} — no photo is tagged ` +
                    `${terms.map((t) => `"${t}"`).join(' or ')} (matched as word stems) and no similar library tag ` +
                    `exists, so your most popular eligible photo will be submitted instead. ${next}`,
                null,
            );
    }
    // paginate: a single page is the 100 most recently uploaded eligible photos,
    // which silently excluded a user's older, strongest work from ever being a
    // candidate. The themed searches above now walk too (see searchUnion) — they
    // just stop after one request whenever a term fits in a page, which is the
    // common case — so this path is no longer the only one that can. It keeps the
    // full PAGINATE_BUDGET_MS default rather than the tighter themed budget: by
    // the time it runs the themed searches have already found nothing, and this
    // is the last chance to put ANY photo in the slot.
    return getEligiblePhotos(challengeId, token, { paginate: true, logLabel, ...usageOpt });
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
 * re-validation happens on read — and these helpers run for every challenge on
 * every voting pass, so a throw here would skip that challenge's remaining
 * actions on every pass for as long as the blob stays corrupted. Anything that
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
 * Mark an entry as boosted/turboed on the local challenge object after the apply
 * succeeded, so the *other* action running later in the same pass sees the conflict.
 *
 * Without this, `pickEntryAvoidingConflict` reads flags that are still whatever the
 * pass-start snapshot carried: turbo would apply to entry X, then boost — which runs later
 * under the default timer ordering — would still see `entries[X].turbo === false` and pick
 * the same entry. GuruShots allows one boost and one turbo per challenge but on *different*
 * entries, so the second action was silently wasted.
 *
 * @param {any} challenge
 * @param {string|number} imageId - entry the action was applied to
 * @param {'turbo'|'boosted'} field - conflict flag to raise
 */
const reflectEntryFlag = (challenge, imageId, field) => {
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries) || !imageId) return;
    const target = String(imageId);
    const entry = entries.find((candidate) => String(candidate?.id) === target);
    if (entry) entry[field] = true;
};

/**
 * Whether a re-fetched `member` has a shape every later consumer of the
 * challenge object can survive: the entries array (the merge guards), member.boost
 * (runBoost destructures it without a guard and reads .timeout), and
 * ranking.exposure (evaluateVotingDecision reads .exposure_factor off it
 * unguarded). A partial payload would otherwise crash the whole voting pass, not
 * just this challenge — stale beats crashed.
 */
const isAdoptableMember = (member) =>
    Boolean(member) &&
    typeof member === 'object' &&
    Array.isArray(member.ranking?.entries) &&
    member.ranking?.exposure != null &&
    Boolean(member.boost) &&
    typeof member.boost === 'object';

/**
 * Merge, don't blindly replace: entries reflected locally earlier this cycle
 * (reflectNewEntry after a fill-new submit) may not have propagated into
 * get_my_active_challenges yet — dropping them would resurrect the very
 * double-submit the refresh exists to prevent. Union by id only grows the entry
 * count, which errs toward fewer submits. An id-less prev entry (malformed) can't
 * be matched, so it is kept — again the fewer-submits direction. Mutates
 * `freshEntries`.
 */
const mergeLocalEntries = (prevEntries, freshEntries) => {
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
};

/**
 * Id → raised boost/turbo flags for every id-bearing entry that has either set.
 * @returns {Map<string, {turbo: boolean, boosted: boolean}>}
 */
const collectRaisedEntryFlags = (entries) => {
    const flags = new Map();
    for (const entry of entries) {
        if (!entry || entry.id == null) continue;
        if (entry.turbo || entry.boosted) {
            flags.set(String(entry.id), { turbo: !!entry.turbo, boosted: !!entry.boosted });
        }
    }
    return flags;
};

/**
 * Carry locally-raised boost/turbo flags across the member swap.
 *
 * Replacing `member` wholesale means an entry that IS in the fresh payload comes back
 * with the server's flags — and the server has not registered an apply from seconds ago,
 * so it reports turbo/boosted false. That would silently undo reflectEntryFlag: with the
 * default action order (turbo, then autoFill, then boost) a turbo applied earlier in the
 * pass would have its flag wiped by the refresh, and boost would then pick the very entry
 * turbo had just consumed. Only ever raise a flag, never clear one — if either side says an
 * entry is taken, treat it as taken. That errs toward using a different entry, which is the
 * safe direction: boost and turbo may both be spent, but never on the same entry. Mutates
 * `freshEntries`.
 */
const carryLocalEntryFlags = (prevEntries, freshEntries) => {
    const localFlags = collectRaisedEntryFlags(prevEntries);
    if (localFlags.size === 0) return;
    for (const entry of freshEntries) {
        const flags = entry && entry.id != null ? localFlags.get(String(entry.id)) : null;
        if (!flags) continue;
        if (flags.turbo) entry.turbo = true;
        if (flags.boosted) entry.boosted = true;
    }
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
    const member = fresh.member;
    if (!isAdoptableMember(member)) {
        staleWarning('malformed challenge payload');
        return 'unavailable';
    }
    // prevEntries is sliced because in mock mode `fresh` can be the identical
    // cached object, making prev and fresh the same array.
    const prevEntries = getEntries(challenge).slice();
    challenge.member = member;
    mergeLocalEntries(prevEntries, member.ranking.entries);
    carryLocalEntryFlags(prevEntries, member.ranking.entries);
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
    return ({ letterPrefix, mustStems, excludedStems }) => {
        const reasons = [];
        if (letterPrefix) {
            const letter = letterPrefix.toUpperCase();
            reasons.push(`letter challenge "${letter}" — no eligible photo has a label starting with "${letter}"`);
        }
        if (Array.isArray(mustStems) && mustStems.length > 0) {
            reasons.push('no photo matched every Must Include Tag');
        }
        if (Array.isArray(excludedStems) && excludedStems.length > 0) {
            reasons.push(`every eligible photo shows what the title excludes (${excludedStems.join(', ')})`);
        }
        // photoPicker only fires onFallback with at least one reason set (a
        // must-tag / letter filter, or a negated title's stems), so `why` is
        // never empty.
        const why = reasons.join('; ');
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
 * TWO CASES, and conflating them was a real bug. Popularity decides whenever
 * the theme tiers TIE — which happens both when nothing matched (every
 * candidate at zero) and when everything matched EQUALLY WELL. The second is
 * not a degenerate case: the fill resolves the challenge to one tag and
 * searches it server-side, so a fill's candidates routinely all carry that tag
 * and tie at the same high semantic bucket by construction (see the SUPPORT
 * note in services/semantic/index.js). Reporting that as "nothing matched the
 * challenge theme" told the user their fill had failed on exactly the fills
 * that worked, and advised a Per-Title Tag Rule to repair something that was
 * not broken. `themeMatched` below splits them.
 *
 * LEVEL follows the case. The off-theme line stays a WARNING: an off-theme
 * submission is genuinely surprising and is the ONLY trace a real user gets for
 * "why did it submit THAT photo?" on a title like "Your Legacy". The on-theme
 * tie is normal, healthy behavior and would be crying wolf as a warning, so it
 * goes out at INFO — which, unlike `debug`, carries no isSourceCode() gate in
 * logger.js and so still reaches a packaged build's log.
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

    // Every contested entry shares the boundary's theme tuple (that is what
    // selectEnrichmentSet selected them on), so one of them settles whether this
    // tie is "all matched equally" or "none matched at all". Sampled from
    // `explained` (non-empty past the early return above, and a subset of the
    // contested entries) so it is always defined: this function runs INSIDE the
    // try around submitToChallenge, where a TypeError would be misreported as
    // 'submit-threw' for a submission that had already succeeded.
    const sample = explained[0];
    // Predicate owned by photoPicker, which owns the tier list it reads. Stating
    // it by hand here would silently rot the day a tier is added or reordered —
    // and the regression would be exactly the bug this branch exists to fix.
    const themeMatched = hasThemeMatch(sample);
    const subject = explained.length === 1 ? 'the entry was' : `${explained.length} entries were`;
    const log = logger.withCategory('autoFill');

    if (themeMatched) {
        log.info(
            // Never "1 photos": selectEnrichmentSet returns [] for a group of one,
            // so the caller's `contested.length > 0` gate implies at least two.
            // Phrased "... for <tag>" like every other challengeTag site in this
            // file, rather than suffixing a possessive onto the tag — challengeTag
            // renders as "[Challenge 1: Stairs]", and "]'s theme" reads as a
            // garbled string before it reads as English.
            `${prefix}: ${contestedEntries.length} photos matched the theme equally well for ` +
                `${logger.challengeTag(challenge)}, so ${subject} chosen on past performance — ` +
                `${explained.map(describe).join('; ')}${coverage}.`,
            null,
        );
        return;
    }

    log.warning(
        `${prefix}: nothing in ${logger.challengeTag(challenge)} matched the challenge theme, so ` +
            `${subject} chosen on past performance — ` +
            `${explained.map(describe).join('; ')} ` +
            `out of ${contestedEntries.length} equally off-theme candidates${coverage}. ` +
            `Set a Per-Title Tag Rule for this challenge title in Settings to steer which photos qualify.`,
        null,
    );
};

/**
 * First half of the fill pipeline: fetch the candidate library for a challenge
 * and score it semantically. Shared by runFillAttempt and
 * rankCandidatesForChallenge so a swap ranks photos exactly the way a fill
 * does.
 *
 * @returns {Promise<{status: 'fetch-error', error: *} | {status: 'loaded', eligible: Array<object>, semanticScores: *, ignoreWords: *}>}
 */
const loadFillCandidates = async ({ label, challenge, token, deps, mustIncludeTags, shouldIncludeTags, usage }) => {
    const { logger, getEligiblePhotos, searchTagAutocomplete, getCurrentMemberProfile } = deps;
    // One lookup for the whole fill — see resolveIgnoreWords for why it is not
    // threaded in from each caller like the tag settings are.
    const ignoreWords = resolveIgnoreWords(deps.settings, challenge);

    let eligible;
    try {
        eligible = await fetchCandidatesForChallenge(
            challenge,
            token,
            { mustIncludeTags, shouldIncludeTags, ignoreWords },
            // Forward the tag-resolution pair. This call rebuilds a fresh deps
            // object rather than spreading `deps`, so anything not named here is
            // silently dropped — which is how resolution can look wired (the
            // orchestrator supplies it) while never reaching THIS path, the one
            // that does ordinary auto-fill, emergency fill and manual fill.
            { getEligiblePhotos, logger, searchTagAutocomplete, getCurrentMemberProfile, usage },
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
    const semanticScores = await resolveSemanticScores(challenge, eligible, { ...deps, ignoreWords });
    return { status: 'loaded', eligible, semanticScores, ignoreWords };
};

/**
 * Second half of the fill pipeline: build the scored candidate list and enrich
 * the contested ones with real stats. Returns the FULL scored pool —
 * finalizePick (which truncates to wantCount) is the caller's job.
 *
 * @returns {Promise<{scored: Array<object>, contested: Array<object>, contestedIds: Set<string>}>}
 */
const scoreFillCandidates = async ({
    label,
    challenge,
    token,
    deps,
    eligible,
    semanticScores,
    ignoreWords,
    wantCount,
    mustIncludeTags,
    shouldIncludeTags,
    fillWithoutTagMatch,
}) => {
    const { logger } = deps;
    const scored = buildScoredCandidates(challenge, eligible, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        semanticScores,
        ignoreWords,
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
                // enrichCandidates only marks statsKnown on entries whose three
                // fields it has already coerced to finite non-negative integers.
                entry.votes = fresh.votes;
                entry.views = fresh.views;
                entry.achievementCount = fresh.achievementCount;
            }
        }
    }
    return { scored, contested, contestedIds };
};

// Visual re-rank of the tag pick (see services/visionVerifier.js). The picked
// ids lead the shortlist so a model that abstains returns exactly them; the
// rest of the tag ranking follows as alternatives it may promote.
const verifyFillPick = async (challenge, scored, eligible, picked, ignoreWords, deps) => {
    const ranked = finalizePick(scored, Math.max(12, picked.length));
    const selected = new Set(picked.map(String));
    const preferred = [...picked, ...ranked.filter((id) => !selected.has(String(id)))];
    try {
        const rank = deps.rankVisually || rankVisually;
        const result = await rank(challenge, preferred, eligible, picked.length, { logger: deps.logger, ignoreWords });
        return Array.isArray(result) && result.length === picked.length ? result : picked;
    } catch (error) {
        deps.logger
            .withCategory('autoFill')
            .warning(`Visual check failed for ${deps.logger.challengeTag(challenge)}: ${error.message || error}`, null);
        return picked;
    }
};

/**
 * Ranks a challenge's candidate photos with the same pipeline a fill uses, but
 * submits nothing. Every id in `excludeIds` is removed BEFORE scoring and
 * enrichment — finalizePick truncates after sorting, so filtering afterwards
 * could discard every valid alternative when the top picks are excluded.
 *
 * @param {object} challenge
 * @param {string} token
 * @param {object} deps - same shape as the fill deps
 * @param {{label?: string, usage?: 'submit'|'swap', excludeIds?: Set<string>, wantCount?: number,
 *   mustIncludeTags?: string[]|null, shouldIncludeTags?: string[]|null, fillWithoutTagMatch?: *}} [opts]
 * @returns {Promise<{status: 'fetch-error', error: *} | {status: 'ranked', picked: Array<object>}>}
 *   picked: the top `wantCount` candidate photo records (with id + member_id), best first
 */
const rankCandidatesForChallenge = async (challenge, token, deps, opts = {}) => {
    const {
        label = 'rank',
        usage = 'submit',
        excludeIds = new Set(),
        wantCount = 1,
        mustIncludeTags = null,
        shouldIncludeTags = null,
        fillWithoutTagMatch = true,
    } = opts;
    const loaded = await loadFillCandidates({
        label,
        challenge,
        token,
        deps,
        mustIncludeTags,
        shouldIncludeTags,
        usage,
    });
    if (loaded.status === 'fetch-error') {
        return loaded;
    }
    const eligible = loaded.eligible.filter((photo) => photo && !excludeIds.has(String(photo.id)));
    const { scored } = await scoreFillCandidates({
        label,
        challenge,
        token,
        deps,
        eligible,
        semanticScores: loaded.semanticScores,
        ignoreWords: loaded.ignoreWords,
        wantCount,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
    });
    const byId = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const pickedIds = await verifyFillPick(
        challenge,
        scored,
        eligible,
        finalizePick(scored, wantCount),
        loaded.ignoreWords,
        deps,
    );
    const picked = pickedIds.map((id) => byId.get(String(id))).filter(Boolean);
    return { status: 'ranked', picked };
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
 *   probeStandDown?: (function({eligible: Array<object>, semanticScores: Map<string, {score: number, support: number}>|null}): boolean)|null,
 *   onEmptyPick?: (function(Array<object>): *)|null,
 *   onRefreshed?: (function(Array<string>): ({standDown?: boolean, picked?: Array<string>}|null))|null,
 * }} params
 * @returns {Promise<
 *   {status: 'fetch-error', error: *}
 *   | {status: 'probe-stand-down'}
 *   | {status: 'no-pick', detail: *}
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
    onRefreshed = null,
}) => {
    const { logger, submitToChallenge } = deps;
    const loaded = await loadFillCandidates({ label, challenge, token, deps, mustIncludeTags, shouldIncludeTags });
    if (loaded.status === 'fetch-error') {
        return loaded;
    }
    const { eligible, semanticScores, ignoreWords } = loaded;

    if (probeStandDown && probeStandDown({ eligible, semanticScores })) {
        return { status: 'probe-stand-down' };
    }

    // Everything below is submission-bound. The probe above deliberately runs
    // FIRST and on unenriched data: it decides only WHETHER to stand down, never
    // WHICH photo to submit, so it does not need real vote counts — and it runs
    // on every scheduler cycle inside the emergency window, usually to stand
    // down. Enriching before it would spend a burst of get_image_data requests
    // per cycle to submit nothing. Do not "fix" this asymmetry.
    const { scored, contested, contestedIds } = await scoreFillCandidates({
        label,
        challenge,
        token,
        deps,
        eligible,
        semanticScores,
        ignoreWords,
        wantCount,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
    });

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

    picked = await verifyFillPick(challenge, scored, eligible, picked, ignoreWords, deps);

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
        // Finite: the slotsRemaining > 0 guard above is false for a non-finite max.
        const max = challenge.max_photo_submits;
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
    // purpose: `debug` is compiled out of packaged builds (it is gated on
    // isSourceCode() in logger.js; `info`, `success` and `warning` are NOT),
    // and the remapped timing is exactly what a user checking "why did it fill
    // now?" needs to see. Attribute the TARGET's row (`desired + shift`
    // maps back to the original image number that set the current
    // target), not the entry number: during catch-up the entry being
    // submitted may sit on an off row and was never scheduled itself.
    // Safe to interpolate into the log line: the slotsRemaining > 0 guard at
    // the top already proved max_photo_submits is a finite number (a malformed
    // value — e.g. a string with newlines — returns 'skipped' there).
    const maxSubmits = challenge.max_photo_submits;
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
 * Whether emergency fill stands down on LIVE STATE alone, independent of timing.
 * Owned here, beside the runner that enforces it, and exported so the read-only
 * renderer view (VotingLogic.describeDeadlineActions, which drives the deadline
 * timeline and the desktop notifications) decides row visibility from the very
 * same code instead of a second copy that can silently drift.
 *
 * Covers the three state-only stand-downs maybeEmergencyFillChallenge takes
 * before any network call:
 *   - no challenge id (`undefined`/`null`, exactly the runner's own guard — an
 *     empty-string id is NOT one of them, so callers that normalise a missing id
 *     to '' must pass the raw id instead),
 *   - no free slot left to fill, and
 *   - "normal auto-fill already owns this challenge": auto-fill on with no
 *     must-include filter, the common configuration, in which the staggered
 *     path fills the slots and emergency fill has nothing to add.
 *
 * Deliberately NOT covered — the caller owns these:
 *   - the timing/enabled checks (`emergencyFill` seconds, close_time, whether
 *     `now` is inside the window), because the view expresses them as a
 *     threshold and a due instant rather than a boolean, and
 *   - the runner's final stand-down, a dry-run probe of whether the
 *     must-include filter would actually leave the slot empty. That needs the
 *     eligible-photo list over the network, so a read-only caller must treat
 *     "filter set" as "may fill" rather than "will fill".
 *
 * Returns the two settings it resolved alongside the verdict so the runner can
 * reuse them: every `getEffectiveSetting` is an uncached `readFileSync` +
 * merge + migrate (settings/storage.js readRaw), so re-reading them would add
 * real synchronous I/O to a path that runs seconds before a deadline. Nothing is
 * read until after the id and free-slot checks, keeping the stand-down paths
 * cheaper than a caller that resolved them up front. `settings` is a parameter
 * because this module takes the facade via `deps` while VotingLogic requires it
 * directly.
 *
 * @param {object} challenge
 * @param {string|number|null|undefined} challengeId raw id; do not normalise it
 * @param {{getEffectiveSetting: function, getEffectiveTagSetting: function}} settings
 * @returns {{standDown: boolean, autoFillEnabled: boolean, mustIncludeTags: unknown}}
 *   standDown true = would do nothing, so never advertise it as upcoming
 */
const evaluateEmergencyFill = (challenge, challengeId, settings) => {
    const inert = { standDown: true, autoFillEnabled: false, mustIncludeTags: null };
    if (challengeId === undefined || challengeId === null) return inert;
    if (getSlotsRemaining(challenge) <= 0) return inert;

    const mustIncludeTags = settings.getEffectiveTagSetting('mustIncludeTags', challenge);
    const autoFillEnabled = settings.getEffectiveSetting('autoFill', String(challengeId)) === true;
    const mustActive = Array.isArray(mustIncludeTags) && mustIncludeTags.length > 0;
    return { standDown: autoFillEnabled && !mustActive, autoFillEnabled, mustIncludeTags };
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

    // Stand down before any network call on the state-only conditions: no free
    // slot, and normal auto-fill already owning this challenge (auto-fill on
    // with no must-include filter — the common configuration, where the early
    // return avoids fetching eligible photos every cycle just to discard them).
    // Shared with the read-only timeline view so the two cannot drift; it hands
    // back the settings it resolved so nothing below re-reads them.
    const gate = evaluateEmergencyFill(challenge, challengeId, settings);
    if (gate.standDown) return 'skipped';
    const { autoFillEnabled, mustIncludeTags } = gate;

    let slotsRemaining = getSlotsRemaining(challenge);
    const shouldIncludeTags = settings.getEffectiveTagSetting('shouldIncludeTags', challenge);
    const fillWithoutTagMatch = settings.getEffectiveSetting('fillWithoutTagMatch', String(challengeId));

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
    if (attempt.status === 'no-pick') {
        return { ok: false, imageId: null, reason: 'no-eligible' };
    }
    if (attempt.status === 'gone') return { ok: false, imageId: null, reason: 'challenge-gone' };
    if (attempt.status === 'refresh-stand-down') return { ok: false, imageId: null, reason: 'no-slots' };
    if (attempt.status !== 'submitted') return { ok: false, imageId: null, reason: 'submit-failed' };

    // No reflectNewEntry here — on purpose. The orchestrator callers reflect
    // the returned id themselves (autoFill.reflectNewEntry(challenge,
    // filled.imageId) after a successful return); reflecting here too would
    // duplicate the entry. See runFillAttempt's header.
    //
    // Always a truthy id: buildScoredCandidates drops every photo without one
    // before scoring, so finalizePick can only return real ids — which matters
    // because applyBoostToEntry has no null-guard of its own.
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
    reflectEntryFlag,
    resolveScheduleTarget,
    getNextScheduleThresholdSec,
    // Shared with VotingLogic.describeDeadlineActions so the timeline/notify
    // view and this runner cannot drift on when emergency fill does nothing.
    evaluateEmergencyFill,
    // exported for tests
    getEffectiveScheduleRows,
    getSlotsRemaining,
    fetchCandidatesForChallenge,
    rankCandidatesForChallenge,
    resolveMemberId,
    __resetMemberIdCache,
    resolveSemanticScores,
    resolveIgnoreWords,
    describeSubmitFailure,
    refreshChallengeState,
};
