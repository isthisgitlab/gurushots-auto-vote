/**
 * Challenge rules as a persisted, rotation-proof settings layer: reading and
 * saving the ordered rule list, and the rule-aware resolvers callers use —
 * a single rule setting, the join opt-in, the inherited title profile, and the
 * tag-list / ignore-words effective values.
 */

import * as logger from '../logger';
import { ruleConditions, matchingRules } from './challengeRules';
import { loadSettings, saveSettings } from './persistence';
import { profileNameForLog } from './profileStore';
import { factsForChallengeId } from './challengeFacts';
import { MAX_TITLE_RULES, sanitizeTitleRule, titleRuleKey, ruleLogLabel } from './titleRuleSanitize';
import {
    ruleTimeZone,
    ruleValuesFor,
    isTitleProfileSuppressed,
    titleProfileComposesWithKnownOverrides,
} from './ruleResolution';
import { getEffectiveSetting } from './challengeOverrides';

import type { ConfigV2 } from '../types/config';
import type { RuleMatchChallenge, SettingValueOf, TitleRule, TitleRuleInfo } from '../types/settings';
import type { RuleLike } from './challengeRules';

/**
 * One input rule the sanitize pass did not store, said back to the caller: a
 * no-op it dropped, or a duplicate match condition it collapsed into an
 * earlier rule (the later values lose). `index` is the rule's 1-based place in
 * the input list; `label` names it the way the log lines do.
 */
interface TitleRuleNote {
    index: number;
    label: string;
    reason: string;
}

/**
 * What the write path checks before saving, answered without saving:
 * `rules` is the list that would be stored (so a preview cannot drift from
 * the write), `dropped` and `collapsed` say what the sanitize pass left out
 * and why, and `error` is the write's rejection reason.
 */
type TitleRulesPreview =
    | { ok: true; rules: TitleRule[]; dropped: TitleRuleNote[]; collapsed: TitleRuleNote[] }
    | { ok: false; error: string };

/**
 * Setting keys whose rule contribution is merged as a tag union. Named
 * profiles resolve as an inherited settings layer instead.
 */
const TITLE_RULE_TAG_KEYS = ['mustIncludeTags', 'shouldIncludeTags'];

/**
 * Order-preserving union of two tag lists with the base first.
 */
const unionTags = (base: readonly string[], extra: unknown[]): string[] => {
    const out: string[] = [];
    const seen = new Set();
    for (const list of [base, extra]) {
        for (const tag of list) {
            if (typeof tag !== 'string') continue;
            if (seen.has(tag)) continue;
            seen.add(tag);
            out.push(tag);
        }
    }
    return out;
};

/**
 * Get the saved challenge rules.
 */
const getTitleRules = (): TitleRule[] => loadSettings().rules;

/**
 * Public per-setting resolver for callers holding a challenge payload (the join
 * pass resolves un-joined candidates, which have no id-keyed state). Returns
 * `{ value }` from the first matching rule that sets the key (see
 * `ruleValuesFor` in settings/ruleResolution.ts), or null when none does.
 */
const resolveRuleSetting = (key: string, target: RuleMatchChallenge | string): { value: unknown } | null => {
    const { values } = ruleValuesFor(loadSettings(), target);
    return Object.prototype.hasOwnProperty.call(values, key) ? { value: values[key] } : null;
};

/**
 * Whether the rules explicitly opt a candidate into auto-join strongly enough
 * to bypass the join TYPE filters: they resolve `autoJoin` to true (inline or
 * via the profile), or the applying profile comes from a rule naming a title or
 * a challenge tag — the user naming this challenge and handing it a tactic.
 * A profile from a rule keyed only on type / photo count / runtime does not
 * bypass: "every 4-photo challenge votes like this" says how, not whether.
 */
const hasRuleJoinOptIn = (challenge: RuleMatchChallenge): boolean => {
    const { values, profile } = ruleValuesFor(loadSettings(), challenge);
    if (values.autoJoin === true) return true;
    if (!profile) return false;
    const conditions = ruleConditions(profile.rule);
    return conditions.patterns.length > 0 || Boolean(conditions.tag);
};

// Bound a user-supplied title before it reaches a log line so an oversized
// value can't produce a huge log event (defense in depth for log shipping).
const _titleForLog = (title: string): string => (title.length > 80 ? `${title.slice(0, 80)}…` : title);

/**
 * Sanitize every rule and de-dupe on the whole CONDITION, not the title alone:
 * "abc"/exact and "abc"/contains are different rules, and a title-less rule has
 * no title to key on at all. Last wins within one identical condition, at the
 * first one's position. Reports what it drops (no-op rules) and collapses
 * (duplicate conditions) with a reason per entry, or the rejection on the
 * first rejected rule — setTitleRules and previewTitleRules both run this, so
 * the preview cannot drift from the write.
 */
const _sanitizedUniqueRules = (rules: unknown[], storedProfiles: Record<string, unknown>): TitleRulesPreview => {
    const byKey: Map<string, { rule: TitleRule; index: number }> = new Map();
    const dropped: TitleRuleNote[] = [];
    const collapsed: TitleRuleNote[] = [];
    for (const [position, rule] of rules.entries()) {
        const result = sanitizeTitleRule(rule as RuleLike, storedProfiles);
        if (!result.valid) {
            const detail = result.requestedProfile
                ? `unknown profile "${profileNameForLog(result.requestedProfile)}"`
                : `invalid or over-length values`;
            return { ok: false, error: `Title rule rejected for "${_titleForLog(result.title)}": ${detail}` };
        }
        if (result.rule === null) {
            dropped.push({ index: position + 1, label: result.label, reason: result.droppedBecause });
            continue;
        }
        const key = titleRuleKey(result.rule);
        const first = byKey.get(key);
        if (first !== undefined) {
            collapsed.push({
                index: position + 1,
                label: ruleLogLabel(result.rule, result.rule.title),
                reason: `same match condition as rule ${first.index} ("${_titleForLog(ruleLogLabel(first.rule, first.rule.title))}") — the later values win, at the first one's position`,
            });
        }
        byKey.set(key, { rule: result.rule, index: position + 1 });
    }
    return { ok: true, rules: Array.from(byKey.values(), (entry) => entry.rule), dropped, collapsed };
};

/**
 * Everything setTitleRules checks before saving, as one pipeline the write and
 * the dry-run share: the array check, the cap, the sanitize pass and the
 * profile-conflict check. Returns the loaded settings with the rules that
 * would be stored, or the rejection reason.
 */
const _checkedRules = (
    rules: unknown,
):
    | { ok: true; settings: ConfigV2; rules: TitleRule[]; dropped: TitleRuleNote[]; collapsed: TitleRuleNote[] }
    | { ok: false; error: string } => {
    if (!Array.isArray(rules)) return { ok: false, error: 'setTitleRules expects an array' };
    if (rules.length > MAX_TITLE_RULES) {
        return {
            ok: false,
            error: `setTitleRules rejected: ${rules.length} rules exceeds the ${MAX_TITLE_RULES} cap`,
        };
    }

    const settings = loadSettings();
    const storedProfiles = settings.profiles;
    const sanitized = _sanitizedUniqueRules(rules, storedProfiles);
    if (!sanitized.ok) return sanitized;

    for (const rule of sanitized.rules) {
        if (rule.profile && !titleProfileComposesWithKnownOverrides(settings, rule, storedProfiles[rule.profile])) {
            return {
                ok: false,
                error: `Title profile conflicts with manual overrides for "${_titleForLog(ruleLogLabel(rule, rule.title))}"`,
            };
        }
    }
    return { ok: true, settings, rules: sanitized.rules, dropped: sanitized.dropped, collapsed: sanitized.collapsed };
};

/**
 * The dry-run of setTitleRules: everything the write checks before saving,
 * answered without saving. Backed by the same pipeline setTitleRules runs, so
 * the preview cannot drift from the write.
 */
const previewTitleRules = (rules: unknown): TitleRulesPreview => {
    const checked = _checkedRules(rules);
    if (!checked.ok) return checked;
    return { ok: true, rules: checked.rules, dropped: checked.dropped, collapsed: checked.collapsed };
};

/**
 * Persist the challenge rules, in the given order — the order is the
 * precedence. A rule may add tags, inherit a named profile, override settings
 * inline, or any mix. Sanitizes input: trims titles, validates conditions and
 * tag lists against the schema, resolves profile names case-insensitively,
 * drops no-op rules, and de-dupes by the whole match condition (last wins, at
 * the first one's position). Logs and refuses on the first rejection; the
 * dry-run `previewTitleRules` answers the same checks without saving.
 */
const setTitleRules = (rules: unknown): boolean => {
    const checked = _checkedRules(rules);
    if (!checked.ok) {
        logger.withCategory('settings').error(checked.error, null);
        return false;
    }

    // The list is saved in the order the user gave, which IS the precedence.
    checked.settings.rules = checked.rules;
    return saveSettings(checked.settings);
};

/**
 * Public read model for the renderer: what the rules matching a challenge
 * contribute (see TitleRuleInfo): the profile they apply, the challenge's
 * suppression of it, and the value maps with and without the profile layer.
 * Rules that match nothing give empty layers and no profile.
 *
 * Accepts a challenge object or a bare title. With only a title, a rule keyed
 * on tag / type / photo count / runtime can still resolve when `challengeId` is
 * given, because those facts come from the remembered active-challenge list.
 * Everything is read against that fact-enriched challenge, the one the rules
 * are matched on, never against the bare title.
 */
const getTitleProfile = (
    target: RuleMatchChallenge | string,
    challengeId: string | number | null = null,
): TitleRuleInfo => {
    const settings = loadSettings();
    const challenge: Record<string, unknown> = typeof target === 'string' ? { title: target } : { ...target };
    const hasId = challengeId !== null && challengeId !== undefined;
    if (hasId) {
        // Fill only what the caller did not supply, so an explicit payload wins.
        for (const [key, value] of Object.entries(factsForChallengeId(challengeId))) {
            if (challenge[key] === undefined) challenge[key] = value;
        }
    }
    const { values: ruleValues, profile, sources: ruleSources } = ruleValuesFor(settings, challenge);
    const { values: inlineValues, sources: inlineSources } = ruleValuesFor(settings, challenge, true);
    return {
        profile: profile ? { name: profile.name, values: profile.values } : null,
        suppressed: hasId && isTitleProfileSuppressed(settings, challengeId),
        ruleValues,
        inlineValues,
        ruleSources,
        inlineSources,
    };
};

/**
 * Effective value for one of the rule-scoped tag lists. Starts from the
 * id-keyed effective value (per-challenge override or global default) and, when
 * a rule matches, unions that rule's tags on top — so a recurring challenge
 * picks up its tags by rule regardless of its rotating id.
 *
 * Falls back to plain getEffectiveSetting for any non-tag key, and preserves
 * the null "no filter" sentinel when there is no rule to contribute tags.
 */
const getEffectiveTagSetting = <K extends string>(
    settingKey: K,
    challenge: RuleMatchChallenge | null | undefined,
): SettingValueOf<K> => {
    const challengeId = challenge?.id != null ? String(challenge.id) : null;
    const base = getEffectiveSetting(settingKey, challengeId);
    if (!TITLE_RULE_TAG_KEYS.includes(settingKey)) return base;

    // Pass the whole challenge, not just its title: a rule may be keyed on any
    // of the challenge's own facts, and a joined challenge carries them in the
    // payload. The first matching rule that lists tags for this key wins.
    const settings = loadSettings();
    const rule = matchingRules(settings.rules, challenge, ruleTimeZone(settings)).find(
        (candidate) => Array.isArray(candidate?.[settingKey]) && candidate[settingKey].length > 0,
    );
    if (!rule) return base;

    // A tag key's effective value is a tag list: stored values are validated on load.
    const baseTags = base as string[];
    return unionTags(baseTags, rule[settingKey] as unknown[]) as SettingValueOf<K>;
};

/**
 * The ignore-words list for a challenge title, or null when empty.
 *
 * Thin wrapper over getEffectiveSetting (master -> profile -> per-challenge) so
 * both the fill and join paths read it the same way without either importing
 * the other. Returns null rather than [] because the picker treats null as
 * "no list" and skips the Set construction entirely.
 */
const getEffectiveIgnoreTitleWords = (challenge: RuleMatchChallenge | null | undefined): Array<string> | null => {
    const challengeId = challenge?.id != null ? String(challenge.id) : null;
    const words = getEffectiveSetting('ignoreTitleWords', challengeId);
    return Array.isArray(words) && words.length > 0 ? words : null;
};

export {
    getTitleRules,
    setTitleRules,
    previewTitleRules,
    resolveRuleSetting,
    hasRuleJoinOptIn,
    getTitleProfile,
    getEffectiveTagSetting,
    getEffectiveIgnoreTitleWords,
};
export type { TitleRuleNote, TitleRulesPreview };
