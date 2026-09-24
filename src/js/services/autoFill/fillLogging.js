/**
 * Auto-fill — the user-facing explanations of a fill: why a submit was
 * rejected, why a hard filter relaxed to the full library, and why popularity
 * rather than the theme decided a pick.
 */

const { hasThemeMatch } = require('../photoPicker');
const { oneLine } = require('../../format/logSafe');

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
            // Phrased "... for <tag>" like every other challengeTag site in the
            // auto-fill modules, rather than suffixing a possessive onto the tag — challengeTag
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

module.exports = {
    describeSubmitFailure,
    makeFallbackLogger,
    logPopularityPick,
};
