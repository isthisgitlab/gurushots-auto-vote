/**
 * Write-side sanitization of challenge rules (the persisted `titleRules`
 * list): the size caps, the inline-override allowlist, per-rule validation of
 * titles / conditions / tags / profile reference, the de-dupe identity key, and
 * the log label of a rule. Pure — setTitleRules (titleRules.ts) owns the
 * load/save around it.
 */

import { validateSetting } from './schema';
import {
    TITLE_MATCH_MODES,
    normalizeTitle,
    normalizeTag,
    normalizeRulePics,
    normalizeRuleHours,
    titleRuleTitles,
    ruleConditions,
} from './challengeRules';
import { normalizeProfileName, findProfileKey } from './profileStore';

import type { ChallengeValues, TitleRule } from '../types/settings';
import type { RuleLike } from './challengeRules';

// Defensive caps on renderer-supplied rule input. The rules share the single
// settings JSON blob with every platform, so bound both the count and the
// per-title length to keep a malformed/oversized payload from bloating the
// file and slowing every rule scan. Real GuruShots titles are short, so 200 is
// comfortably generous for both.
const MAX_TITLE_RULES = 200;
const MAX_TITLE_LENGTH = 200;
// One rule may list several titles that share the same behaviour, so the user
// doesn't have to duplicate a whole rule per recurring challenge.
const MAX_TITLES_PER_RULE = 50;

/**
 * Settings a rule may override INLINE, without going through a named profile.
 * Deliberately a short allowlist rather than "every perChallenge key": these
 * are the ones that decide whether an UN-JOINED candidate is acted on at all,
 * and an un-joined challenge has no cached id for a per-challenge override to
 * key off — so a rule is the only place they can be expressed. Richer setups
 * belong in a named profile, which this composes with (inline wins).
 */
const TITLE_RULE_INLINE_KEYS = [
    'autoJoin',
    'autoFill',
    'autoJoinWithinHoursOfEnd',
    'autoJoinAfterPercentElapsed',
    'scenario',
];

/**
 * Pull the inline overrides off one rule, validated against the schema. Returns
 * null when a value is present but invalid, so setTitleRules can reject the
 * whole rule rather than silently persist a value automation would later read.
 * An absent key means "inherit" — it is never written as a default, so a rule
 * cannot freeze today's default into storage.
 */
const sanitizeTitleRuleInline = (rule: RuleLike): ChallengeValues | null => {
    const out: ChallengeValues = {};
    for (const key of TITLE_RULE_INLINE_KEYS) {
        if (!rule || !Object.prototype.hasOwnProperty.call(rule, key)) continue;
        const value = rule[key];
        // An empty string / null is how the editor spells "inherit" for a
        // cleared number or an unset select; treat it as absent, not as 0.
        if (value === null || value === undefined || value === '') continue;
        if (!validateSetting(key, value)) return null;
        out[key] = value;
    }
    return out;
};

const _sanitizeTitleRuleTags = (key: string, value: unknown): string[] | null => {
    const list = (Array.isArray(value) ? (value as unknown[]) : [])
        .filter((tag) => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean);
    return validateSetting(key, list) ? list : null;
};

/**
 * `requested` is the caller's already-trimmed string ('' = no profile).
 */
const _canonicalTitleRuleProfile = (storedProfiles: Record<string, unknown>, requested: string): string | null =>
    requested ? findProfileKey(storedProfiles, normalizeProfileName(requested)) : '';

// Identity of a rule's match condition. "\u0000"/"\u0001" cannot occur in a
// trimmed title or tag, so they are safe separators no user value can forge.
// The title list is sorted so the same set in a different order is one rule.
const titleRuleKey = (rule: RuleLike): string => {
    const conditions = ruleConditions(rule);
    return [
        conditions.patterns
            .map((pattern, index) => `${pattern}\u0001${conditions.modes[index]}`)
            .sort()
            .join('\u0001'),
        conditions.tag,
        conditions.type,
        conditions.pics ?? '',
        conditions.minHours ?? '',
        conditions.maxHours ?? '',
    ].join('\u0000');
};

/**
 * Trim, drop empties and case-insensitive duplicates (first spelling wins).
 */
const _sanitizeRuleTitleList = (rule: RuleLike): { titles: string[]; modes: string[] } | null => {
    const seen = new Set();
    const titles: string[] = [];
    const modes: string[] = [];
    const rawTitles = titleRuleTitles(rule);
    const rawModes = rule?.titleMatchModes;
    const fallback = rule?.match || 'exact';
    if (typeof fallback !== 'string' || !TITLE_MATCH_MODES.includes(fallback)) return null;
    if (rawModes !== undefined && (!Array.isArray(rawModes) || rawModes.length !== rawTitles.length)) return null;
    for (const [index, raw] of rawTitles.entries()) {
        const mode = rawModes === undefined ? fallback : rawModes[index];
        if (typeof mode !== 'string' || !TITLE_MATCH_MODES.includes(mode)) return null;
        const title = raw.trim();
        const key = normalizeTitle(title);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        titles.push(title);
        modes.push(mode);
    }
    return { titles, modes };
};

// A numeric condition: null = absent, false = supplied but out of range, else
// the normalized value. Out of range is a rejection, not a silent drop —
// dropping it would widen the rule to every challenge.
const _ruleNumberCondition = (raw: unknown, normalize: (value: unknown) => number | null): number | null | false =>
    raw === null || raw === undefined || raw === '' ? null : (normalize(raw) ?? false);

/**
 * The non-title conditions of a rule, sanitized for storage: challenge tag,
 * challenge type, photo count and runtime range. Returns null when any
 * supplied value is invalid.
 */
const _sanitizeRuleClassConditions = (
    rule: RuleLike,
): Pick<TitleRule, 'challengeTag' | 'type' | 'pics' | 'minHours' | 'maxHours'> | null => {
    const challengeTag = typeof rule?.challengeTag === 'string' ? rule.challengeTag.trim() : '';
    const type = normalizeTag(rule?.type);
    const pics = _ruleNumberCondition(rule?.pics, normalizeRulePics);
    const minHours = _ruleNumberCondition(rule?.minHours, normalizeRuleHours);
    const maxHours = _ruleNumberCondition(rule?.maxHours, normalizeRuleHours);
    if (pics === false || minHours === false || maxHours === false) return null;
    if (challengeTag.length > MAX_TITLE_LENGTH || type.length > MAX_TITLE_LENGTH) return null;
    // An inverted range can never match; refuse it rather than store a dead rule.
    if (minHours !== null && maxHours !== null && minHours > maxHours) return null;
    const out: Pick<TitleRule, 'challengeTag' | 'type' | 'pics' | 'minHours' | 'maxHours'> = {};
    if (challengeTag) out.challengeTag = challengeTag;
    if (type) out.type = type;
    if (pics !== null) out.pics = pics;
    if (minHours !== null) out.minHours = minHours;
    if (maxHours !== null) out.maxHours = maxHours;
    return out;
};

// What a rejected rule is called in the log: its first title, else its tag or
// type, else a generic marker (a photo-count/runtime-only rule has no name).
const ruleLogLabel = (rule: RuleLike, title: string | undefined): string =>
    title ||
    (typeof rule?.challengeTag === 'string' && rule.challengeTag.trim()) ||
    (typeof rule?.type === 'string' && rule.type.trim()) ||
    '(untitled rule)';

/**
 * What a rule does when it matches — its tag lists, canonical profile name and
 * inline overrides — or `{ invalid: true, requestedProfile? }` when any part is
 * rejected (`requestedProfile` names an unknown profile reference).
 */
const _sanitizeRuleBehaviour = (
    rule: RuleLike,
    storedProfiles: Record<string, unknown>,
):
    | { invalid: true; requestedProfile?: string }
    | {
          invalid: false;
          mustIncludeTags: string[];
          shouldIncludeTags: string[];
          profile: string | null;
          inline: ChallengeValues;
      } => {
    const mustIncludeTags = _sanitizeTitleRuleTags('mustIncludeTags', rule?.mustIncludeTags);
    const shouldIncludeTags = _sanitizeTitleRuleTags('shouldIncludeTags', rule?.shouldIncludeTags);
    if (mustIncludeTags === null || shouldIncludeTags === null) return { invalid: true };

    const requestedProfile = typeof rule?.profile === 'string' ? rule.profile.trim() : '';
    const profile = _canonicalTitleRuleProfile(storedProfiles, requestedProfile);
    if (requestedProfile && profile === null) return { invalid: true, requestedProfile };

    const inline = sanitizeTitleRuleInline(rule);
    if (inline === null) return { invalid: true };
    return { invalid: false, mustIncludeTags, shouldIncludeTags, profile, inline };
};

/**
 * Sanitize one rule for storage. Returns `{ valid: false, title, requestedProfile }`
 * on rejection, `{ valid: true, rule: null }` for a no-op rule to drop, or
 * `{ valid: true, rule }` with the sanitized rule.
 */
const sanitizeTitleRule = (
    rule: RuleLike,
    storedProfiles: Record<string, unknown>,
): { valid: false; title: string; requestedProfile?: string } | { valid: true; rule: TitleRule | null } => {
    const titleList = _sanitizeRuleTitleList(rule);
    if (titleList === null) return { valid: false, title: ruleLogLabel(rule, undefined) };
    const { titles, modes } = titleList;
    const title = titles[0] || '';
    const label = ruleLogLabel(rule, title);
    const conditions = _sanitizeRuleClassConditions(rule);
    if (conditions === null) return { valid: false, title: label };
    // A rule needs at least one condition; one without any is the editor's
    // empty new row and is dropped, not rejected.
    if (!title && Object.keys(conditions).length === 0) return { valid: true, rule: null };
    if (titles.length > MAX_TITLES_PER_RULE || titles.some((entry) => entry.length > MAX_TITLE_LENGTH)) {
        return { valid: false, title: label };
    }
    const behaviour = _sanitizeRuleBehaviour(rule, storedProfiles);
    if (behaviour.invalid) return { valid: false, title: label, requestedProfile: behaviour.requestedProfile };
    const { mustIncludeTags, shouldIncludeTags, profile, inline } = behaviour;

    // A rule that does nothing is dropped rather than stored. Inline overrides
    // count as "does something" — a rule whose only content is `autoJoin: true`
    // is a complete, meaningful rule.
    const hasInline = Object.keys(inline).length > 0;
    if (!profile && !hasInline && mustIncludeTags.length === 0 && shouldIncludeTags.length === 0) {
        return { valid: true, rule: null };
    }

    const sanitized: TitleRule = { title, mustIncludeTags, shouldIncludeTags, ...inline, ...conditions };
    // `title` mirrors the first entry for single-title readers; the full list is
    // only stored when there is more than one.
    if (titles.length > 1) sanitized.titles = titles;
    // Only persist a non-default match mode, and only alongside a title — an
    // orphan `match` on a title-less rule would read as meaningful and isn't.
    if (title && modes.some((mode) => mode !== modes[0])) sanitized.titleMatchModes = modes;
    else if (title && modes[0] !== 'exact') sanitized.match = modes[0];
    if (profile) sanitized.profile = profile;
    return { valid: true, rule: sanitized };
};

export {
    MAX_TITLE_RULES,
    MAX_TITLE_LENGTH,
    TITLE_RULE_INLINE_KEYS,
    sanitizeTitleRuleInline,
    sanitizeTitleRule,
    titleRuleKey,
    ruleLogLabel,
};
