/**
 * The active-challenge boundary: every challenge is checked once, when its
 * read arrives, by normalizeActiveChallenges — the step both reads (the real
 * api/challenges fetch and the mock endpoint) call before anything else sees
 * the list. A field that is present but malformed marks the challenge
 * (`dataIssues`): actions refuse it, state keepers keep its id alive, and the
 * card says the data cannot be read. Fields the repo documents as optional
 * never mark; at most they warn. An object with a usable id is never dropped
 * from the list — absence from it means "gone" to title pins, per-challenge
 * settings and metadata — so only an element that cannot carry an identity is
 * dropped, and the read becomes prune-unsafe (`pruneUnsafe`).
 *
 * Pure and outside api/ on purpose: the mock imports it too. The logs carry
 * the challenge tag and the codes only, never field values.
 */

import * as logger from './logger';
import { isValidId } from './ids';
import { isPlainObject } from './plainObject';

import type { ActiveChallengesResponse, Challenge } from './types/gurushots';

/**
 * The Challenge fields the app itself sets on a fetched list. The boundary
 * strips every one of them off each real read, so the server cannot pre-seed
 * them; the mock read skips the stripping, because its cached session objects
 * legitimately carry them.
 */
export const APP_SET_CHALLENGE_FIELDS = ['boostHoldUntil', 'teamMatch'] as const;

/** Decimal digits with an optional fraction — the one numeric-string shape converted in place. */
const NUMERIC_STRING_RE = /^\d+(\.\d+)?$/;
/** At and above this a timestamp is milliseconds, not Unix seconds — never accepted. */
const MAX_TIMESTAMP = 1e11;

// The enable/lock flags: present-but-not-boolean warns, never marks. The
// readers check each flag with a literal compare, so a wrong type only
// switches the feature off.
const BOOLEAN_FLAG_FIELDS = [
    'boost_enable',
    'turbo_enable',
    'fill_enable',
    'fill_locked',
    'swap_enable',
    'swap_locked',
    'top_photo_enable',
    'guru_pick_enable',
    'top_photographer_enable',
    'levels_rank_enable',
    'new_ranking_enable',
] as const;

/** The one warning code that is the incident shape (level / level_name / percent missing), logged at warning level, not debug. */
const INCIDENT_CODE = 'ranking.total.level';

/**
 * The timestamp rule for start_time / close_time: a finite number under
 * MAX_TIMESTAMP, or a decimal string, which is converted to a number in place
 * so the numeric readers (challengeFacts, nextBoundaryFlip) get numbers.
 * Absent, null, or anything else fails — every challenge in the active list
 * carries both fields, so absence marks too.
 */
const timestampOk = (challenge: Record<string, unknown>, field: 'start_time' | 'close_time'): boolean => {
    const value = challenge[field];
    if (typeof value === 'number') return Number.isFinite(value) && value < MAX_TIMESTAMP;
    if (typeof value === 'string' && NUMERIC_STRING_RE.test(value)) {
        const converted = Number(value);
        if (!Number.isFinite(converted) || converted >= MAX_TIMESTAMP) return false;
        challenge[field] = converted;
        return true;
    }
    return false;
};

/**
 * The exposure rule for ranking.exposure.exposure_factor: a finite number in
 * 0–100, or a decimal string in range, converted to a number in place — the
 * spend readers already coerce numeric strings, so the boundary normalizes
 * them the same way. Absent and null never mark (documented optional).
 */
const exposureFactorOk = (exposure: Record<string, unknown>): boolean => {
    const inRange = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 100;
    const value = exposure.exposure_factor;
    if (typeof value === 'number') return inRange(value);
    if (typeof value === 'string' && NUMERIC_STRING_RE.test(value)) {
        const converted = Number(value);
        if (!inRange(converted)) return false;
        exposure.exposure_factor = converted;
        return true;
    }
    return false;
};

/**
 * The marking rules. Returns stable codes, in a fixed order; a non-empty list
 * is what marks the challenge (`dataIssues`). Converts numeric-string
 * timestamps and exposure factors in place. Absent or null never marks —
 * except `id`, `start_time` and `close_time`, which every challenge in the
 * active list carries.
 */
const challengeIssues = (challenge: Record<string, unknown>): string[] => {
    const issues: string[] = [];
    if (!timestampOk(challenge, 'start_time')) issues.push('start_time');
    if (!timestampOk(challenge, 'close_time')) issues.push('close_time');
    const start = challenge.start_time;
    const close = challenge.close_time;
    if (typeof start === 'number' && typeof close === 'number' && start >= close) issues.push('start_close_order');

    const member = challenge.member;
    if (member !== undefined && member !== null && !isPlainObject(member)) {
        issues.push('member');
    } else if (isPlainObject(member)) {
        const ranking = member.ranking;
        if (ranking !== undefined && ranking !== null && !isPlainObject(ranking)) {
            issues.push('member.ranking');
        } else if (isPlainObject(ranking)) {
            const entries = ranking.entries;
            if (entries !== undefined && entries !== null) {
                const entryBroken = (entry: unknown): boolean => !isPlainObject(entry) || !isValidId(entry.id);
                if (!Array.isArray(entries) || entries.some(entryBroken)) issues.push('ranking.entries');
            }
            const exposure = ranking.exposure;
            if (
                isPlainObject(exposure) &&
                exposure.exposure_factor !== undefined &&
                exposure.exposure_factor !== null &&
                !exposureFactorOk(exposure)
            ) {
                issues.push('ranking.exposure.exposure_factor');
            }
        }
    }
    return issues;
};

/**
 * The warn-only rules: optional fields whose malformed shape every reader
 * already survives. Never marks, never mutates. Each code is emitted at most
 * once per challenge, in a fixed order. The incident shape
 * (`ranking.total.level`) warns like the rest; only its log level differs.
 */
const challengeWarnings = (challenge: Record<string, unknown>): string[] => {
    const warnings: string[] = [];
    const warn = (code: string): void => {
        if (!warnings.includes(code)) warnings.push(code);
    };

    if (challenge.type !== undefined && typeof challenge.type !== 'string') warn('type');
    if (challenge.url === undefined) warn('url');
    if (
        challenge.max_photo_submits !== undefined &&
        (typeof challenge.max_photo_submits !== 'number' || !Number.isFinite(challenge.max_photo_submits))
    ) {
        warn('max_photo_submits');
    }
    for (const field of BOOLEAN_FLAG_FIELDS) {
        if (challenge[field] !== undefined && typeof challenge[field] !== 'boolean') warn(field);
    }

    const member = challenge.member;
    if (isPlainObject(member)) {
        const boost = member.boost;
        if (
            isPlainObject(boost) &&
            boost.timeout !== undefined &&
            boost.timeout !== null &&
            (typeof boost.timeout !== 'number' || !Number.isFinite(boost.timeout))
        ) {
            warn('member.boost.timeout');
        }

        const ranking = member.ranking;
        if (isPlainObject(ranking)) {
            if (ranking.entries === undefined || ranking.entries === null) warn('ranking.entries_absent');
            if (Array.isArray(ranking.entries)) {
                for (const entry of ranking.entries) {
                    if (!isPlainObject(entry)) continue;
                    if (entry.votes !== undefined && (typeof entry.votes !== 'number' || !Number.isFinite(entry.votes)))
                        warn('ranking.entries.votes');
                    for (const flag of ['boosted', 'boosting', 'turbo'] as const) {
                        if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean')
                            warn(`ranking.entries.${flag}`);
                    }
                }
            }
            if (ranking.swaps === undefined) warn('ranking.swaps_absent');
            if (isPlainObject(ranking.exposure) && ranking.exposure.exposure_factor === null) {
                warn('ranking.exposure.exposure_factor_null');
            }
            const total = ranking.total;
            if (
                isPlainObject(total) &&
                (typeof total.level !== 'number' ||
                    typeof total.level_name !== 'string' ||
                    typeof total.percent !== 'number')
            ) {
                warn(INCIDENT_CODE);
            }
        }
    }
    return warnings;
};

// Log dedup: one entry per (stream, challenge id) holding the last logged code
// set — a new set for the same id logs again, an id that leaves the list
// leaves the map. In-memory only: durability matters for the marks, not for
// the log lines.
const lastCodesByKey = new Map<string, string>();

// True while consecutive reads stay prune-unsafe; the skip-pruning warning
// logs once per run of unsafe reads and resets on the next safe one.
let inPruneUnsafeRun = false;

/** The dedup gate: true when this (stream, id) code set was not the one logged last. */
const codeSetChanged = (key: string, codes: string[]): boolean => {
    const joined = codes.join(',');
    if (lastCodesByKey.get(key) === joined) return false;
    lastCodesByKey.set(key, joined);
    return true;
};

/** Test-only: clear the log-dedup map and the prune-unsafe run state. */
const __resetForTests = (): void => {
    lastCodesByKey.clear();
    inPruneUnsafeRun = false;
};

/**
 * The step both reads call before anything else sees the response. Checks
 * every challenge once, marks the malformed ones (`dataIssues`), drops the
 * elements that cannot carry an identity (setting `pruneUnsafe`), strips the
 * app-set fields off the real read and forces `fetchFailed` to `false`, so a
 * server-sent `fetchFailed: true` cannot fake a failed read. Marks log at
 * warning level and optional-field warnings at debug level (the incident
 * shape at warning level), deduplicated per (id, code set); an id that leaves
 * the list leaves the dedup map.
 *
 * The second parameter carries the one option the two reads differ in:
 * `stripAppSetFields` is `true` on the real read (the server must not be able
 * to pre-seed `boostHoldUntil` or `teamMatch`) and `false` on the mock read
 * (its cached session objects legitimately carry what the pass set).
 *
 * A missing or non-array `challenges` returns `{ challenges: [], fetchFailed:
 * true }` — the same shape a failed request resolves to.
 */
const normalizeActiveChallenges = (
    response: ActiveChallengesResponse,
    stripAppSetFields = false,
): ActiveChallengesResponse => {
    if (!Array.isArray(response.challenges)) return { challenges: [], fetchFailed: true };

    response.fetchFailed = false;
    const original = response.challenges;
    const kept: Challenge[] = [];
    for (const element of original) {
        if (!isPlainObject(element) || !isValidId(element.id)) continue;
        if (stripAppSetFields) {
            for (const field of APP_SET_CHALLENGE_FIELDS) delete element[field];
        }
        const issues = challengeIssues(element);
        if (issues.length > 0) element.dataIssues = issues;
        else delete element.dataIssues;
        const warnings = challengeWarnings(element);

        const tag = logger.challengeTag(element);
        const id = String(element.id);
        if (issues.length > 0) {
            if (codeSetChanged(`issue:${id}`, issues)) {
                logger.withCategory('challenges').warningT('mb1c1035e9290', [tag], { codes: issues });
            }
        } else {
            // A cleared stream forgets its last code set: a later flare-up
            // with the same codes is a new finding and must log again.
            lastCodesByKey.delete(`issue:${id}`);
        }
        const optional = warnings.filter((code) => code !== INCIDENT_CODE);
        if (optional.length > 0) {
            if (codeSetChanged(`warning:${id}`, optional)) {
                logger
                    .withCategory('challenges')
                    .debug(`${tag}: optional fields could not be read — running with defaults`, { codes: optional });
            }
        } else {
            lastCodesByKey.delete(`warning:${id}`);
        }
        if (warnings.includes(INCIDENT_CODE)) {
            if (codeSetChanged(`incident:${id}`, [INCIDENT_CODE])) {
                logger.withCategory('challenges').warningT('m890f1744e605', [tag], { codes: [INCIDENT_CODE] });
            }
        } else {
            lastCodesByKey.delete(`incident:${id}`);
        }
        kept.push(element);
    }
    response.challenges = kept;

    const pruneUnsafe = kept.length < original.length;
    response.pruneUnsafe = pruneUnsafe;
    if (pruneUnsafe && !inPruneUnsafeRun) {
        inPruneUnsafeRun = true;
        logger
            .withCategory('challenges')
            .warning(
                'Unreadable challenges in the active list — title pins, per-challenge settings and metadata were not pruned',
                { dropped: original.length - kept.length },
            );
    } else if (!pruneUnsafe) {
        inPruneUnsafeRun = false;
    }

    const activeIds = new Set(kept.map((challenge) => String(challenge.id)));
    for (const key of [...lastCodesByKey.keys()]) {
        if (!activeIds.has(key.slice(key.indexOf(':') + 1))) lastCodesByKey.delete(key);
    }
    return response;
};

export { normalizeActiveChallenges, challengeIssues, challengeWarnings, __resetForTests };
