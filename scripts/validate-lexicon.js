#!/usr/bin/env node

/**
 * Lexicon statistical gate.
 *
 * The semantic tier in photoPicker treats a cosine >= SEMANTIC_MATCH_FLOOR as
 * "this photo is on theme" and anything below it as no match at all. With real
 * pretrained embeddings the related and unrelated distributions genuinely
 * overlap (GloVe space is anisotropic and plenty of "different theme" word
 * pairs are legitimately correlated), so the bar this script enforces was
 * FIXED BEFORE the distributions were measured — the gate is a quality bar,
 * not a rubber stamp:
 *
 *     p99(unrelated) < FLOOR < p25(related)
 *
 * where the eval pairs come from scripts/lexicon-concepts.json:
 *   - related    = same concept (challenge words vs the cluster's REMAINING
 *                  words — disjoint slices, so shared tokens can't inflate the
 *                  distribution) or two clusters under the same parent.
 *   - unrelated  = concept pairs across the curated `unrelatedParents` list
 *                  ONLY. "Every cross-parent pair" is no longer an honest
 *                  noise model: real embeddings relate vehicle<->urban etc.
 *   - near-miss  = the `nearMissPairs` list — moderately-related-but-wrong-
 *                  theme cases (car vs street). Reported, NOT gated: the
 *                  production failure mode most worth watching is a plausible
 *                  neighbor outscoring a genuine lexical hit, so the report
 *                  prints how many near-misses the floor lets through.
 *
 * Everything is rebuilt from the REAL committed asset, in the same mean-pooled
 * shape the matcher actually compares (a couple of challenge keywords vs a
 * photo's several labels). Fails non-zero if the gate does not hold. Run:
 * `pnpm verify:lexicon` (and in CI, where the asset is rebuilt first so this
 * validates exactly what ships).
 *
 * Honesty caveat: same-concept pairs are boosted BY CONSTRUCTION — the fetch
 * step retrofits cluster members toward their centroid, so those pairs partly
 * measure the retrofit rather than raw GloVe. The independent signal in the
 * related distribution is the SIBLING pairs (different clusters, same parent),
 * which no retrofit step couples; that is why the gate uses p25 over the whole
 * related set rather than a same-concept-only statistic.
 *
 * If the gate fails, do NOT just move SEMANTIC_MATCH_FLOOR until it passes:
 *   1. read the printed distributions — is one eval pair dishonest (an
 *      `unrelatedParents` entry that real embeddings consider related, or a
 *      grab-bag parent missing from `organizationalParents`)?
 *   2. if the whole related distribution sits low, raise RETROFIT_BETA in
 *      scripts/fetch-embeddings.js (tightens the curated clusters) and
 *      regenerate — offline once the archive is cached. (MEAN_CENTER is
 *      already on; turning it OFF trades noise rejection for related-pair
 *      similarity and historically failed the farm-vs-sea case.)
 *   3. only then consider whether the floor itself is misplaced, and keep it
 *      inside the pre-committed percentile gate above.
 */

const path = require('node:path');
const lexicon = require('../src/js/services/semantic/lexicon');
const { SEMANTIC_MATCH_FLOOR } = require('../src/js/services/photoPicker');

const CONFIG = require(path.join(__dirname, 'lexicon-concepts.json'));

// A photo carries several labels; a challenge title yields one or two keywords.
// Mirror that, so the distributions describe what the matcher really compares.
const MAX_PHOTO_LABELS = 4;
const MAX_CHALLENGE_KEYWORDS = 2;

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

/**
 * Referential integrity of the eval config. A typo'd parent in
 * `unrelatedParents`/`organizationalParents` (or a concept id in
 * `nearMissPairs`) would not misbehave — it would silently match NOTHING,
 * quietly shrinking the very distribution the gate depends on. That is the one
 * failure mode reading the printed distributions cannot surface, so it is
 * checked structurally. Pure; returns error strings (empty = valid).
 *
 * @param {object} config - parsed lexicon-concepts.json
 * @returns {Array<string>}
 */
const validateConfigRefs = (config) => {
    const errors = [];
    const concepts = (config.concepts || []).filter((c) => c && c.id && c.parent);
    const ids = new Set(concepts.map((c) => c.id));
    const parents = new Set(concepts.map((c) => c.parent));
    for (const parent of config.organizationalParents || []) {
        if (!parents.has(parent)) errors.push(`organizationalParents references unknown parent "${parent}"`);
    }
    for (const pair of config.unrelatedParents || []) {
        for (const parent of pair) {
            if (!parents.has(parent)) errors.push(`unrelatedParents references unknown parent "${parent}"`);
        }
    }
    for (const pair of config.nearMissPairs || []) {
        for (const id of pair) {
            if (!ids.has(id)) errors.push(`nearMissPairs references unknown concept id "${id}"`);
        }
    }
    return errors;
};

const main = async () => {
    if (!(await lexicon.init())) {
        console.error('❌ lexicon asset unavailable — run `pnpm build:lexicon` first');
        process.exit(1);
    }

    const refErrors = validateConfigRefs(CONFIG);
    if (refErrors.length) {
        console.error(`❌ scripts/lexicon-concepts.json eval config is inconsistent:`);
        for (const e of refErrors) console.error(`   - ${e}`);
        process.exit(1);
    }

    const concepts = (CONFIG.concepts || []).filter((c) => Array.isArray(c.words) && c.words.length > 0 && c.parent);
    const byId = new Map(concepts.map((c) => [c.id, c]));
    // Parents whose grouping is organizational, not semantic (e.g. `object`:
    // umbrella vs book share nothing thematically). Their sibling pairs are
    // neither related nor noise, so they contribute only same-concept pairs.
    const organizational = new Set(CONFIG.organizationalParents || []);
    const unrelatedParentPairs = new Set();
    for (const [a, b] of CONFIG.unrelatedParents || []) {
        unrelatedParentPairs.add(`${a}|${b}`);
        unrelatedParentPairs.add(`${b}|${a}`);
    }

    // Keywords come from the *front* of the cluster (the canonical name), which
    // is what a challenge title would actually say ("farm", not "homestead").
    const challengeVecOf = (c) => lexicon.embed(c.words.slice(0, MAX_CHALLENGE_KEYWORDS));
    const photoVecOf = (c) => lexicon.embed(c.words.slice(0, MAX_PHOTO_LABELS));

    const related = [];
    const unrelated = [];

    for (const challenge of concepts) {
        const challengeVec = challengeVecOf(challenge);
        if (!challengeVec) continue;

        // Same concept, DISJOINT slices: the challenge says the cluster's
        // canonical words, the photo carries the cluster's other labels. Only
        // possible for clusters with spare words beyond the challenge slice.
        if (challenge.words.length > MAX_CHALLENGE_KEYWORDS) {
            const rest = challenge.words.slice(MAX_CHALLENGE_KEYWORDS, MAX_CHALLENGE_KEYWORDS + MAX_PHOTO_LABELS);
            const restVec = lexicon.embed(rest);
            if (restVec) {
                const sim = lexicon.cosine(challengeVec, restVec);
                if (Number.isFinite(sim)) related.push(sim);
            }
        }

        for (const photo of concepts) {
            if (photo.id === challenge.id) continue;
            const photoVec = photoVecOf(photo);
            if (!photoVec) continue;
            const sim = lexicon.cosine(challengeVec, photoVec);
            if (!Number.isFinite(sim)) continue;

            if (challenge.parent === photo.parent) {
                // Siblings: a farm challenge vs a livestock photo — must read
                // as related. Organizational parents are exempt (see above).
                if (!organizational.has(challenge.parent)) related.push(sim);
            } else if (unrelatedParentPairs.has(`${challenge.parent}|${photo.parent}`)) {
                // Curated distant parents — must read as noise.
                unrelated.push(sim);
            }
        }
    }

    related.sort((a, b) => a - b);
    unrelated.sort((a, b) => a - b);

    // An empty distribution means the gate would be comparing percentiles of
    // nothing (and percentile() would return undefined) — that is a broken
    // eval config, not a passing one.
    if (related.length === 0 || unrelated.length === 0) {
        console.error(
            `❌ eval distributions are empty (n_related=${related.length}, n_unrelated=${unrelated.length}) — ` +
                'the concepts/unrelatedParents config no longer produces comparable pairs.',
        );
        process.exit(1);
    }

    // Mirror the runtime boundary EXACTLY. photoPicker buckets a score with
    // Math.round(raw * 100) and matches on `bucket >= SEMANTIC_MATCH_FLOOR`, so
    // a raw cosine of FLOOR/100 - 0.005 already rounds up and counts as a
    // match. Gating on the nominal value would leave that band unguarded.
    const floor = (SEMANTIC_MATCH_FLOOR - 0.5) / 100;
    const unrelP99 = percentile(unrelated, 99);
    const unrelMax = unrelated[unrelated.length - 1];
    const relP25 = percentile(related, 25);
    const relP05 = percentile(related, 5);
    const relMedian = percentile(related, 50);

    const fmt = (n) => n.toFixed(3);
    console.log(`Lexicon separation check (n_related=${related.length}, n_unrelated=${unrelated.length})`);
    console.log(
        `  unrelated  p50 = ${fmt(percentile(unrelated, 50))}   p95 = ${fmt(percentile(unrelated, 95))}   ` +
            `p99 = ${fmt(unrelP99)}   max = ${fmt(unrelMax)}`,
    );
    console.log(
        `  related    p05 = ${fmt(relP05)}   p25 = ${fmt(relP25)}   median = ${fmt(relMedian)}   ` +
            `p95 = ${fmt(percentile(related, 95))}`,
    );
    console.log(`  SEMANTIC_MATCH_FLOOR = ${fmt(SEMANTIC_MATCH_FLOOR / 100)} (effective ${fmt(floor)} after rounding)`);

    // Near-misses: wrong theme, plausibly correlated. Not gated — but each one
    // the floor lets through is a photo the semantic tier would call on-theme
    // when it isn't, so surface them loudly.
    const nearMisses = [];
    for (const [aId, bId] of CONFIG.nearMissPairs || []) {
        const a = byId.get(aId);
        const b = byId.get(bId);
        if (!a || !b) {
            console.error(`❌ nearMissPairs references unknown concept id: ${aId} / ${bId}`);
            process.exit(1);
        }
        const sim = lexicon.cosine(challengeVecOf(a), photoVecOf(b));
        if (Number.isFinite(sim)) nearMisses.push({ pair: `${aId}<->${bId}`, sim });
    }
    if (nearMisses.length) {
        const above = nearMisses.filter((m) => m.sim >= floor);
        console.log(`  near-miss pairs (${nearMisses.length}; reported, not gated):`);
        for (const m of nearMisses) {
            console.log(`    ${m.sim >= floor ? '⚠️ ' : '   '}${m.pair} = ${fmt(m.sim)}`);
        }
        if (above.length) {
            console.log(
                `  ⚠️  ${above.length}/${nearMisses.length} near-miss pair(s) score above the floor — ` +
                    'these wrong-theme neighbors would count as semantic matches.',
            );
        }
    }

    const failures = [];
    if (!(unrelP99 < floor)) {
        failures.push(
            `unrelated p99 (${fmt(unrelP99)}) >= floor (${fmt(floor)}) — noise would be scored as a theme match`,
        );
    }
    if (!(floor < relP25)) {
        failures.push(
            `floor (${fmt(floor)}) >= related p25 (${fmt(relP25)}) — genuinely on-theme photos would be discarded`,
        );
    }

    if (failures.length) {
        console.error('\n❌ Lexicon does not separate signal from noise at this floor:');
        for (const f of failures) console.error(`   - ${f}`);
        console.error(
            '\n   Read the distributions above before touching anything. In order:\n' +
                '   1. audit scripts/lexicon-concepts.json — an `unrelatedParents` pair real embeddings\n' +
                '      consider related poisons the noise distribution, and a grab-bag parent missing from\n' +
                '      `organizationalParents` drags the related side down; fix the eval set, not the floor.\n' +
                '   2. if the WHOLE related distribution sits low, raise RETROFIT_BETA in\n' +
                '      scripts/fetch-embeddings.js and re-run fetch + build (offline once cached).\n' +
                '      MEAN_CENTER is already on — do not turn it off to inflate related scores.\n' +
                '   3. only then adjust SEMANTIC_MATCH_FLOOR (src/js/services/photoPicker.js), keeping it\n' +
                '      strictly inside p99(unrelated) < FLOOR < p25(related). Do NOT widen the gate itself.',
        );
        process.exit(1);
    }

    console.log(`\n✅ Floor sits in the gap: ${fmt(unrelP99)} < ${fmt(floor)} < ${fmt(relP25)}`);
};

module.exports = { percentile, validateConfigRefs };

if (require.main === module) main();
