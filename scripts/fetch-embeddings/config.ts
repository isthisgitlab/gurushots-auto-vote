/** Pinned GloVe source, integrity limits, output paths and pipeline tuning constants. */

import path from 'node:path';

export const GLOVE_URL = 'https://nlp.stanford.edu/data/glove.6B.zip';
// SHA-256 of the whole archive as served by the pinned URL. The entry hash
// below is the actual trust anchor for the data used; this outer pin just
// catches a swapped/truncated download one step earlier.
export const ZIP_SHA256 = '617afb2fe6cbd085c235baf7a465b96f4112bd7f7ccb2b2cbd649fed9cbcf2fb';
export const ENTRY_NAME = 'glove.6B.100d.txt';
// SHA-256 of the extracted glove.6B.100d.txt — the exact bytes this pipeline
// consumes. Verified on every run, cached or fresh; a mismatch aborts before
// anything is written. (Matches the independently published hash of the file,
// e.g. github.com/tsajed/data.)
export const ENTRY_SHA256 = '95dde4dfd627ab26608d33e76d1195ec059734bd29089ea52cadb08d07c64544';
// Refuse to write more than this to the cache — a swapped/looping source
// should fail fast, not fill the disk. The real archive is ~822 MB.
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
// The pinned URL 301s to downloads.cs.stanford.edu; a longer chain than this
// is not the host we pinned.
export const MAX_REDIRECTS = 5;
export const DIMS = 100;
// Top-N frequency-ranked generic tokens (counted AFTER the filter below, so the
// stored generic vocab really is ~TOP_N stems, not "top lines minus rejects").
export const TOP_N = 40000;
// Center against a stable core so vocabulary growth does not shift the scores
// that the existing semantic floor was calibrated against.
export const CENTER_TOP_N = 10000;
export const GENERIC_TOKEN_RE = /^[a-z]{2,20}$/;
// glove.6B.100d.txt is ~347 MB; anything past this is not the file we pinned.
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
// Most stem merges are the stemmer doing its job: inflected forms of one lemma
// ("days" -> "day") folding onto one key, whose vectors are near-identical, so
// keeping the more frequent form loses nothing. A merge is only a problem when
// the two words mean DIFFERENT things ("coping" -> "cop") — and with the real
// vectors in hand that is directly measurable: below this cosine the merged
// words are not the same lemma, and the dropped word's meaning is silently
// replaced by an unrelated vector.
export const BAD_COLLISION_COSINE = 0.4;
// Bad merges (per the cosine test above) beyond this fraction of the stored
// vocab mean the light stemmer is destroying meaning at scale — fail loudly
// rather than silently shipping degraded vectors.
export const MAX_BAD_COLLISION_RATE = 0.05;
// Anisotropy correction: subtract the corpus-mean vector before normalizing.
// GloVe vectors cluster in a narrow cone, so without this, unrelated word
// pairs carry a spurious positive baseline — measured on this vocabulary it
// pushed the validator's unrelated p99 above any workable floor (and let a
// "farm" challenge score sea-life labels above it). Centering costs a little
// related-pair similarity, which the retrofit below more than recovers for
// the curated clusters.
export const MEAN_CENTER = true;
// Retrofit strength (Faruqui et al. 2015, "Retrofitting word vectors to
// semantic lexicons"): each authored word is blended toward its cluster's
// centroid, injecting the curated synonym knowledge ("sunflower" IS a
// "flower") that plain distributional vectors under-represent — GloVe puts
// sunflower<->flower at ~0.35, below any workable floor, because the words
// appear in different contexts (oil/seeds/van Gogh vs gardens). 0 disables;
// 1 collapses each cluster to its centroid.
export const RETROFIT_BETA = 0.5;

export const ROOT = path.join(__dirname, '..', '..');
export const CACHE_DIR = path.join(__dirname, '..', '.cache');
export const ZIP_PATH = path.join(CACHE_DIR, 'glove.6B.zip');
export const OUT_PATH = path.join(__dirname, '..', 'lexicon-embeddings.json');
export const CONCEPTS_PATH = path.join(__dirname, '..', 'lexicon-concepts.json');
