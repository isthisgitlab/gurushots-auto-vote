/**
 * Semantic match scorer - the autofill picker's "meaning" signal.
 *
 * Given a challenge and the eligible photos, returns a Map<photoId, {score,
 * support}> of how close each photo's vision labels are to the challenge theme:
 * `score` is the BEST cosine similarity between the theme and any ONE of the
 * photo's labels (see POOLING below), `support` how many labels clear the match
 * floor (see SUPPORT below). The autofill paths always feed this into
 * pickPhotosForChallenge as extra ranking tiers so e.g. a "Feline Friends"
 * challenge ranks a `cat`-labelled photo on theme - something the substring
 * matcher scores at 0.
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
 *
 * SUPPORT: what the max throws away.
 *
 * A max says "some label means this" and nothing about the other labels. That
 * is the right headline signal and the table above is why - but it cannot tell
 * `[staircase, handrail, steps, architecture]` from `[staircase, dog, beach]`,
 * because both peak on the same label. That pair is not hypothetical: the fill
 * path resolves the challenge to ONE tag and searches it server-side, so a
 * fill's candidates routinely all carry the peaking label and tie here by
 * construction - after which only popularity separated them.
 *
 * So alongside the max, each photo carries `support`: how many of its labels
 * clear the SAME floor, capped at SEMANTIC_SUPPORT_CAP. It is a COUNT of
 * on-theme labels, never an average over all of them - averaging is the shape
 * that measured how generic a photo was, and nothing here reintroduces it. The
 * picker ranks it strictly below the max (see tier 3 in photoPicker.js), so it
 * only ever orders photos the max already agreed are on theme.
 *
 * The floor needs no re-derivation for this: the quantity being thresholded is
 * the same per-label similarity, pooled the same way, that the validator
 * already gates the build on. Counting how many labels clear a calibrated
 * threshold asks nothing new of the calibration.
 */

const lexicon = require('./lexicon');
const { buildThemeKeywords, labelStemGroups, SEMANTIC_MATCH_FLOOR, SEMANTIC_SUPPORT_CAP } = require('../photoPicker');

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Bucket to whole percent before comparing, exactly as photoPicker's semantic
// tier does with the headline score. Same quantity, same floor, same rounding -
// so a label that counts as on-theme here is one the picker would also call
// on-theme, with no half-percent disagreement at the boundary.
const clearsFloor = (sim) => Math.round(clamp01(sim) * 100) >= SEMANTIC_MATCH_FLOOR;

/**
 * Pool one photo's per-label similarities into the two quantities the picker
 * ranks on: the MAX across labels (the headline score) and the COUNT of labels
 * clearing the floor (its support). Both come off the same single pass.
 *
 * @param {Array<number>} challengeVec - the pooled theme vector
 * @param {Array<Array<string>>} groups - word stems, grouped per label
 * @param {function(Array<string>): (Array<number>|null)} embed
 * @returns {{score: number, support: number}|null} null when NO label was in
 *   vocabulary — no signal, which is distinct from a measured miss at 0.
 */
const poolLabels = (challengeVec, groups, embed) => {
    let best = null;
    let support = 0;
    for (const tokens of groups) {
        // Multi-word labels ("Sea Life") still mean-pool WITHIN the label — there
        // the words genuinely describe one thing. The max is across labels, which
        // is where the averaging was destroying signal.
        const labelVec = embed(tokens);
        if (!labelVec) continue;
        const sim = lexicon.cosine(challengeVec, labelVec);
        if (!Number.isFinite(sim)) continue;
        if (best === null || sim > best) best = sim;
        // The peaking label counts toward its own support, so an on-theme photo
        // always has support >= 1 and the count reads as "how many of this
        // photo's labels mean the theme".
        if (support < SEMANTIC_SUPPORT_CAP && clearsFloor(sim)) support++;
    }
    return best === null ? null : { score: clamp01(best), support };
};

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
 * @returns {Promise<Map<string, {score: number, support: number}>|null>}
 *   per-photo best-label similarity in 0..1 plus its count of on-theme labels
 *   (0..SEMANTIC_SUPPORT_CAP), or null when the lexicon is unavailable / the
 *   challenge has no usable theme text.
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
            const pooled = poolLabels(challengeVec, labelStemGroups(photo), embedCached);
            // Every label out of vocabulary -> no signal, same as before. That is
            // distinct from "scored 0", which is a measured miss.
            if (pooled) scores.set(String(id), pooled);
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
