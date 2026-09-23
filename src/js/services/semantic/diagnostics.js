const { createJsonStore } = require('../../settings/storage');
const runtime = require('../../runtime');

const diagnosticsStore = createJsonStore({ fileName: 'lexicon-diagnostics.json', prefKey: 'gs_lexicon_diagnostics' });
const MAX_WORDS = 200;
const MAX_SEEN_CHALLENGES = 512;
const WORD_RE = /^[a-z]{2,20}$/;

const emptyReport = () => ({
    version: 1,
    since: new Date().toISOString(),
    updatedAt: null,
    challenges: 0,
    noThemeVector: 0,
    noLabelVectors: 0,
    noOnThemeScore: 0,
    themeWords: {},
    labelWords: {},
    seenDay: null,
    seenChallenges: [],
});

// Stable local fingerprint for deduplication across app and CLI restarts.
// The report never stores the source challenge ID, URL, or title.
const challengeFingerprint = (key) => {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(36);
};

// Keep the most frequent observed misses in a fixed-size local file. Counts
// are observations, not a claim that a word ought to be added to the lexicon.
const countWords = (counts, words) => {
    for (const word of new Set(words)) {
        if (!WORD_RE.test(word)) continue;
        if (Object.hasOwn(counts, word)) {
            counts[word]++;
        } else if (Object.keys(counts).length < MAX_WORDS) {
            counts[word] = 1;
        } else {
            const least = Object.keys(counts).reduce((a, b) => (counts[a] <= counts[b] ? a : b));
            delete counts[least];
            counts[word] = 1;
        }
    }
};

const createDiagnostics = (store) => {
    const read = () => {
        try {
            const data = JSON.parse(store.readRaw() || 'null');
            if (
                data?.version === 1 &&
                ['challenges', 'noThemeVector', 'noLabelVectors', 'noOnThemeScore'].every((key) =>
                    Number.isSafeInteger(data[key]),
                ) &&
                typeof data.since === 'string' &&
                data.themeWords &&
                data.labelWords &&
                Array.isArray(data.seenChallenges) &&
                !Array.isArray(data.themeWords) &&
                !Array.isArray(data.labelWords)
            ) {
                return data;
            }
        } catch {
            // A damaged optional report must never interrupt a fill.
        }
        return emptyReport();
    };

    return {
        read,
        record: (
            challengeKey,
            { themeWords = [], labelWords = [], noThemeVector = false, noLabelVectors = false, noOnThemeScore = false },
        ) => {
            const day = new Date().toISOString().slice(0, 10);
            const key = String(challengeKey || '');
            if (!key) return;

            try {
                const report = read();
                if (report.seenDay !== day) {
                    report.seenDay = day;
                    report.seenChallenges = [];
                }
                const fingerprint = challengeFingerprint(key);
                if (report.seenChallenges.includes(fingerprint)) return;
                report.challenges++;
                report.noThemeVector += Number(noThemeVector);
                report.noLabelVectors += Number(noLabelVectors);
                report.noOnThemeScore += Number(noOnThemeScore);
                countWords(report.themeWords, themeWords);
                countWords(report.labelWords, labelWords);
                report.seenChallenges.push(fingerprint);
                if (report.seenChallenges.length > MAX_SEEN_CHALLENGES) report.seenChallenges.shift();
                report.updatedAt = new Date().toISOString();
                store.writeRaw(JSON.stringify(report));
            } catch {
                // Diagnostics are best-effort and must not change auto-fill behavior.
            }
        },
    };
};

const diagnostics = createDiagnostics(diagnosticsStore);
const shouldCollect = () => {
    if (runtime.isTest()) return false;
    try {
        return require('../../settings').getSetting('mock') !== true;
    } catch {
        return false;
    }
};

module.exports = {
    diagnostics,
    createDiagnostics,
    shouldCollect,
    initializeDiagnosticsAsync: diagnosticsStore.initializeAsync,
    flushDiagnosticsWrites: diagnosticsStore.flushPendingWrites,
};
