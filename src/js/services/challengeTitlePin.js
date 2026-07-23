// @ts-check
/**
 * First-seen challenge-title pinning.
 *
 * GuruShots mutates a challenge's `title` field server-side while an event
 * (e.g. turbo) is active, so the displayed name — and the title-keyed tag
 * rules that match on it — would silently change mid-challenge. This module
 * pins the first title seen for each challenge id and overwrites any later
 * server-side rename in the fetched payload, so everything downstream
 * (rendering, findTitleRule matching, log tags) sees a stable name.
 *
 * Pins persist through the settings facade (challengeSettings.titlePins) —
 * the one storage layer shared by Electron/CLI (fs) and both Android
 * runtimes (foreground Capacitor WebView + headless service WebView), so a
 * restart or a background cycle can't re-adopt a mutated title that an
 * earlier session already pinned correctly.
 */

const settings = require('../settings');
const logger = require('../logger');

// Bound a server-supplied title before it reaches a log line (CR/LF-stripped
// and truncated). Local re-implementation — shared core must not import the
// IPC shell's sanitizeForLog.
const sanitizeForLog = (/** @type {unknown} */ value) =>
    String(value ?? '')
        .replace(/[\r\n\t]/g, ' ')
        .slice(0, 200);

// Shared with mergeTitlePins' storage cap — the compare below only prevents
// perpetual mismatch on over-length titles if both sides bound with the same
// number, so never redeclare this locally.
const MAX_TITLE_LENGTH = /** @type {number} */ (settings.MAX_TITLE_LENGTH);

// Warn once per distinct incoming title per id — repeated confirmations of
// the same mismatch on every poll stay silent. In-memory only: durability
// matters for the pins themselves, not for log dedup.
let lastWarnedTitleById = new Map();

/**
 * Pin first-seen titles onto a freshly fetched active-challenge list.
 * Mutates the challenge objects in place (restoring pinned titles over
 * server-side renames) and returns the same array.
 *
 * No-op on non-array or empty input: an empty list is more likely a
 * degraded/error payload than a genuinely challenge-free account (mirrors
 * cleanupStaleMetadata's guard), and pruning pins on it would let a later
 * fetch re-pin a mutated title.
 *
 * @param {Array<{id?: string|number, title?: string}>} challenges
 * @returns {Array<{id?: string|number, title?: string}>}
 */
const pinChallengeTitles = (challenges) => {
    if (!Array.isArray(challenges) || challenges.length === 0) return challenges;

    // Boundary cast: settings.js is not yet `// @ts-check`-typed, so its
    // inferred return type is too narrow (see CLAUDE.md typing policy).
    const pins = /** @type {Record<string, string>} */ (settings.getTitlePins());
    /** @type {Record<string, string>} */
    const adds = {};
    const activeIds = new Set();

    for (const challenge of challenges) {
        if (challenge?.id == null) continue;
        const id = String(challenge.id);
        activeIds.add(id);

        const raw = typeof challenge.title === 'string' ? challenge.title : '';
        // Compare and store the bounded form so an over-length title never
        // mismatches its own truncated pin on the next fetch.
        const incoming = raw.slice(0, MAX_TITLE_LENGTH);
        const hasIncoming = incoming.trim() !== '';
        const pinned = Object.prototype.hasOwnProperty.call(pins, id) ? pins[id] : null;

        if (pinned === null) {
            // First occurrence wins even within a single batch — a malformed
            // response repeating an id must not let the later entry override
            // the earlier one's first-seen title.
            if (hasIncoming && !Object.prototype.hasOwnProperty.call(adds, id)) {
                adds[id] = incoming;
            }
            continue;
        }

        if (!hasIncoming) {
            // Missing/empty title on a pinned challenge — restore the pin.
            challenge.title = pinned;
            continue;
        }

        if (incoming !== pinned) {
            if (lastWarnedTitleById.get(id) !== incoming) {
                lastWarnedTitleById.set(id, incoming);
                logger
                    .withCategory('challenges')
                    .warning(
                        `Title pin: ignoring server rename for challenge ${sanitizeForLog(id)}: "${sanitizeForLog(incoming)}" — keeping "${sanitizeForLog(pinned)}"`,
                        null,
                    );
            }
            challenge.title = pinned;
        }
    }

    // Prune only when at least one entry carried a usable id — a non-empty
    // list where every entry is malformed is the same degraded-payload state
    // the empty-list guard above protects against, and pruning on it would
    // wipe every pin.
    const removeIds = activeIds.size > 0 ? Object.keys(pins).filter((id) => !activeIds.has(id)) : [];
    if (Object.keys(adds).length > 0 || removeIds.length > 0) {
        settings.mergeTitlePins(adds, removeIds);
    }
    for (const id of removeIds) {
        lastWarnedTitleById.delete(id);
    }

    return challenges;
};

/** Test-only: clear the in-memory warn-dedup map. */
const __resetForTests = () => {
    lastWarnedTitleById = new Map();
};

module.exports = {
    pinChallengeTitles,
    __resetForTests,
};
