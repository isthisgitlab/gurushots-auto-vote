/**
 * The 1.x resolver, frozen, as an oracle: given the text of a 1.x `settings.json` and an environment (the active
 * challenge list, the scenario ledger), what every 1.x read of those settings returned. A blob-in copy of the
 * algorithms in `settings/challengeOverrides.ts`, `ruleResolution.ts`, `titleRules.ts`, `challengeFacts.ts`,
 * `scenarioOverlay.ts`, `scenarios.ts`, `entryPins.ts`, `titlePins.ts`, `services/joinChallenges/settingsResolution.ts`,
 * `services/scenarioStatus.ts` and `react/hooks/useCustomizedChallengeIds.ts` as of the last 1.x release, over the
 * frozen schema and load pipeline in `src/ts/settings/importV1/`. It reads nothing from the live settings code, so a
 * change to the live resolver or to the stored format cannot change what it answers.
 */

import { isPlainObject } from '../../../src/ts/plainObject';
import { interpretV1Settings, parseV1Settings } from '../../../src/ts/settings/importV1';
import { pruneV1Obsolete } from '../../../src/ts/settings/importV1/loadValidation';
import { v1SchemaEntry } from '../../../src/ts/settings/importV1/schema';
import { matchingRules, ruleConditions } from './ruleMatching';
import { validatedScenario } from './scenarioDocument';
import {
    findProfileKey,
    globalChallengeValues,
    hasPostJoinInlineValue,
    normalizeProfileName,
    RESERVED_PROFILE_NAMES,
    readProfilesMap,
    sanitizeProfileValues,
    sanitizeTitleRuleInline,
} from './values';

import type { V1Blob, V1Values } from '../../../src/ts/settings/importV1/types';
import type { MatchTarget } from './ruleMatching';
import type { OracleScenario } from './scenarioDocument';

const MAX_TITLE_LENGTH = 200;
const MAX_ACTIVE_CHALLENGES = 200;
const MAX_CHALLENGE_TAGS = 24;
const DEFAULT_TIMEZONE = 'Europe/Riga';

/** The scenario state of one challenge as the ledger answers it. */
type LedgerEntry = {
    corrupt: false | 'file' | 'record' | 'unloaded';
    state: { scenario: string; phase: string } | null;
};

/** What the 1.x resolver sees besides the file: the active challenge list and the scenario ledger. */
type OracleEnv = {
    /** The frozen clock (epoch seconds). The resolver never reads the clock; it anchors the challenges' times. */
    now: number;
    /** The active-challenge list `rememberChallengeTitles` was given. */
    challenges: MatchTarget[];
    /** The ledger by challenge id; an id it has no entry for has no state. */
    ledger: Record<string, LedgerEntry>;
};

type ChallengeFacts = {
    tags: string[];
    type?: string;
    max_photo_submits?: number | null;
    start_time?: number | null;
    close_time?: number | null;
};

type RuleSource = { title?: string; index: number; viaProfile?: boolean };
type RuleProfile = { name: string; values: V1Values; rule: unknown };
type RuleValues = { values: V1Values; profile: RuleProfile | null; sources: Record<string, RuleSource> };
type TitleProfileInfo = {
    profile: { name: string; values: V1Values } | null;
    suppressed: boolean;
    ruleValues: V1Values;
    inlineValues: V1Values;
    ruleSources: Record<string, RuleSource>;
    inlineSources: Record<string, RuleSource>;
};
type Customization = 'manual' | 'profile' | 'both' | 'rule' | null;
type ScenarioStatus = {
    assigned: string;
    scenario: string | null;
    phase: string | null;
    corrupt: LedgerEntry['corrupt'];
    phaseMissing: boolean;
};

const finiteOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

const observedTitle = (challenge: MatchTarget): string | null => {
    const title = typeof challenge?.title === 'string' ? challenge.title.trim() : '';
    return title && title.length <= MAX_TITLE_LENGTH ? title : null;
};

const observedFacts = (challenge: MatchTarget): ChallengeFacts => {
    const type = typeof challenge?.type === 'string' ? challenge.type.trim() : '';
    const tags: unknown[] = Array.isArray(challenge?.tags) ? challenge.tags : [];
    return {
        tags: tags
            .slice(0, MAX_CHALLENGE_TAGS)
            .filter(
                (tag): tag is string => typeof tag === 'string' && tag.trim() !== '' && tag.length <= MAX_TITLE_LENGTH,
            )
            .map((tag) => tag.trim()),
        type: type.length <= MAX_TITLE_LENGTH ? type : '',
        max_photo_submits: finiteOrNull(challenge?.max_photo_submits),
        start_time: finiteOrNull(challenge?.start_time),
        close_time: finiteOrNull(challenge?.close_time),
    };
};

const ENTRY_PIN_KINDS = ['boost', 'turbo'] as const;
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TAG_KEYS = ['mustIncludeTags', 'shouldIncludeTags'];
const PER_ID_JOIN_KEYS = ['chosenPhotos', 'chosenPhotosOnly', 'chosenPhotosInOrder', 'manualPhotosOnly'];

const idKey = (challengeId: string | number | null | undefined): string =>
    challengeId === null || challengeId === undefined ? '' : String(challengeId);

const isUnsafeKey = (key: string): boolean => key === '__proto__' || key === 'constructor' || key === 'prototype';

/**
 * The oracle for the text of a 1.x settings file: what the frozen load pipeline makes of it (merge, the eight
 * migrations, validation, prune) read by the 1.x resolver. Throws when the file is not a settings object or a
 * migration cannot handle it.
 */
const createV1Oracle = (raw: string, env: OracleEnv) => {
    const parsed = parseV1Settings(raw);
    if (!parsed.ok) throw new Error(`not a settings file: ${parsed.reason}`);
    const { blob } = interpretV1Settings(parsed.value);
    pruneV1Obsolete(blob);
    return oracleOverBlob(blob, env);
};

const oracleOverBlob = (blob: V1Blob, env: OracleEnv) => {
    const { challengeSettings } = blob;

    // The active-challenge cache (settings/challengeFacts.ts).
    const activeTitles = new Map<string, string | null>();
    const activeFacts = new Map<string, ChallengeFacts>();
    for (const challenge of env.challenges.slice(0, MAX_ACTIVE_CHALLENGES)) {
        if (challenge?.id === null || challenge?.id === undefined) continue;
        const id = String(challenge.id);
        if (!id || activeTitles.has(id)) continue;
        activeTitles.set(id, observedTitle(challenge));
        activeFacts.set(id, observedFacts(challenge));
    }

    const factsFor = (challengeId: string | number | null | undefined): ChallengeFacts => {
        const id = idKey(challengeId);
        return (id && activeFacts.get(id)) || { tags: [] };
    };

    const titleFor = (challengeId: string | number | null | undefined): string => {
        const id = idKey(challengeId);
        if (!id) return '';
        if (activeTitles.has(id)) return activeTitles.get(id) || '';
        const pinned = challengeSettings.titlePins as Record<string, unknown> | null | undefined;
        return pinned &&
            Object.prototype.hasOwnProperty.call(pinned, id) &&
            typeof pinned[id] === 'string' &&
            pinned[id].length < MAX_TITLE_LENGTH
            ? pinned[id]
            : '';
    };

    const targetForId = (challengeId: string | number | null | undefined): MatchTarget => ({
        ...factsFor(challengeId),
        title: titleFor(challengeId),
    });

    const timeZone = (): string => (typeof blob.timezone === 'string' && blob.timezone) || DEFAULT_TIMEZONE;
    const globalValues = globalChallengeValues(blob);
    const ownValues = (challengeId: string | number): V1Values | undefined =>
        Object.hasOwn(challengeSettings.perChallenge, challengeId)
            ? challengeSettings.perChallenge[challengeId]
            : undefined;

    // Profiles (settings/ruleResolution.ts).
    const profileFromMatches = (matches: unknown[]): RuleProfile | null => {
        const rule = matches.find((candidate) =>
            normalizeProfileName(isPlainObject(candidate) ? candidate.profile : undefined),
        );
        if (!rule || !isPlainObject(rule)) return null;
        const normalized = normalizeProfileName(rule.profile);
        if (RESERVED_PROFILE_NAMES.has(normalized)) return null;
        const stored = readProfilesMap(blob);
        const storedKey = findProfileKey(stored, normalized);
        if (storedKey === null) return null;
        const values = sanitizeProfileValues(stored[storedKey], true, globalValues);
        return values === null ? null : { name: storedKey, values, rule };
    };

    const ruleValuesFor = (target: MatchTarget | string | null | undefined, suppressProfile = false): RuleValues => {
        const rules: unknown[] = Array.isArray(challengeSettings.titleRules) ? challengeSettings.titleRules : [];
        const matches = matchingRules(rules as Array<Record<string, unknown>>, target, timeZone());
        const profile = suppressProfile ? null : profileFromMatches(matches);
        const values: V1Values = {};
        const sources: Record<string, RuleSource> = {};
        const sourceOf = (rule: unknown, viaProfile: boolean): RuleSource => {
            const title = isPlainObject(rule) ? rule.title : undefined;
            return {
                ...(typeof title === 'string' && title.trim() !== '' ? { title } : {}),
                index: rules.indexOf(rule) + 1,
                ...(viaProfile ? { viaProfile: true as const } : {}),
            };
        };
        const take = (source: V1Values, from: RuleSource) => {
            for (const [key, value] of Object.entries(source)) {
                if (Object.hasOwn(values, key)) continue;
                values[key] = value;
                sources[key] = from;
            }
        };
        for (const rule of matches) {
            const inline = sanitizeTitleRuleInline(rule);
            if (inline) take(inline, sourceOf(rule, false));
            if (profile && profile.rule === rule) take(profile.values, sourceOf(rule, true));
        }
        return { values, profile, sources };
    };

    const isSuppressed = (challengeId: string | number | null | undefined): boolean => {
        const id = idKey(challengeId);
        const suppressions = challengeSettings.titleProfileSuppressions;
        return Boolean(
            id &&
            isPlainObject(suppressions) &&
            Object.prototype.hasOwnProperty.call(suppressions, id) &&
            suppressions[id] === true,
        );
    };

    const ruleValuesForId = (challengeId: string | number | null | undefined): V1Values =>
        ruleValuesFor(targetForId(challengeId), isSuppressed(challengeId)).values;

    // The scenario overlay (settings/scenarioOverlay.ts, settings/scenarios.ts).
    const scenariosMap = (): Record<string, unknown> =>
        isPlainObject(challengeSettings.scenarios) ? challengeSettings.scenarios : {};
    const validated = new Map<string, OracleScenario | null>();
    const findScenario = (name: unknown): OracleScenario | null => {
        const stored = scenariosMap();
        const key = findProfileKey(stored, normalizeProfileName(name));
        if (key === null) return null;
        if (!validated.has(key)) validated.set(key, validatedScenario(stored[key], globalValues));
        return validated.get(key) ?? null;
    };
    const ledgerOf = (challengeId: string): LedgerEntry =>
        Object.hasOwn(env.ledger, challengeId) ? env.ledger[challengeId] : { corrupt: false, state: null };

    const phaseSettings = (challengeId: string, scenarioName: () => string): Record<string, unknown> | null => {
        if (Object.keys(scenariosMap()).length === 0) return null;
        const name = scenarioName();
        if (!name) return null;
        const scenario = findScenario(name);
        if (!scenario) return null;
        const { corrupt, state } = ledgerOf(challengeId);
        if (corrupt || !state || normalizeProfileName(state.scenario) !== normalizeProfileName(scenario.name))
            return null;
        return scenario.phases[state.phase]?.settings ?? null;
    };

    // Effective values (settings/challengeOverrides.ts).
    const resolveEffective = (key: string, challengeId: string | number | null): unknown => {
        const entry = v1SchemaEntry(key);
        if (!entry) return undefined;
        if (challengeId && entry.perChallenge) {
            const overrides = ownValues(challengeId);
            if (overrides && Object.hasOwn(overrides, key)) return overrides[key];
            const ruleValues = ruleValuesForId(challengeId);
            if (Object.prototype.hasOwnProperty.call(ruleValues, key)) return ruleValues[key];
        }
        if ('challengeOnly' in entry) return entry.default;
        return Object.prototype.hasOwnProperty.call(challengeSettings.globalDefaults, key)
            ? challengeSettings.globalDefaults[key]
            : entry.default;
    };

    const effective = (key: string, challengeId: string | number | null = null): unknown => {
        const entry = v1SchemaEntry(key);
        if (!entry) return undefined;
        if (challengeId && key !== 'scenario' && entry.perChallenge) {
            const overlay = phaseSettings(
                String(challengeId),
                () => resolveEffective('scenario', challengeId) as string,
            );
            if (overlay && Object.prototype.hasOwnProperty.call(overlay, key)) return overlay[key];
        }
        return resolveEffective(key, challengeId);
    };

    const challengeOverride = (key: string, challengeId: string | number): unknown => {
        const overrides = ownValues(challengeId);
        return overrides && Object.hasOwn(overrides, key) ? overrides[key] : null;
    };

    // The profiles list the join arming reads (settings/profiles.ts getChallengeProfiles).
    const profilesList = (): Record<string, V1Values> => {
        const stored = readProfilesMap(blob);
        const profiles: Record<string, V1Values> = {};
        for (const name of Object.keys(stored)) {
            if (RESERVED_PROFILE_NAMES.has(normalizeProfileName(name))) continue;
            profiles[name] = sanitizeProfileValues(stored[name], false, globalValues) ?? {};
        }
        return profiles;
    };

    const titleProfile = (
        target: MatchTarget | string,
        challengeId: string | number | null = null,
    ): TitleProfileInfo => {
        const challenge: Record<string, unknown> = typeof target === 'string' ? { title: target } : { ...target };
        const hasId = challengeId !== null && challengeId !== undefined;
        if (hasId) {
            for (const [key, value] of Object.entries(factsFor(challengeId))) {
                if (challenge[key] === undefined) challenge[key] = value;
            }
        }
        const { values: ruleValues, profile, sources: ruleSources } = ruleValuesFor(challenge);
        const { values: inlineValues, sources: inlineSources } = ruleValuesFor(challenge, true);
        return {
            profile: profile ? { name: profile.name, values: profile.values } : null,
            suppressed: hasId && isSuppressed(challengeId),
            ruleValues,
            inlineValues,
            ruleSources,
            inlineSources,
        };
    };

    const challengeOverrides = (challengeId: string | number): V1Values => {
        const stored = ownValues(challengeId);
        const overrides: V1Values = {};
        if (stored) {
            for (const key of Object.keys(stored)) {
                if (v1SchemaEntry(key)?.perChallenge) overrides[key] = stored[key];
            }
        }
        return overrides;
    };

    // Join (services/joinChallenges/settingsResolution.ts, settings/titleRules.ts).
    const joinSetting = (key: string, challenge: MatchTarget): unknown => {
        if (PER_ID_JOIN_KEYS.includes(key) && challenge?.id !== undefined && challenge?.id !== null) {
            const own = challengeOverride(key, String(challenge.id));
            if (own !== null && own !== undefined) return own;
        }
        const { values } = ruleValuesFor(challenge);
        if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
        return effective(key, null);
    };

    const ruleEnablesAutoJoin = (rule: unknown, readProfiles: () => Record<string, V1Values>): boolean => {
        const fields = isPlainObject(rule) ? rule : {};
        if (Object.prototype.hasOwnProperty.call(fields, 'autoJoin')) return fields.autoJoin === true;
        const profileName = typeof fields.profile === 'string' ? fields.profile : '';
        if (!profileName) return false;
        return readProfiles()[profileName]?.autoJoin === true;
    };

    const anyRuleEnablesAutoJoin = (): boolean => {
        const rules: unknown = challengeSettings.titleRules;
        if (!Array.isArray(rules)) return false;
        let profiles: Record<string, V1Values> | null = null;
        const readProfiles = () => (profiles = profiles || profilesList());
        return rules.some((rule) => ruleEnablesAutoJoin(rule, readProfiles));
    };

    const ruleJoinOptIn = (challenge: MatchTarget): boolean => {
        const { values, profile } = ruleValuesFor(challenge);
        if (values.autoJoin === true) return true;
        if (!profile) return false;
        const conditions = ruleConditions(isPlainObject(profile.rule) ? profile.rule : null);
        return conditions.patterns.length > 0 || Boolean(conditions.tag);
    };

    // The classification of react/hooks/useCustomizedChallengeIds.ts.
    const customization = (challengeId: string, title: string): Customization => {
        const overrides = challengeOverrides(challengeId);
        const rules = titleProfile(title, challengeId);
        const manual = Object.keys(overrides).length > 0;
        const automatic = rules.profile != null && !rules.suppressed;
        if (manual) return automatic ? 'both' : 'manual';
        if (automatic) return 'profile';
        return hasPostJoinInlineValue(rules.inlineValues) ? 'rule' : null;
    };

    // Photo tags and ignore words (settings/titleRules.ts getEffectiveTagSetting / getEffectiveIgnoreTitleWords).
    const ruleTags = (key: string, challenge: MatchTarget | null | undefined): unknown => {
        const challengeId = challenge?.id != null ? String(challenge.id) : null;
        const base = effective(key, challengeId);
        if (!TAG_KEYS.includes(key)) return base;
        const rules: unknown[] = Array.isArray(challengeSettings.titleRules) ? challengeSettings.titleRules : [];
        const rule = matchingRules(rules as Array<Record<string, unknown>>, challenge, timeZone()).find((candidate) => {
            const tags = isPlainObject(candidate) ? candidate[key] : undefined;
            return Array.isArray(tags) && tags.length > 0;
        });
        if (!rule) return base;
        const out: string[] = [];
        const seen = new Set<string>();
        for (const list of [base as string[], rule[key] as unknown[]]) {
            for (const tag of list) {
                if (typeof tag !== 'string' || seen.has(tag)) continue;
                seen.add(tag);
                out.push(tag);
            }
        }
        return out;
    };

    const ignoreTitleWords = (challenge: MatchTarget | null | undefined): unknown[] | null => {
        const challengeId = challenge?.id != null ? String(challenge.id) : null;
        const words = effective('ignoreTitleWords', challengeId);
        return Array.isArray(words) && words.length > 0 ? words : null;
    };

    // Where a challenge is in its assigned scenario (services/scenarioStatus.ts).
    const scenarioStatus = (challengeId: string): ScenarioStatus => {
        const assigned = (effective('scenario', challengeId) as string) || '';
        const scenario = assigned && normalizeProfileName(assigned) ? findScenario(assigned) : null;
        if (!scenario) return { assigned, scenario: null, phase: null, corrupt: false, phaseMissing: false };
        const { corrupt, state } = ledgerOf(challengeId);
        const current = state && state.scenario.toLowerCase() === scenario.name.toLowerCase() ? state : null;
        return {
            assigned,
            scenario: scenario.name,
            phase: current?.phase ?? null,
            corrupt,
            phaseMissing: Boolean(current) && !corrupt && !scenario.phases[current?.phase ?? ''],
        };
    };

    // The pins (settings/entryPins.ts, settings/titlePins.ts).
    const entryPin = (challengeId: string | number): { boost: string | null; turbo: string | null } => {
        const key = String(challengeId).trim();
        const stored = challengeSettings.entryPins;
        const record = key !== '' && !isUnsafeKey(key) && Object.hasOwn(stored, key) ? stored[key] : undefined;
        const pins: { boost: string | null; turbo: string | null } = { boost: null, turbo: null };
        if (isPlainObject(record)) {
            for (const kind of ENTRY_PIN_KINDS) {
                const imageId = Object.hasOwn(record, kind) ? record[kind] : undefined;
                if (typeof imageId === 'string' && IMAGE_ID_PATTERN.test(imageId)) pins[kind] = imageId;
            }
        }
        return pins;
    };

    return {
        effective,
        ruleTags,
        ignoreTitleWords,
        ruleValues: (target: MatchTarget | string, suppress = false) => {
            const { values, profile, sources } = ruleValuesFor(target, suppress);
            return { values, sources, profile: profile ? { name: profile.name, values: profile.values } : null };
        },
        ruleProfile: (target: MatchTarget | string) => {
            const { profile } = ruleValuesFor(target);
            return profile ? { name: profile.name, values: profile.values } : null;
        },
        titleProfile,
        /** The profiles as the settings list shows them: reserved names left out, invalid values dropped. */
        profiles: profilesList,
        challengeOverrides,
        joinSetting,
        anyRuleEnablesAutoJoin,
        autoJoinActive: (): boolean => effective('autoJoin', null) === true || anyRuleEnablesAutoJoin(),
        ruleJoinOptIn,
        customization,
        scenarioStatus,
        entryPin,
        /** The title a challenge is matched on: the active list's, else its pin (as 1.x reads it, by own property). */
        titleOf: (challengeId: string | number): string => titleFor(challengeId),
        /** The stored scenarios the engine may run (a later one of the same name replaces an earlier): their start phase and each phase's setting keys. */
        scenarios: (): Record<string, { start: string; phases: Record<string, string[]> }> => {
            const out: Record<string, { start: string; phases: Record<string, string[]> }> = {};
            for (const raw of Object.values(scenariosMap())) {
                const scenario = validatedScenario(raw, globalValues);
                if (!scenario) continue;
                out[scenario.name] = {
                    start: scenario.start,
                    phases: Object.fromEntries(
                        Object.entries(scenario.phases).map(([name, phase]) => [
                            name,
                            Object.keys(phase.settings ?? {}).sort(),
                        ]),
                    ),
                };
            }
            return out;
        },
    };
};

type V1Oracle = ReturnType<typeof createV1Oracle>;

export { createV1Oracle };
export type { Customization, LedgerEntry, OracleEnv, V1Oracle };
