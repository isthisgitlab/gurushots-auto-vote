/**
 * Semantic match scorer - the autofill picker's "meaning" signal.
 *
 * Given a challenge and the eligible photos, returns a Map<photoId, number in
 * 0..1> of how close each photo's vision labels are to the challenge theme,
 * measured as the BEST cosine similarity between the challenge theme and any
 * ONE of the photo's labels (see POOLING below). The
 * autofill paths always feed this into pickPhotosForChallenge as an extra
 * ranking tier so e.g. a "Feline Friends" challenge ranks a `cat`-labelled
 * photo on theme - something the substring matcher scores at 0.
 *
 * It uses the static word-vector lexicon shipped with the app, which runs
 * offline on every platform. Anything going wrong (asset missing, no theme
 * text, no in-vocabulary labels) resolves to null and the caller ranks
 * lexically, exactly as before - semantic matching never breaks a fill.
 *
 * POOLING: max over labels, NOT mean over the flattened stem bag.
 *
 * The bag was the original shape and it was wrong in both directions. A photo's
 * labels are an unordered set in which one or two entries carry the theme and
 * the rest are scene furniture ("Person", "Clothing", "Outdoors"); averaging
 * them lands near the corpus centroid, so the score measured how GENERIC a
 * photo was rather than how on-theme, and it got worse the more labels a photo
 * had. Measured against a real library on the live "Stairs" challenge:
 *
 *            on-theme median   off-theme median   AUC
 *   mean            0.394             0.159       0.9715
 *   max             0.939             0.273       1.0000
 *
 * Concretely, a genuine staircase photo scored 0.389 - under the floor, forced
 * to 0, no credit at all - while a yoga photo scored 0.583 and was promoted as
 * on theme. Max-pooling separates the same two at 0.939 vs 0.483.
 *
 * SEMANTIC_MATCH_FLOOR moves with this: it is calibrated per pooling shape by
 * scripts/validate-lexicon.js, which pools the same way this does. Changing the
 * pooling here without re-deriving the floor there would admit the tail of the
 * unrelated distribution - do not change one alone.
 */

const lexicon = require('./lexicon');
const { buildThemeKeywords, labelStemGroups } = require('../photoPicker');

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
const getSemanticScores = async (challenge, photos, ignoreWords = null) => {
    try {
        if (!Array.isArray(photos) || photos.length === 0) return null;
        if (!(await lexicon.isAvailable())) return null;

        // Subject words only — a welcome_message would dilute the pooled theme
        // vector off its own subject (see buildThemeKeywords).
        const keywords = buildThemeKeywords(challenge, ignoreWords);
        if (!keywords || keywords.length === 0) return null;
        const challengeVec = embedCached(keywords);
        if (!challengeVec) return null;

        const scores = new Map();
        for (const photo of photos) {
            const id = photo && photo.id;
            if (id === undefined || id === null) continue;
            // Word stems per label, not raw labels and not one flat bag. The
            // lexicon is a word vocabulary with no multi-word keys, so handing it
            // "Sea Life" verbatim is always a miss; labelStemGroups splits and
            // stems each label while keeping them separate, which is what lets
            // the max below be taken over labels rather than words.
            const groups = labelStemGroups(photo);
            if (groups.length === 0) continue;
            let best = null;
            for (const tokens of groups) {
                // Multi-word labels ("Sea Life") still mean-pool WITHIN the label —
                // there the words genuinely describe one thing. The max is across
                // labels, which is where the averaging was destroying signal.
                const labelVec = embedCached(tokens);
                if (!labelVec) continue;
                const sim = lexicon.cosine(challengeVec, labelVec);
                if (Number.isFinite(sim) && (best === null || sim > best)) best = sim;
            }
            // Every label out of vocabulary -> no signal, same as before. That is
            // distinct from "scored 0", which is a measured miss.
            if (best !== null) scores.set(String(id), Math.max(0, Math.min(1, best)));
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
