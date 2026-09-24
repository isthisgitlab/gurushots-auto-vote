/**
 * Process-local cache of the latest active-challenge list: id -> title and
 * id -> match facts (tags, type, photo count, start/close time). Sole owner of
 * that mutable state; lets an id-only caller resolve a challenge rule keyed on
 * any of those facts.
 */

const { MAX_TITLE_RULES, MAX_TITLE_LENGTH } = require('./titleRuleSanitize');

// Current id→title observations are process-local. Real API responses also
// persist first-seen title pins, but this cache is what lets the same resolver
// work in mock mode without writing mock ids into the user's real settings.
// Replacing the whole map on each successful fetch also drops stale ids.
let activeChallengeTitles = new Map();

// Parallel id -> match-facts cache (tags, type, photo count, start/close time),
// refreshed by the same function, so a rule keyed on any of them resolves for
// id-only callers too. Defensive per-challenge tag cap: real lists carry a
// handful of tags (the live vocabulary is Exhibition / Comm / No comm / Turbo /
// Magazine / "special N pic" / "N photos").
const MAX_CHALLENGE_TAGS = 24;
let activeChallengeFacts = new Map();

const _finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// The usable title of one observation, or null for an unusable/over-length one.
// The explicit miss keeps a truncated stored pin from being used as an
// apparently exact fallback.
const _observedTitle = (challenge) => {
    const title = typeof challenge?.title === 'string' ? challenge.title.trim() : '';
    return title && title.length <= MAX_TITLE_LENGTH ? title : null;
};

// The bounded match facts of one observation. The per-challenge tag list is
// bounded the same way titles are: an anomalous payload must not park an
// unbounded array in memory.
const _observedFacts = (challenge) => {
    const type = typeof challenge?.type === 'string' ? challenge.type.trim() : '';
    return {
        tags: (Array.isArray(challenge?.tags) ? challenge.tags : [])
            .slice(0, MAX_CHALLENGE_TAGS)
            .filter((tag) => typeof tag === 'string' && tag.trim() !== '' && tag.length <= MAX_TITLE_LENGTH)
            .map((tag) => tag.trim()),
        type: type.length <= MAX_TITLE_LENGTH ? type : '',
        max_photo_submits: _finiteOrNull(challenge?.max_photo_submits),
        start_time: _finiteOrNull(challenge?.start_time),
        close_time: _finiteOrNull(challenge?.close_time),
    };
};

/**
 * Remember the titles AND match facts from the latest successful
 * active-challenge response. The input is API-owned/untrusted, so only bounded
 * scalar ids/titles/tags/numbers enter the cache and the first row for a
 * duplicate id wins.
 *
 * Facts live here rather than in the persisted `titlePins` blob on purpose: a
 * pin exists to defeat a server-side RENAME mid-challenge, while facts are only
 * needed to resolve a rule for a challenge in the current list. An in-memory
 * map costs no settings-file growth and cannot go stale across restarts.
 */
const rememberChallengeTitles = (challenges) => {
    if (!Array.isArray(challenges)) return false;
    const next = new Map();
    const nextFacts = new Map();
    for (const challenge of challenges.slice(0, MAX_TITLE_RULES)) {
        if (challenge?.id === null || challenge?.id === undefined) continue;
        const id = String(challenge.id);
        if (!id || next.has(id)) continue;
        next.set(id, _observedTitle(challenge));
        nextFacts.set(id, _observedFacts(challenge));
    }
    activeChallengeTitles = next;
    activeChallengeFacts = nextFacts;
    return true;
};

const _challengeIdKey = (challengeId) => (challengeId === null || challengeId === undefined ? '' : String(challengeId));

/** The remembered match facts for an id, or an empty-tags object when unknown. */
const factsForChallengeId = (challengeId) => {
    const id = _challengeIdKey(challengeId);
    return (id && activeChallengeFacts.get(id)) || { tags: [] };
};

const _titleForChallengeId = (settings, challengeId) => {
    const id = _challengeIdKey(challengeId);
    if (!id) return '';
    if (activeChallengeTitles.has(id)) return activeChallengeTitles.get(id) || '';
    const pinned = settings.challengeSettings?.titlePins;
    return pinned &&
        Object.prototype.hasOwnProperty.call(pinned, id) &&
        typeof pinned[id] === 'string' &&
        pinned[id].length < MAX_TITLE_LENGTH
        ? pinned[id]
        : '';
};

/** The rule-match target for an id-only caller: its title plus remembered facts. */
const challengeTargetForId = (settings, challengeId) => ({
    ...factsForChallengeId(challengeId),
    title: _titleForChallengeId(settings, challengeId),
});

module.exports = {
    rememberChallengeTitles,
    factsForChallengeId,
    challengeTargetForId,
};
