/**
 * Photo picker — the light stemmer every matcher shares. Kept free of imports
 * so both the tokeniser (stemming.ts) and the semantic lexicon
 * (semantic/lexicon.ts) can use it without an import cycle.
 */

// Bases that take '-es' rather than a bare '-s'. 'ss' is listed explicitly
// because a single trailing 's' is ambiguous — 'glass'+es vs 'hous'+e+s — and
// only the doubled form is reliably a sibilant base ('glasses'→'glass' while
// 'houses'→'house').
const SIBILANT_ES_RE = /(?:x|z|ch|sh|ss)$/;

/**
 * Light suffix stemmer covering the common inflected forms that show
 * up in challenge text vs. vision labels: plurals (flowers→flower),
 * gerunds (jumping→jump), past tense (jumped→jump), 'ies' nouns
 * (categories→category). Keeps the algorithm dependency-free; the residue it
 * leaves ('runn' from 'running') is absorbed by the bounded-prefix branch of
 * matches(), which is what the MAX_STEM_PREFIX_DELTA allowance exists for.
 *
 * SIBILANT RULE (see SIBILANT_ES_RE): '-es' is only a plural SUFFIX after a
 * sibilant — box→boxes, dish→dishes, church→churches, glass→glasses. A word
 * that already ends in '-e' just takes '-s' (face→faces, tree→trees,
 * lighthouse→lighthouses), so stripping a blanket two characters there ate a
 * real letter and produced a non-word: 'faces'→'fac', 'trees'→'tre',
 * 'lighthouses'→'lighthous'. That was not cosmetic. Those stems are what the
 * auto-fill search term and the semantic lexicon key are BOTH derived from, so
 * a "Lighthouses" challenge searched the exact tag 'lighthous' (no such tag —
 * zero candidates, fell back to the whole library) AND missed the lexicon,
 * which has 'lighthouse' but no 'lighthous'. Both failures disappear with the
 * correct stem.
 */
const stem = (word: string): string => {
    if (typeof word !== 'string' || word.length < 4) return word || '';
    const w = word;
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    // length > 4, not > 5: at 5 this rule was skipped entirely and the word fell
    // through to the '-es' branch, so "skies" stemmed to "ski" (and, once the
    // sibilant rule landed, "skie") — never "sky". A "Dramatic Skies" challenge
    // therefore could not match a "Sky" label at all. Every 5-letter '-ies' word
    // is a y-plural (skies, flies, cries, tries, spies); the '-ie' + s words that
    // this rule genuinely mis-stems (movies, cookies) are all 6+ and were already
    // mis-stemmed before, so widening to 5 adds no new failure.
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith('es')) {
        // Drop the whole '-es' only when what precedes it is a sibilant, i.e.
        // the base could not have taken a bare '-s'. Otherwise the base ends
        // in '-e' and only the '-s' is inflection. 'buses'→'buse' is the known
        // residue of not having a dictionary; the bounded-prefix branch of
        // matches() absorbs it exactly as it absorbs 'runn'.
        const base = w.slice(0, -2);
        return SIBILANT_ES_RE.test(base) ? base : w.slice(0, -1);
    }
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
};

export { stem };
