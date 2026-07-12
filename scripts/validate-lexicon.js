#!/usr/bin/env node

/**
 * Lexicon statistical gate.
 *
 * The semantic tier in photoPicker treats a cosine >= SEMANTIC_MATCH_FLOOR as
 * "this photo is on theme" and anything below it as no match at all. That
 * threshold is only meaningful if the lexicon actually separates related word
 * vectors from unrelated ones — and in a seeded pseudo-random vector space, it
 * might not. It didn't: the original config (48 dims, parentWeight 0.28) put
 * sibling similarity at ~0.12 against a noise standard deviation of ~0.144, so
 * genuinely related concepts scored BELOW the noise median and no threshold
 * could have worked. That is the bug this script exists to make impossible to
 * reintroduce.
 *
 * It rebuilds both distributions from the REAL committed asset, in the same
 * mean-pooled shape the matcher actually compares (a few challenge keywords vs a
 * photo's several labels — not bare concept-to-concept vectors, whose variance is
 * different), and asserts the floor sits in the gap between them:
 *
 *     p99.9(unrelated) < SEMANTIC_MATCH_FLOOR < p05(related)
 *
 * Fails non-zero if the gap closes. Run: `pnpm validate:lexicon` (and in CI).
 */

const path = require('node:path');
const lexicon = require('../src/js/services/semantic/lexicon');
const { SEMANTIC_MATCH_FLOOR } = require('../src/js/services/photoPicker');

const CONCEPTS = require(path.join(__dirname, 'lexicon-concepts.json')).concepts;

// A photo carries several labels; a challenge title yields one or two keywords.
// Mirror that, so the distributions describe what the matcher really compares.
const MAX_PHOTO_LABELS = 4;
const MAX_CHALLENGE_KEYWORDS = 2;

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const main = async () => {
    if (!(await lexicon.init())) {
        console.error('❌ lexicon asset unavailable — run `pnpm build:lexicon` first');
        process.exit(1);
    }

    const usable = CONCEPTS.filter((c) => Array.isArray(c.words) && c.words.length > 0 && c.parent);
    const related = [];
    const unrelated = [];

    for (const challenge of usable) {
        // Keywords come from the *front* of the cluster (the canonical name), which
        // is what a challenge title would actually say ("farm", not "homestead").
        const challengeVec = lexicon.embed(challenge.words.slice(0, MAX_CHALLENGE_KEYWORDS));
        if (!challengeVec) continue;

        for (const photo of usable) {
            // A photo's labels are its cluster's words, mean-pooled — a farm photo
            // labelled Cow/Barn/Pasture, not the single word "farm".
            const photoVec = lexicon.embed(photo.words.slice(0, MAX_PHOTO_LABELS));
            if (!photoVec) continue;

            const sim = lexicon.cosine(challengeVec, photoVec);
            if (!Number.isFinite(sim)) continue;

            // "Related" = same concept (synonyms) or same parent (siblings: a farm
            // challenge vs a livestock photo). Everything else must read as noise.
            if (challenge.id === photo.id || challenge.parent === photo.parent) related.push(sim);
            else unrelated.push(sim);
        }
    }

    related.sort((a, b) => a - b);
    unrelated.sort((a, b) => a - b);

    const floor = SEMANTIC_MATCH_FLOOR / 100;
    const unrelP999 = percentile(unrelated, 99.9);
    const unrelMax = unrelated[unrelated.length - 1];
    const relP05 = percentile(related, 5);
    const relMedian = percentile(related, 50);

    const fmt = (n) => n.toFixed(3);
    console.log(`Lexicon separation check (n_related=${related.length}, n_unrelated=${unrelated.length})`);
    console.log(`  unrelated  p99.9 = ${fmt(unrelP999)}   max = ${fmt(unrelMax)}`);
    console.log(`  related    p05   = ${fmt(relP05)}   median = ${fmt(relMedian)}`);
    console.log(`  SEMANTIC_MATCH_FLOOR = ${fmt(floor)}`);

    const failures = [];
    if (!(unrelP999 < floor)) {
        failures.push(
            `unrelated p99.9 (${fmt(unrelP999)}) >= floor (${fmt(floor)}) — noise would be scored as a theme match`,
        );
    }
    if (!(floor < relP05)) {
        failures.push(
            `floor (${fmt(floor)}) >= related p05 (${fmt(relP05)}) — genuinely on-theme photos would be discarded`,
        );
    }

    if (failures.length) {
        console.error('\n❌ Lexicon does not separate signal from noise at this floor:');
        for (const f of failures) console.error(`   - ${f}`);
        console.error(
            '\n   Fix by raising parentWeight and/or dims in scripts/lexicon-concepts.json\n' +
                '   (noise sd ~= 1/sqrt(dims); sibling cosine ~= pW^2/(cW^2 + pW^2)), then re-run\n' +
                '   `pnpm build:lexicon`. Do NOT just move SEMANTIC_MATCH_FLOOR to make this pass.',
        );
        process.exit(1);
    }

    console.log(`\n✅ Floor sits in the gap: ${fmt(unrelP999)} < ${fmt(floor)} < ${fmt(relP05)}`);
};

main();
