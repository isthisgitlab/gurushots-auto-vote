#!/usr/bin/env node

/**
 * GloVe embedding fetcher — the ONLY network-touching step of the lexicon
 * pipeline. Run manually via `pnpm fetch:embeddings` after editing
 * scripts/lexicon-concepts.json; everything downstream (build:lexicon,
 * verify:lexicon, CI) is offline and deterministic given the committed
 * intermediate this script writes.
 *
 * What it does:
 *   1. Downloads (or reuses from scripts/.cache/) the pinned GloVe 6B archive
 *      and streams out the single glove.6B.100d.txt entry — no entry paths are
 *      ever written to disk (zip-slip impossible), inflated size is capped
 *      (decompression-bomb guard), and the entry's bytes are SHA-256-verified
 *      against a hard-coded pin before any output is written.
 *   2. Selects the vocabulary: the top TOP_N frequency-ranked tokens that pass
 *      the [a-z]{2,20} filter, PLUS every word from lexicon-concepts.json
 *      (concepts + extraWords), looked up in the full 400k vocabulary. An
 *      authored word with no GloVe vector at all is a FATAL error — the vocab
 *      guarantee is enforced here, not assumed.
 *   3. Mean-centers (anisotropy correction), normalizes, and retrofits each
 *      authored word toward its cluster centroid (Faruqui et al. 2015) so the
 *      curated "is a kind of" knowledge the distributional vectors under-
 *      represent (sunflower<->flower) is injected into the shipped table.
 *   4. Maps words to stems with the matcher's own stemmer. Collision policy:
 *      authored words always beat generic tokens; generic-vs-generic keeps the
 *      more frequent word; authored-vs-authored across clusters is fatal (an
 *      authoring mistake). Merges whose two vectors disagree (cosine below
 *      BAD_COLLISION_COSINE — i.e. NOT inflections of one lemma) are counted
 *      and gated by a sanity ceiling so a stemmer regression at 10k-word scale
 *      fails loudly.
 *   5. int8-quantizes with one global scale and writes the packed base64
 *      intermediate scripts/lexicon-embeddings.json with full provenance
 *      (URL, zip + entry SHA-256, retrieval date, license).
 *
 * GloVe 6B (Wikipedia 2014 + Gigaword 5) is released under the PDDL — see
 * https://nlp.stanford.edu/projects/glove/ (Pennington, Socher, Manning 2014).
 *
 * This file is the entry point and facade; the work lives in fetch-embeddings/:
 *   - config    pinned URL, SHA-256 pins, size limits, output paths, tuning
 *   - archive   https-only download and single-entry zip streaming
 *   - vectors   parsing, vocabulary selection, normalize/retrofit/quantize
 *   - pipeline  `main`/`run`, the orchestration
 *   - support   fatal-exit and SHA-256 helpers
 */

import { runIfMain } from './lib/run-if-main';
import { run } from './fetch-embeddings/pipeline';

export { GENERIC_TOKEN_RE, ENTRY_NAME } from './fetch-embeddings/config';
export { sha256OfString, sha256OfFile } from './fetch-embeddings/support';
export {
    collectAuthoredWords,
    parseGloveLine,
    normalize,
    retrofit,
    assignStems,
    quantizePack,
} from './fetch-embeddings/vectors';
export { streamEntryLines, fetchHttpsOnly, download } from './fetch-embeddings/archive';
export { main, run } from './fetch-embeddings/pipeline';
export type { MainOptions } from './fetch-embeddings/pipeline';

runIfMain(require.main, module, run);
