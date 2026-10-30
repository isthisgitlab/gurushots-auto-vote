/**
 * Join settings, resolved per candidate by RULE. Un-joined ids are not in the
 * id cache (it is filled from get_my_active_challenges), so the id-keyed
 * getEffectiveSetting(key, id) cannot see a rule for a challenge the user has
 * not joined; the rules are matched against the candidate payload instead.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import type { Challenge } from '../../types/gurushots';
import type { ChallengeValues, TitleRule } from '../../types/settings';
import { cat } from './shared';

// The only join settings that read the per-id override layer (see resolveJoinSetting). The settings cleanup keeps the
// per-id entries of the same keys (JOIN_KEPT_KEYS in settings/staleChallengeCleanup.ts); a test pins the two equal.
const PER_ID_JOIN_KEYS: ReadonlySet<string> = new Set([
    'chosenPhotos',
    'chosenPhotosOnly',
    'chosenPhotosInOrder',
    'manualPhotosOnly',
]);

// The three join-timing keys resolve as ONE group (resolveRuleSettingGroup in
// settings/titleRules.ts): the first rule source that sets ANY of them supplies
// all three, and the timing keys of lower sources — a later rule, the global
// default — are ignored, so no second window can be smuggled in next to the
// winning one. Read in a fixed order downstream (resolveJoinWindow):
// after-start → percent → before-end, the first above 0 applies.
const JOIN_TIMING_KEYS: string[] = [
    'autoJoinAfterHoursFromStart',
    'autoJoinAfterPercentElapsed',
    'autoJoinWithinHoursOfEnd',
];

/**
 * Resolve one setting for an un-joined candidate. The id-keyed
 * getEffectiveSetting(key, id) cannot see a rule for a challenge the user has
 * not joined (its id was never cached from get_my_active_challenges), so we
 * match the rules against the candidate payload itself and fall back to the
 * global default.
 *
 * Precedence (the chosen-photos keys and manualPhotosOnly only: the candidate's own
 * per-id override first, then the same chain): rules in list order, the first matching rule that sets the key
 * wins — a rule's inline override before the profile it names — then the
 * global default. See `ruleValuesFor` in settings/ruleResolution.ts.
 *
 * The three join-timing keys are NOT read through here one by one — they
 * resolve as one group (JOIN_TIMING_KEYS below); this function stays per key
 * for everything else.
 */
const resolveJoinSetting = (key: string, challenge: Partial<Challenge>): unknown => {
    // The chosen-photos keys and manualPhotosOnly also honour an override saved for THIS id: an
    // un-joined challenge has no cached id for getEffectiveSetting, yet the
    // Discover view saves the user's choice per challenge id. Every other key
    // keeps resolving by rule alone.
    if (PER_ID_JOIN_KEYS.has(key) && challenge?.id !== undefined && challenge?.id !== null) {
        const own = settings.getChallengeOverride?.(key, String(challenge.id));
        if (own !== null && own !== undefined) return own;
    }
    // Pass the whole candidate, never just its title: a rule may be keyed on the
    // challenge's own tags, type, photo count or runtime, and an un-joined
    // candidate carries them. Optional-chained like every other per-challenge
    // settings read here: a partial settings facade (e.g. a stub in a
    // test) must degrade to "no rule", never throw mid-pass.
    const fromRules = settings.resolveRuleSetting?.(key, challenge);
    if (fromRules) return fromRules.value;
    return settings.getEffectiveSetting(key, null);
};

const parseTypeList = (value: unknown): string[] =>
    typeof value === 'string'
        ? value
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter((t) => t !== '')
        : [];

/** The saved title rules, or null when they cannot be read. */
const readTitleRules = () => {
    try {
        return settings.getTitleRules();
    } catch {
        return null;
    }
};

/**
 * Whether one rule turns auto-join ON by itself. Reads the rule's OWN values
 * directly. Going back through the matcher here would be wrong: a `contains`
 * or class-keyed rule has no single challenge to match against at arming time,
 * and a higher rule could win and hide this one's `autoJoin: true`. Arming only
 * asks "could any rule ever turn joining on?", which the rule answers itself.
 *
 * @param readProfiles - lazily loads the profiles map once per scan
 */
const ruleEnablesAutoJoin = (
    rule: TitleRule | null | undefined,
    readProfiles: () => Record<string, ChallengeValues>,
) => {
    if (rule && Object.prototype.hasOwnProperty.call(rule, 'autoJoin')) return rule.autoJoin === true;
    const profileName = typeof rule?.profile === 'string' ? rule.profile : '';
    if (!profileName) return false;
    return readProfiles()[profileName]?.autoJoin === true;
};

/**
 * True when at least one saved rule turns auto-join ON — either inline on the
 * rule or through the named profile it inherits — i.e. some challenge would
 * auto-join even with the master default off. Used only as the pass-level
 * fast-path check.
 *
 * A rule that only adds photo tags (no inline autoJoin, no profile) still
 * returns false, so it must never keep the pass alive every cycle.
 */
const anyTitleRuleEnablesAutoJoin = () => {
    const rules = readTitleRules();
    if (!Array.isArray(rules)) return false;
    let profiles: Record<string, ChallengeValues> | null = null;
    const readProfiles = () => {
        profiles = profiles || settings.getChallengeProfiles() || {};
        return profiles;
    };
    for (const rule of rules) {
        if (ruleEnablesAutoJoin(rule, readProfiles)) return true;
    }
    return false;
};

/**
 * Whether auto-join is armed at all — the master default is on, OR some rule
 * enables it (inline or via its profile). Mirrors the pass short-circuit
 * condition; used to drive the "auto-join active" UI indicator so it reflects
 * the per-rule case too.
 */
const isAutoJoinActive = (): boolean => {
    if (settings.getEffectiveSetting('autoJoin', null) === true) return true;
    return anyTitleRuleEnablesAutoJoin();
};

/**
 * A rule opt-in deliberate enough to bypass the type filters — see
 * `hasRuleJoinOptIn` in settings/titleRules.ts: the rules resolve `autoJoin` to true, or
 * the applying profile comes from a rule naming a title or challenge tag.
 *
 * An inline WINDOW alone is deliberately not enough — "join this late" says
 * when, not whether, so it must not smuggle an excluded type into scope.
 */
const hasTitleOptIn = (challenge: Challenge) => settings.hasRuleJoinOptIn?.(challenge) === true;

/**
 * Per-candidate scope/coin/timing config, resolved by rule (inline → profile → global).
 */
const resolveCandidateConfig = (challenge: Challenge) => {
    // The timing keys go through the one-group read: the first source that sets
    // any of them supplies all three, a key its source does not set counts as 0,
    // and the global read is NOT consulted for it. Null (no source sets any
    // timing key) leaves each key on the global default, like every per-key
    // read here.
    const group = settings.resolveRuleSettingGroup?.(JOIN_TIMING_KEYS, challenge) ?? null;
    const timingValue = (key: string): unknown =>
        group === null ? settings.getEffectiveSetting(key, null) : (group.values[key] ?? 0);
    return {
        // Empty include list = all types (the default scope once auto-join is on).
        includeTypes: parseTypeList(resolveJoinSetting('autoJoinTypes', challenge)),
        excludeTypes: parseTypeList(resolveJoinSetting('autoJoinExcludeTypes', challenge)),
        // The challenge's OWN tags (Exhibition / Comm / Turbo / …), not photo tags.
        includeTags: parseTypeList(resolveJoinSetting('autoJoinChallengeTags', challenge)),
        excludeTags: parseTypeList(resolveJoinSetting('autoJoinExcludeChallengeTags', challenge)),
        maxCoins: Number(resolveJoinSetting('autoJoinMaxCoins', challenge)) || 0,
        // The three timing values above resolve to ONE window in a fixed order —
        // after-start → percent → before-end, the first above 0 applies
        // (resolveJoinWindow) — so a category row saying "90%" fully replaces an
        // inherited hours window rather than intersecting with it, and a
        // non-finite/negative value degrades to 0 = "no window", i.e. join as
        // soon as seen.
        // Hours → seconds, to match close_time's unit.
        joinWithinSec: Math.max(0, Number(timingValue('autoJoinWithinHoursOfEnd')) || 0) * 3600,
        joinAfterPercentElapsed: Math.max(0, Number(timingValue('autoJoinAfterPercentElapsed')) || 0),
        // Hours-from-start anchor, converted like joinWithinSec: hours → seconds,
        // to match start_time's unit.
        joinAfterSecFromStart: Math.max(0, Number(timingValue('autoJoinAfterHoursFromStart')) || 0) * 3600,
        hasProfileMatch: hasTitleOptIn(challenge),
    };
};

/**
 * Report a candidate the join window could not evaluate.
 *
 * The live get_member_challenges response DOES carry close_time AND start_time
 * on every open challenge — verified 2026-09-19 — so this should never fire in
 * practice. `reason` names which of the two the gate could not read (the
 * percent-elapsed and after-start anchors read start_time). It stays because the fail-closed gate skips such a candidate, which
 * would otherwise be indistinguishable from "nothing to join": if GuruShots ever
 * drops or renames the field, the window would silently stop every join. Naming
 * the fields that ARE present makes that diagnosable from one run.
 */
const warnMissingCloseTime = (challenge: Challenge, reason: string) => {
    const fields = Object.keys(challenge || {}).join(', ') || '(none)';
    // start_time is read by the percent-elapsed and after-start anchors, so name the field
    // the gate actually could not read rather than a generic "timing" message.
    const field = reason === 'start-time-unknown' ? 'start_time' : 'close_time';
    cat().warning(
        `join window set but ${logger.challengeTag(challenge)} has no readable ${field} — ` +
            `candidate deferred. Fields present: ${fields}`,
        null,
    );
};

export {
    PER_ID_JOIN_KEYS,
    resolveJoinSetting,
    anyTitleRuleEnablesAutoJoin,
    isAutoJoinActive,
    resolveCandidateConfig,
    warnMissingCloseTime,
};
