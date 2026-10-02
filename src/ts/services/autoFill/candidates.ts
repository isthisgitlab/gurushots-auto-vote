/**
 * Auto-fill — what a fill ranks: the on-theme eligible-photo fetch (server-side
 * search, tag-resolution retry, unfiltered fallback), the per-challenge
 * ignore-words lookup, and the semantic scores the picker ranks with.
 */

import { buildSearchTerms, detectLetterPrefix, parseNegation, readChallengeTheme } from '../photoPicker';
import { getSemanticScores } from '../semantic';
import * as lexicon from '../semantic/lexicon';
import { resolveTermsToTags } from '../tagResolver';
import { resolveMemberId } from './memberIdentity';

import type { Challenge } from '../../types/gurushots';
import type { ChallengeTheme, IgnoreWords, PickerPhoto, SemanticScore, TagOptions } from '../../types/photoPicker';
import type { FillLogger, FillSettings, RankDeps } from '../../types/autoFill';
import { errorMessage } from '../../errorMessage';

/**
 * Semantic match scores for an eligible set, computed once per fill and reused
 * across every picker call in that fill (the emergency path picks twice).
 * Always on: returns a Map<photoId, {score, support}> to merge into the picker
 * — best-label similarity plus how many labels are on theme — or null
 * when the lexicon is unavailable / the challenge has no usable theme text — in
 * which case ranking stays lexical. The scorer
 * (`deps.getSemanticScores`, defaulting to the real module) is injectable so
 * tests can stub it. Never throws.
 */
const resolveSemanticScores = async (
    challenge: Challenge,
    eligible: PickerPhoto[],
    deps: Pick<RankDeps, 'getSemanticScores'> & { ignoreWords?: IgnoreWords },
): Promise<Map<string, SemanticScore> | null> => {
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
 * @param settings - the settings facade from deps
 */
const resolveIgnoreWords = (settings: FillSettings | null | undefined, challenge: Challenge): Array<string> | null => {
    try {
        if (!settings || typeof settings.getEffectiveIgnoreTitleWords !== 'function') return null;
        return settings.getEffectiveIgnoreTitleWords(challenge);
    } catch {
        // A settings read must never fail a fill.
        return null;
    }
};

/**
 * Resolve challenge terms to real library tags, or [] when resolution is
 * unavailable for any reason (deps not injected, no identity, nothing on
 * theme). Never throws — the caller falls back exactly as it did before.
 */
const resolveTagsForTerms = async (
    terms: Array<string>,
    challenge: Challenge,
    opts: Pick<RankDeps, 'searchTagAutocomplete' | 'getCurrentMemberProfile'> & {
        token: string;
        logger: FillLogger;
        logLabel: string;
        ignoreWords?: IgnoreWords;
    },
): Promise<Array<string>> => {
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
            .debug(`${logLabel}: tag resolution unavailable: ${errorMessage(error) || error}`, null);
        return [];
    }
};

// Wall-clock budget for the THEMED PHASE of one candidate fetch — not for one
// searchUnion call. The distinction is load-bearing: fetchCandidatesForChallenge
// can run searchUnion for the raw terms, related concept tags, then the
// tag-resolver's output after misses. A per-call budget would silently stack
// before the unfiltered fallback's own PAGINATE_BUDGET_MS even starts.
// searchUnion therefore spends what is LEFT of
// this budget, making the whole themed phase bounded by it however many times it
// runs.
//
// Deliberately well under api/submissions.ts's PAGINATE_BUDGET_MS default: up to
// several tag searches run concurrently inside one call, and this path can
// fire seconds before a challenge closes, where returning fewer candidates
// always beats missing the close. Page 1 is fetched regardless of the budget —
// getEligiblePhotos only tests it before fetching a SECOND page — so a term that
// fits in one page can never be cut short, and the floor below keeps a
// late-running resolved search from being handed a budget of zero.
const THEMED_SEARCH_BUDGET_MS = 8000;
const THEMED_SEARCH_MIN_BUDGET_MS = 1500;

// Enough of a description to see how it states its theme — GuruShots'
// "The challenge is an open theme." is its third sentence on "10 Hours".
const MAX_LOGGED_DESCRIPTION_CHARS = 400;

/**
 * One line saying how the challenge's theme was read, with the text it was
 * read from. The app keeps no copy of challenge descriptions, so these lines
 * are what a misread theme can be checked (and the rule measured) against.
 */
const describeTheme = (theme: ChallengeTheme, challenge: Challenge): string => {
    const verdict =
        theme.kind === 'open'
            ? 'reads as an open theme, so its title and description are not matched against your photos'
            : theme.kind === 'subject'
              ? `has the subject ${theme.subjects.map((s) => `"${s}"`).join(', ')} (its description repeats it)`
              : 'has no subject its description confirms, so its title is searched head-noun first';
    const description = String(challenge.welcome_message ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_LOGGED_DESCRIPTION_CHARS);
    return `${verdict}. Description: "${description}"`;
};

/**
 * Fetch the eligible-photo candidates for a challenge, narrowed to its theme.
 *
 * Derives server-side `search` terms from the challenge (Must/Should Include
 * Tags, else the title) via buildSearchTerms and unions the per-term results
 * (deduped by id) so auto-fill prefers on-theme photos — the GuruShots search
 * index is far better than our client-side label matcher. When there are no
 * terms, every search comes back empty, or none of the matches are allowed,
 * fall back to the full unfiltered library so a slot still
 * gets filled. A single search term erroring is logged and skipped rather than
 * aborting the fill; the final unfiltered fetch lets its error propagate so the
 * caller's catch handles it.
 *
 * The returned set is fed unchanged into pickPhotosForChallenge, so the
 * must/should/fillWithoutTagMatch ranking semantics are preserved.
 *
 * @param challenge - challenge with id and (optional) title
 * @param deps
 *   logLabel: the calling flow ('autoFill' default, or 'join') — used as the log
 *   category and message prefix so a join's messages aren't attributed to auto-fill.
 *   searchTagAutocomplete / getCurrentMemberProfile: OPTIONAL. Supplying both
 *   enables tag resolution on the miss path (see the retry below). Omit either
 *   and the function behaves exactly as it did before resolution existed, which
 *   is what keeps every existing caller and test valid.
 *   usage: 'submit' (default) or 'swap' — which server-side eligibility view the
 *   library reads (a swap replaces an entry instead of adding one).
 */
const fetchCandidatesForChallenge = async (
    challenge: Challenge,
    token: string,
    tagOpts: TagOptions | null,
    {
        getEligiblePhotos,
        logger,
        logLabel = 'autoFill',
        searchTagAutocomplete,
        getCurrentMemberProfile,
        usage = 'submit',
    }: Pick<RankDeps, 'getEligiblePhotos' | 'searchTagAutocomplete' | 'getCurrentMemberProfile' | 'logger'> & {
        logLabel?: string;
        usage?: string;
    },
): Promise<PickerPhoto[]> => {
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
    }
    // Every fill and join reads the theme once here. Info, not debug, so the line
    // reaches a packaged build's log: an open theme ("10 Hours", "Guru of The
    // Week") submits your most popular eligible photo, which from the outside
    // looks identical to a theme that existed and was missed.
    const theme = readChallengeTheme(challenge, ignoreWords);
    logger
        .withCategory(logLabel)
        .info(`${logLabel}: ${logger.challengeTag(challenge)} ${describeTheme(theme, challenge)}`, null);
    // Shared deadline for the whole themed phase, so raw and related searches
    // and the tag-resolver retry that may follow them split ONE budget instead of
    // each taking a full one (see THEMED_SEARCH_BUDGET_MS). Floored rather than
    // clamped to zero: a resolved search handed 0ms would stop after page 1 and
    // quietly truncate the themed search to the most-voted page of photos.
    const themedPhaseStartedAt = Date.now();
    const remainingThemedBudgetMs = () =>
        Math.max(THEMED_SEARCH_MIN_BUDGET_MS, THEMED_SEARCH_BUDGET_MS - (Date.now() - themedPhaseStartedAt));

    // One search per term, unioned by id. A shared helper so the resolution retry
    // below runs the identical fetch/dedupe/fault-tolerance path rather than a
    // second copy of it.
    const searchUnion = async (searchTerms: string[]): Promise<PickerPhoto[]> => {
        // Run the per-term searches concurrently — they're independent reads and
        // serialising them would add a round-trip of latency per extra term to
        // the fill path (which can run close to a deadline). allSettled keeps the
        // per-term fault tolerance: one term erroring is logged and skipped, the
        // others still contribute, and the unfiltered fallback below still runs.
        const settled = await Promise.allSettled(
            // Paginated, but only where it costs something. getEligiblePhotos
            // stops a walk at the first SHORT page, so a term matching fewer
            // than one page of photos issues exactly ONE request. The walk only
            // continues when page 1 comes back FULL: the server orders by votes
            // desc, so a single page would silently exclude the less-voted work of a
            // member with more than a page of photos under the resolved tag from
            // every themed fill, while the UNFILTERED fallback below walks ten
            // pages — searching harder with no theme than with one.
            //
            // Budgeted tighter than the fallback's own PAGINATE_BUDGET_MS: these
            // chains run concurrently on a path that can fire seconds before a
            // deadline, and a partial candidate set beats a missed close. The
            // logLabel is passed because a walk can emit the library-walk warnings.
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
        const byId: Map<string, PickerPhoto> = new Map();
        settled.forEach((result, i) => {
            if (result.status === 'rejected') {
                const reason = result.reason as unknown;
                logger
                    .withCategory(logLabel)
                    .debug(
                        `${logLabel}: search "${searchTerms[i]}" failed for ${logger.challengeTag(challenge)}: ${errorMessage(reason) || reason}`,
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
    const hasEligible = (list: PickerPhoto[]) =>
        list.some((p) => p && p.permission && p.permission.allowed === true && p.id);

    if (terms.length > 0) {
        const fromUserTags = buildSearchTerms(null, tagOpts).length > 0;
        const union = await searchUnion(terms);
        const relatedUnion = await searchUnion(fromUserTags ? [] : lexicon.relatedSearchTerms(terms));
        if (hasEligible(union) || hasEligible(relatedUnion)) {
            return [...new Map([...union, ...relatedUnion].map((photo) => [photo.id, photo])).values()];
        }

        // Exact and related tag searches found nothing. Before giving up on the
        // theme entirely, ask the member's own vocabulary what these terms are
        // actually called: get_photos_private matches a tag EXACTLY, so a
        // "Stairs" challenge searching "stair" misses a library full of
        // "staircase". search_autocomplete matches inside a tag and answers
        // "stair" -> ["staircase"], which the search CAN use.
        //
        // This is strictly a repair of the miss path — title searches above
        // already included related concepts, but can still miss library-specific tags.
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
        // Server tag searches missed. The full library still gets semantic
        // ranking; popularity decides only when those scores tie.
        //
        // This warns rather than whispers. Abstract titles can't be matched, but
        // tag resolution gives a concrete subject a real chance of being found,
        // so reaching here means either the theme is genuinely unmatchable
        // ("Guru of The Week") or the library truly has nothing on it. Both are
        // worth seeing, because the alternative is the user watching an
        // unrelated photo get submitted with no explanation anywhere. The text
        // names the terms so the two cases are distinguishable.
        //
        // buildSearchTerms with a null challenge yields ONLY the tag-derived terms
        // (its precedence is must -> should -> title), so an empty result proves the
        // terms above came from the title. Reusing it keeps the two in lockstep
        // rather than re-deriving the precedence rule here.
        // what happened -> why -> what next, once each. The searched terms are the
        // STEMMED forms ("stair" for a challenge titled "Stairs"), so say that
        // rather than letting it read like a typo of the user's own title.
        const next = fromUserTags
            ? 'Your Must/Should Include Tags matched none of your photos — widen or clear them to change this.'
            : 'Review the selected photo; the existing labels did not identify a themed match.';
        logger
            .withCategory(logLabel)
            .warning(
                `${logLabel}: nothing found by tag search for ${logger.challengeTag(challenge)} — searches for ` +
                    `${terms.map((t) => `"${t}"`).join(' or ')} (matched as word stems) and related tags ` +
                    `returned no eligible photo, so the whole library will be ranked semantically; popularity breaks ties when nothing matches. ${next}`,
                null,
            );
    }
    // paginate: a single page is the 100 most recently uploaded eligible photos,
    // which would silently exclude a user's older, strongest work from ever being
    // a candidate. The themed searches above walk too (see searchUnion) — they
    // just stop after one request whenever a term fits in a page, which is the
    // common case. This path keeps the
    // full PAGINATE_BUDGET_MS default rather than the tighter themed budget: by
    // the time it runs the themed searches have already found nothing, and this
    // is the last chance to put ANY photo in the slot.
    const byVotes = await getEligiblePhotos(challengeId, token, { paginate: true, logLabel, ...usageOpt });
    if (hasEligible(byVotes)) return byVotes;
    return getEligiblePhotos(challengeId, token, { order: 'default', logLabel, ...usageOpt });
};

export { resolveSemanticScores, resolveIgnoreWords, fetchCandidatesForChallenge };
