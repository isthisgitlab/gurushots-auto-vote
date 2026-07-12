/**
 * Semantic match scorer - the autofill picker's "meaning" signal.
 *
 * Given a challenge and the eligible photos, returns a Map<photoId, number in
 * 0..1> of how close each photo's vision labels are to the challenge theme,
 * measured as cosine similarity between mean-pooled word-vector embeddings. The
 * autofill paths always feed this into pickPhotosForChallenge as an extra
 * ranking tier so e.g. a "Feline Friends" challenge ranks a `cat`-labelled
 * photo on theme - something the substring matcher scores at 0.
 *
 * It uses the static word-vector lexicon shipped with the app, which runs
 * offline on every platform. Anything going wrong (asset missing, no theme
 * text, no in-vocabulary labels) resolves to null and the caller ranks
 * lexically, exactly as before - semantic matching never breaks a fill.
 */

const lexicon = require('./lexicon');
const { buildChallengeKeywords, labelWordStems } = require('../photoPicker');

// Small bounded cache of label/keyword embeddings. Photo label sets and
// challenge themes repeat across fill cycles, so this keeps scoring near-free.
// Cleared wholesale on overflow - a coarse bound is enough.
const MAX_CACHE = 4000;
const vecCache = new Map();

const embedCached = (tokens) => {
    // Sorted JSON key: mean-pooling is order-independent, so token order must
    // not split the cache; the array form also avoids cross-token collisions
    // (e.g. ['ca','t'] vs ['c','at']).
    const key = JSON.stringify([...tokens].sort());
    if (vecCache.has(key)) return vecCache.get(key);
    const vec = lexicon.embed(tokens) || null;
    if (vecCache.size >= MAX_CACHE) vecCache.clear();
    vecCache.set(key, vec);
    return vec;
};

/**
 * @param {object} challenge - challenge object (url/title/welcome_message used)
 * @param {Array<object>} photos - eligible candidates with `id` and `labels`
 * @returns {Promise<Map<string, number>|null>} per-photo score in 0..1, or null
 *   when the lexicon is unavailable / the challenge has no usable theme text.
 */
const getSemanticScores = async (challenge, photos) => {
    try {
        if (!Array.isArray(photos) || photos.length === 0) return null;
        if (!(await lexicon.isAvailable())) return null;

        const keywords = buildChallengeKeywords(challenge);
        if (!keywords || keywords.length === 0) return null;
        const challengeVec = embedCached(keywords);
        if (!challengeVec) return null;

        const scores = new Map();
        for (const photo of photos) {
            const id = photo && photo.id;
            if (id === undefined || id === null) continue;
            // Word stems, not raw labels. The lexicon is a word vocabulary with no
            // multi-word keys, so handing it the label "Sea Life" verbatim is
            // always a miss — every multi-word vision label was invisible to the
            // semantic tier. labelWordStems splits and stems them (and bounds the
            // fan-out, which also bounds the vecCache key size below).
            const tokens = labelWordStems(photo);
            if (tokens.length === 0) continue;
            const photoVec = embedCached(tokens);
            if (!photoVec) continue;
            const sim = lexicon.cosine(challengeVec, photoVec);
            if (Number.isFinite(sim)) scores.set(String(id), Math.max(0, Math.min(1, sim)));
        }
        return scores.size > 0 ? scores : null;
    } catch {
        return null;
    }
};

// Test-only: clear the embedding cache between cases.
const __resetForTests = () => {
    vecCache.clear();
};

module.exports = { getSemanticScores, __resetForTests };
