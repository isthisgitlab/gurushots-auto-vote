/**
 * GuruShots Auto Voter - Photo Picker
 *
 * Pure ranking function used by the auto-fill flow to choose which of
 * the user's eligible photos to submit into a challenge.
 *
 * Ranking strategy (lexicographic, all desc):
 *   1. Tag-match score — how well photo labels overlap challenge keywords
 *      (URL slug + title + welcome_message, light-stemmed, with a
 *      photography-noise stopword list).
 *   2. Achievements count — past wins are a strong quality signal when
 *      we have no theme match to bias us.
 *   3. Votes — total votes on the photo across all prior challenges.
 *   4. Upload date — last-resort tiebreak.
 *
 * The achievements/votes layers are why this avoids the "picked my last
 * upload" failure mode: when a challenge theme can't be matched against
 * any of the user's photos (very common — vision labels are concrete
 * nouns; challenge titles are abstract), fall back to "best historical
 * performer" instead of "newest", which has zero quality signal.
 */

const STOPWORDS = new Set([
    // Articles, prepositions, conjunctions, copulas
    'in', 'of', 'the', 'a', 'an', 'and', 'or', 'with', 'on', 'for',
    'to', 'at', 'from', 'by', 'about', 'as', 'if', 'so', 'no', 'not',
    'is', 'it', 'this', 'that', 'these', 'those',
    // Pronouns
    'my', 'me', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your',
    'yours', 'he', 'she', 'they', 'them', 'their',
    // Auxiliary verbs
    'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can',
    // Quantifiers
    'all', 'any', 'some', 'more', 'most', 'less', 'few', 'many', 'much',
    // Photography / GuruShots vocabulary that doesn't help match labels
    'shots', 'shot', 'photo', 'photos', 'photography', 'photographer',
    'image', 'images', 'picture', 'pictures', 'pic', 'pics',
    'gurushots', 'challenge', 'challenges', 'contest', 'contests',
    // Reward / level copy from welcome messages
    'reward', 'rewards', 'prize', 'prizes', 'win', 'wins', 'winner',
    'winners', 'level', 'levels', 'badge', 'badges', 'point', 'points',
    'coin', 'coins', 'allstar', 'elite', 'premier', 'popular',
    'skilled', 'guru', 'gurus', 'earn', 'earns', 'earned', 'earning',
    'participation', 'participate',
    // Welcome-message boilerplate verbs
    'capture', 'captured', 'capturing', 'submit', 'submitted',
    'submission', 'enter', 'entered', 'entering', 'entry', 'entries',
    'join', 'joined', 'joining',
    // Welcome-message boilerplate adjectives / fillers
    'good', 'luck', 'great', 'best', 'better', 'nice',
]);

const isPureDigit = (token) => /^\d+$/.test(token);

/**
 * Light suffix stemmer covering the common inflected forms that show
 * up in challenge text vs. vision labels: plurals (flowers→flower),
 * gerunds (jumping→jump), past tense (jumped→jump), 'ies' nouns
 * (categories→category). Keeps the algorithm dependency-free; pairs
 * with bidirectional substring matching to handle leftover variation
 * like 'runn' (from running) vs 'run'.
 */
const stem = (word) => {
    if (typeof word !== 'string' || word.length < 4) return word || '';
    const w = word;
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
};

const tokenise = (text) => {
    if (typeof text !== 'string' || text.length === 0) return [];
    return text
        .toLowerCase()
        .replace(/<[^>]*>/g, ' ')
        .split(/[^a-z0-9]+/)
        .map((t) => t.replace(/\d+$/, ''))
        .filter((t) => t.length > 1 && !isPureDigit(t) && !STOPWORDS.has(t))
        .map(stem);
};

const buildChallengeKeywords = (challenge) => {
    const fromUrl = tokenise(challenge?.url);
    const fromTitle = tokenise(challenge?.title);
    const fromWelcome = tokenise(challenge?.welcome_message);
    const all = [...fromUrl, ...fromTitle, ...fromWelcome];
    return Array.from(new Set(all));
};

const matches = (labelStem, keywordStem) => (
    labelStem === keywordStem
    || labelStem.includes(keywordStem)
    || keywordStem.includes(labelStem)
);

const scorePhoto = (photo, keywords) => {
    if (keywords.length === 0) return 0;
    if (!Array.isArray(photo.labels) || photo.labels.length === 0) return 0;
    const labelStems = photo.labels.map((l) => stem(String(l).toLowerCase()));
    let score = 0;
    for (const labelStem of labelStems) {
        if (!labelStem) continue;
        for (const keywordStem of keywords) {
            if (matches(labelStem, keywordStem)) {
                score++;
                break;
            }
        }
    }
    return score;
};

const achievementCountOf = (photo) => (
    Array.isArray(photo.achievements) ? photo.achievements.length : 0
);

const votesOf = (photo) => (
    Number.isFinite(photo.votes) ? photo.votes : 0
);

const uploadDateOf = (photo) => (
    Number.isFinite(photo.upload_date) ? photo.upload_date : 0
);

/**
 * Picks photos to submit to a challenge.
 *
 * @param {object} challenge - challenge object (url, title, welcome_message all optional)
 * @param {Array<object>} eligiblePhotos - candidates from getEligiblePhotos
 * @param {number} slotsToFill - how many photos to return at most
 * @returns {Array<string>} ordered list of photo ids; length <= slotsToFill
 */
const pickPhotosForChallenge = (challenge, eligiblePhotos, slotsToFill) => {
    if (!Number.isInteger(slotsToFill) || slotsToFill <= 0) return [];
    if (!Array.isArray(eligiblePhotos) || eligiblePhotos.length === 0) return [];

    const allowed = eligiblePhotos.filter((p) => p && p.permission && p.permission.allowed === true && p.id);
    if (allowed.length === 0) return [];

    const keywords = buildChallengeKeywords(challenge);
    const scored = allowed.map((photo) => ({
        id: photo.id,
        score: scorePhoto(photo, keywords),
        achievementCount: achievementCountOf(photo),
        votes: votesOf(photo),
        uploadDate: uploadDateOf(photo),
    }));

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.achievementCount !== a.achievementCount) return b.achievementCount - a.achievementCount;
        if (b.votes !== a.votes) return b.votes - a.votes;
        return b.uploadDate - a.uploadDate;
    });

    return scored.slice(0, slotsToFill).map((p) => p.id);
};

module.exports = {
    pickPhotosForChallenge,
    // exported for unit tests
    tokenise,
    stem,
    buildChallengeKeywords,
    scorePhoto,
    STOPWORDS,
};
