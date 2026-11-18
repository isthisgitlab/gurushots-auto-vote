/**
 * The scenario phase overlay: while a challenge is in a phase of its assigned scenario, that phase's own values win
 * over every other layer for that challenge (the manual per-challenge override included) — the scenario is the user's
 * plan for it. Leaving the phase, or the scenario, returns every setting to its normal value; nothing is ever copied
 * into stored overrides.
 *
 * A phase has up to three sources, highest first:
 *   - its literals (`settings`) and its bindings (`bindings`: values worked out from base settings and raw facts when
 *     the phase is published; a key is one or the other),
 *   - the one saved challenge profile it selects (`profile`).
 * Below them is the normal resolution (the "base" view: override, rules, defaults).
 *
 * A phase with literals only needs nothing else: they are read straight from the document. A phase with bindings or a
 * profile is read through the overlay its owner published into the scenario ledger (types/stores.ts
 * ScenarioPublication): the resolved binding values, validated against the phase and profile as they are now. A
 * publication that is missing, malformed, for another phase entry, made from another document or profile, or expired
 * is unavailable, and an unavailable overlay never falls back to inherited values: a read of a setting the phase may
 * write throws ScenarioSettingUnavailableError, and the status reads answer unknown with the reason.
 *
 * No overlay applies when the challenge's scenario was started for a different scenario, or sits in a phase the
 * scenario no longer has — the engine restarts or halts such a challenge, and the settings stay normal. A scenario
 * state that cannot be read applies none either, unless the scenario has a phase with bindings or a profile: then the
 * challenge is unavailable, because which phase it is in cannot be known.
 */

import { scenarioStateLedger, mockScenarioStateLedger } from '../scenarioStateStore';
import { isPlainObject } from '../plainObject';
import { storedSettingValue } from '../scenarios/expressions';
import { challengeValueSetIsValid, globalChallengeValues } from './defaults';
import { findProfileKey, normalizeProfileName, sanitizeProfileValues } from './profileStore';
import { findStoredScenario, hasStoredScenarios } from './scenarios';
import { scenarioCapability } from './scenarioCapabilities';
import { getValidationError, schemaEntry, validateSetting } from './schema';

import type { ExprValue } from '../scenarios/expressions';
import type { ValueState } from '../scenarios/valueState';
import type { ConfigV2 } from '../types/config';
import type { ChallengeValues } from '../types/settings';
import type { ScenarioPublication, ScenarioState } from '../types/stores';
import type { ScenarioDocument, ScenarioPhase } from './scenarioSchema';

// Mock mode keeps scenario state in memory only (it must never touch the real
// scenarioState.json), so the overlay reads the same ledger the mock pass uses.
/** @param settings */
const ledgerFor = (settings: ConfigV2) => (settings.app.mock === true ? mockScenarioStateLedger : scenarioStateLedger);

/**
 * Settings that resolve as one group: the first source that sets any of them supplies all of them, and a member it
 * leaves out counts as 0 rather than falling through to a lower source, so no second window is smuggled in beside the
 * winning one. The auto-join timing keys (services/joinChallenges/settingsResolution.ts JOIN_TIMING_KEYS resolves the
 * same three for a rule). Applied to a phase that has bindings or a profile.
 */
const OVERLAY_GROUPS: ReadonlyArray<readonly string[]> = [
    ['autoJoinAfterHoursFromStart', 'autoJoinAfterPercentElapsed', 'autoJoinWithinHoursOfEnd'],
];

/**
 * A read of a setting that a phase with bindings or a profile would overlay, with no valid publication to read it from.
 */
class ScenarioSettingUnavailableError extends Error {
    readonly settingKey: string;
    readonly challengeId: string;
    readonly reason: string;

    constructor(settingKey: string, challengeId: string, reason: string) {
        super(`${settingKey} is unavailable for challenge ${challengeId}: ${reason}`);
        this.name = 'ScenarioSettingUnavailableError';
        this.settingKey = settingKey;
        this.challengeId = challengeId;
        this.reason = reason;
    }
}

/** The sources of an overlay, resolved: what a read goes through. */
type ResolvedOverlay = {
    /** The phase's own literals. */
    literals: Record<string, unknown>;
    /** The resolved binding values (the stored form of each setting). */
    bindings: Record<string, unknown>;
    /** The selected profile and its validated values. */
    profile: { name: string; values: ChallengeValues } | null;
};

/** One phase of a challenge's scenario as the overlay reads it. */
type PhaseLayer = {
    scenario: ScenarioDocument;
    phaseName: string;
    phase: ScenarioPhase;
    /** The phase has bindings or a profile, so it is read through a publication. */
    bound: boolean;
    state: ScenarioState;
    /** The overlay to read, or why there is none to read. */
    overlay: { ok: true; value: ResolvedOverlay } | { ok: false; reason: string };
};

/**
 * What a challenge's overlay is: none, a phase layer, or unavailable because the state its phase is read from cannot be
 * read.
 */
type SubjectLayer = { kind: 'none' } | { kind: 'phase'; layer: PhaseLayer } | { kind: 'unreadable'; reason: string };

const hasOwn = (source: object, key: string): boolean => Object.prototype.hasOwnProperty.call(source, key);

/**
 * Whether a phase has bindings or a profile.
 */
const isBoundPhase = (phase: ScenarioPhase): boolean =>
    phase.profile !== undefined || Object.keys(phase.bindings ?? {}).length > 0;

/**
 * Canonical JSON text: object keys in order, so equal documents give equal text.
 */
const stableJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (isPlainObject(value)) {
        const parts = Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
        return `{${parts.join(',')}}`;
    }
    return JSON.stringify(value);
};

const fnv1a = (text: string, seed: number): number => {
    let hash = seed;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
};

/**
 * A short deterministic hash of a text (two 32-bit FNV-1a passes): it tells a changed definition from an unchanged one,
 * it is not a security measure.
 */
const hashText = (text: string): string =>
    fnv1a(text, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a(text, 0x9747b28c).toString(16).padStart(8, '0');

/**
 * The profile a phase selects, as stored: the saved values under the name the phase gives (any casing), or null when
 * there is none.
 */
const storedProfile = (settings: ConfigV2, name: string): unknown => {
    const key = findProfileKey(settings.profiles, normalizeProfileName(name));
    return key === null ? null : settings.profiles[key];
};

/**
 * A hash of what a publication of this phase depends on in the configuration: the phase's definition and the profile it
 * selects, as stored. An edit to either makes a publication made before it unavailable until the owner publishes again.
 */
const phaseFingerprint = (settings: ConfigV2, scenario: ScenarioDocument, phaseName: string): string => {
    const phase = scenario.phases[phaseName];
    return hashText(
        stableJson({
            scenario: scenario.name,
            phase: phaseName,
            literals: phase.settings,
            bindings: phase.bindings,
            profile: phase.profile === undefined ? null : [phase.profile, storedProfile(settings, phase.profile)],
        }),
    );
};

/**
 * The profile a phase selects, validated like an automatic read of a profile (a malformed profile is refused as a whole)
 * and refused when it holds a key a phase may not write: the profile layer is user configuration, and a scenario
 * only selects it.
 */
const resolvePhaseProfile = (
    settings: ConfigV2,
    name: string,
): { ok: true; value: { name: string; values: ChallengeValues } } | { ok: false; reason: string } => {
    const unavailable = { ok: false as const, reason: `profile-unavailable: ${name}` };
    const key = findProfileKey(settings.profiles, normalizeProfileName(name));
    if (key === null) return unavailable;
    const values = sanitizeProfileValues(settings.profiles[key], true, globalChallengeValues(settings), false);
    if (values === null) return unavailable;
    if (Object.keys(values).some((settingKey) => !scenarioCapability(settingKey)?.phaseWrite.includes('challenge'))) {
        return unavailable;
    }
    return { ok: true, value: { name: key, values } };
};

/**
 * Reads a published overlay if it is valid now: the phase entry, the document and profile it was made from, and its
 * clock. Pure over the loaded configuration and the state.
 *
 * @param now - unix seconds
 */
const readPublication = (
    settings: ConfigV2,
    scenario: ScenarioDocument,
    state: ScenarioState,
    now: number,
): { ok: true; value: ResolvedOverlay } | { ok: false; reason: string } => {
    const phase = scenario.phases[state.phase];
    const published = state.published;
    if (state.publicationUnreadable) return { ok: false, reason: 'the published settings of this phase are malformed' };
    if (!published) return { ok: false, reason: 'nothing is published for this phase yet' };
    if (published.phase !== state.phase || published.phaseEnteredAt !== state.phaseEnteredAt) {
        return { ok: false, reason: 'the published settings are from an earlier visit to a phase' };
    }
    if (published.documentFingerprint !== phaseFingerprint(settings, scenario, state.phase)) {
        return { ok: false, reason: 'the scenario or its profile changed after its settings were published' };
    }
    if (published.validUntil !== null && published.validUntil <= now) {
        return { ok: false, reason: 'the published settings of this phase have expired' };
    }
    const boundKeys = Object.keys(phase.bindings ?? {});
    const publishedKeys = Object.keys(published.bindings);
    if (boundKeys.length !== publishedKeys.length || boundKeys.some((key) => !hasOwn(published.bindings, key))) {
        return { ok: false, reason: 'the published settings do not match the bindings of this phase' };
    }
    let profile: { name: string; values: ChallengeValues } | null = null;
    if (phase.profile !== undefined) {
        const resolved = resolvePhaseProfile(settings, phase.profile);
        if (!resolved.ok) return resolved;
        profile = resolved.value;
    }
    if ((profile?.name ?? null) !== published.profile) {
        return { ok: false, reason: 'the published settings name another profile' };
    }
    return { ok: true, value: { literals: phase.settings ?? {}, bindings: { ...published.bindings }, profile } };
};

/**
 * The phase layer of a challenge, or why it is unavailable, or none.
 *
 * @param settings - the loaded configuration
 * @param resolveScenarioName - the challenge's `scenario` setting, resolved without the overlay (only called when any
 *   scenario is stored)
 */
const subjectLayer = (
    settings: ConfigV2,
    challengeId: string,
    resolveScenarioName: () => string,
    now: number,
): SubjectLayer => {
    if (!hasStoredScenarios(settings)) return { kind: 'none' };
    const name = resolveScenarioName();
    if (!name) return { kind: 'none' };
    const scenario = findStoredScenario(settings, name);
    if (!scenario) return { kind: 'none' };
    const { corrupt, state } = ledgerFor(settings).get(challengeId);
    if (corrupt) {
        return Object.values(scenario.phases).some(isBoundPhase)
            ? { kind: 'unreadable', reason: 'the saved progress of this challenge cannot be read' }
            : { kind: 'none' };
    }
    if (!state || normalizeProfileName(state.scenario) !== normalizeProfileName(scenario.name)) {
        return { kind: 'none' };
    }
    const phase = scenario.phases[state.phase];
    if (!phase) return { kind: 'none' };
    const bound = isBoundPhase(phase);
    return {
        kind: 'phase',
        layer: {
            scenario,
            phaseName: state.phase,
            phase,
            bound,
            state,
            overlay: bound
                ? readPublication(settings, scenario, state, now)
                : { ok: true, value: { literals: phase.settings ?? {}, bindings: {}, profile: null } },
        },
    };
};

/**
 * What the overlay of a layer gives for a key, or null when it does not set it. The phase's literals and bindings are
 * one source, its profile the next. A phase with bindings or a profile resolves a group of settings as one
 * (OVERLAY_GROUPS): the first source that sets any member owns the group, and a member it omits reads as 0.
 */
const readOverlay = (overlay: ResolvedOverlay, bound: boolean, key: string): { value: unknown } | null => {
    const { literals, bindings, profile } = overlay;
    const sets = (source: 'phase' | 'profile', member: string): boolean =>
        source === 'phase'
            ? hasOwn(literals, member) || hasOwn(bindings, member)
            : profile !== null && hasOwn(profile.values, member);
    const members = (bound ? OVERLAY_GROUPS.find((group) => group.includes(key)) : undefined) ?? [key];
    const owner = (['phase', 'profile'] as const).find((source) => members.some((member) => sets(source, member)));
    if (owner === undefined) return null;
    if (!sets(owner, key)) return { value: 0 };
    if (owner === 'profile') return { value: (profile as NonNullable<typeof profile>).values[key] };
    return { value: hasOwn(literals, key) ? literals[key] : bindings[key] };
};

const readLayer = (layer: PhaseLayer, key: string): { value: unknown } | null =>
    layer.overlay.ok ? readOverlay(layer.overlay.value, layer.bound, key) : null;

/**
 * The keys each source of a layer's overlay sets, for the status reads.
 */
const overlaySources = (layer: PhaseLayer): { literals: string[]; bindings: string[]; profile: string[] } => {
    const overlay = layer.overlay.ok ? layer.overlay.value : null;
    return {
        literals: Object.keys(overlay?.literals ?? layer.phase.settings ?? {}),
        bindings: Object.keys(overlay?.bindings ?? layer.phase.bindings ?? {}),
        profile: Object.keys(overlay?.profile?.values ?? {}),
    };
};

/**
 * Prepares the overlay of a phase from the binding values its owner resolved: converts each to the setting's stored
 * form, and validates every value (each setting's own validation, then the set as a whole against the base values it
 * combines with). A binding that is not known, does not fit its setting or fails validation, or a profile that cannot
 * be used, makes the whole phase unprepared: it is never a partial overlay.
 *
 * @param base - the raw base values of every setting (what the overlay sits on)
 * @param bound - the resolved value of each binding of the phase
 * @param now - unix seconds
 */
const prepareOverlay = (
    settings: ConfigV2,
    scenario: ScenarioDocument,
    state: Pick<ScenarioState, 'phase' | 'phaseEnteredAt' | 'published'>,
    base: Record<string, unknown>,
    bound: Record<string, ValueState<ExprValue>>,
    challengeId: string,
    validUntil: number | null,
    now: number,
):
    | { ok: true; overlay: ResolvedOverlay; publication: ScenarioPublication }
    | { ok: false; key: string | null; reason: string } => {
    const phase = scenario.phases[state.phase];
    const refuse = (key: string | null, reason: string) => ({ ok: false as const, key, reason });
    let profile: ResolvedOverlay['profile'] = null;
    if (phase.profile !== undefined) {
        const resolved = resolvePhaseProfile(settings, phase.profile);
        if (!resolved.ok) return refuse(null, resolved.reason);
        profile = resolved.value;
    }
    const bindings: Record<string, unknown> = {};
    for (const key of Object.keys(phase.bindings ?? {})) {
        const result = bound[key];
        if (result.state !== 'known') {
            return refuse(key, result.state === 'absent' ? `absent: ${result.reason}` : result.reason);
        }
        // A bound key is one a phase may write, so its capability has a value descriptor.
        const stored = storedSettingValue(
            (scenarioCapability(key) as NonNullable<ReturnType<typeof scenarioCapability>>).value,
            result.value,
        );
        if (!stored.ok) return refuse(key, stored.reason);
        bindings[key] = stored.value;
    }
    const literals = phase.settings ?? {};
    const candidates: ChallengeValues = { ...profile?.values, ...literals, ...bindings };
    const context = { ...base, ...candidates };
    for (const key of Object.keys(bindings)) {
        if (!validateSetting(key, bindings[key], context)) {
            return refuse(key, String(getValidationError(key, bindings[key], context)));
        }
    }
    if (!challengeValueSetIsValid(context, candidates, challengeId)) {
        return refuse(
            Object.keys(bindings)[0] ?? null,
            'these values conflict with each other or with the settings they combine with',
        );
    }
    return {
        ok: true,
        overlay: { literals, bindings, profile },
        publication: {
            revision: (state.published?.revision ?? 0) + 1,
            documentFingerprint: phaseFingerprint(settings, scenario, state.phase),
            phase: state.phase,
            phaseEnteredAt: state.phaseEnteredAt,
            observedAt: now,
            validUntil,
            bindings,
            profile: profile?.name ?? null,
        },
    };
};

/**
 * A key a phase overlay can reach: a per-challenge key other than the assignment itself.
 */
const isOverlayKey = (key: string): boolean => schemaEntry(key)?.perChallenge === true && key !== 'scenario';

export {
    ScenarioSettingUnavailableError,
    OVERLAY_GROUPS,
    hasOwn,
    isBoundPhase,
    isOverlayKey,
    phaseFingerprint,
    prepareOverlay,
    overlaySources,
    readLayer,
    readOverlay,
    readPublication,
    subjectLayer,
};
export type { ResolvedOverlay, SubjectLayer };
