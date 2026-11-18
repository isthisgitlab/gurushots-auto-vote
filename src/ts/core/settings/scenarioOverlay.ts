/**
 * The scenario phase overlay: while a challenge is in a phase of its assigned scenario, that phase's own values win
 * over every other layer for that challenge (the manual per-challenge override included) — the scenario is the user's
 * plan for it. Leaving the phase, or the scenario, returns every setting to its normal value; nothing is ever copied
 * into stored overrides.
 *
 * A phase has up to four sources, highest first:
 *   - the runtime patch (`phasePatch` in the progress record: what `setSetting` actions changed for this phase entry),
 *   - its literals (`settings`) and its bindings (`bindings`: values worked out from base settings and raw facts when
 *     the phase is published; a key is one or the other),
 *   - the one saved challenge profile it selects (`profile`), or the one a `useProfile` action chose for this phase
 *     entry instead (`phaseProfile`).
 * Below them is the normal resolution (the "base" view: override, rules, defaults).
 *
 * A phase with literals only needs nothing else: they are read straight from the document. A phase with bindings or a
 * profile, or that holds a runtime patch or profile, is read through the overlay its owner published into the scenario ledger (types/stores.ts
 * ScenarioPublication): the resolved binding values, validated against the phase and profile as they are now. A
 * publication that is missing, malformed, for another phase entry, made from another document or profile, or expired
 * is unavailable, and an unavailable overlay never falls back to inherited values: a read of a setting the phase may
 * write throws ScenarioSettingUnavailableError, and the status reads answer unknown with the reason.
 *
 * No overlay applies when the challenge's scenario was started for a different scenario, or sits in a phase the
 * scenario no longer has — the engine restarts or halts such a challenge, and the settings stay normal. A scenario
 * state that cannot be read applies none either, unless the scenario has a phase with bindings or a profile: then the
 * challenge is unavailable, because which phase it is in cannot be known.
 *
 * The installation scenario's current phase overlays installation settings from one publication in the `@installation`
 * record (installationLayer). There the phase's literals are published too (a publication is the proof that the values
 * were checked together, atomic pairs included), and any key the phase sets or binds is read through it: no installation
 * scenario, a paused one, or a phase that does not set the key leaves the saved value; a missing, mismatched, expired
 * or unreadable publication of a key the phase sets is unavailable, never the saved value.
 */

import { INSTALLATION_KEY, ledgerFor as modeLedger } from '../scenarioStateStore';
import { isPlainObject } from '../plainObject';
import { storedSettingValue } from '../scenarios/expressions';
import { challengeValueSetIsValid, globalChallengeValues } from './defaults';
import { appValueAllowed } from './loadValidation';
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
const ledgerFor = (settings: ConfigV2) => modeLedger(settings.app.mock === true);

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
    /** The challenge id, or `@installation` for an installation setting. */
    readonly challengeId: string;
    readonly reason: string;

    constructor(settingKey: string, challengeId: string, reason: string) {
        super(
            challengeId === INSTALLATION_KEY
                ? `${settingKey} is unavailable for the installation: ${reason}`
                : `${settingKey} is unavailable for challenge ${challengeId}: ${reason}`,
        );
        this.name = 'ScenarioSettingUnavailableError';
        this.settingKey = settingKey;
        this.challengeId = challengeId;
        this.reason = reason;
    }
}

/** The sources of an overlay, resolved: what a read goes through. */
type ResolvedOverlay = {
    /** The runtime patch of this phase entry (above everything the document gives). */
    patch: Record<string, unknown>;
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

/** What a record changed at run time for its phase entry: the patch and the profile (types/stores.ts). */
type RuntimeChange = Pick<ScenarioState, 'phasePatch' | 'phaseProfile'>;

/**
 * The profile a phase uses: the one a `useProfile` action chose for this phase entry (none, when it chose none), else the
 * one the phase names.
 */
const profileOf = (phase: ScenarioPhase, change?: RuntimeChange): string | undefined =>
    change?.phaseProfile === undefined ? phase.profile : (change.phaseProfile ?? undefined);

const hasPatch = (change?: RuntimeChange): boolean => Object.keys(change?.phasePatch ?? {}).length > 0;

/**
 * Whether a phase is read through a publication: it has bindings or a profile, or its entry holds a runtime patch or a
 * runtime profile.
 */
const isBoundPhase = (phase: ScenarioPhase, change?: RuntimeChange): boolean =>
    phase.profile !== undefined ||
    Object.keys(phase.bindings ?? {}).length > 0 ||
    hasPatch(change) ||
    change?.phaseProfile !== undefined;

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
 * A hash of what a publication of this phase depends on: the phase's definition and the profile it selects, as stored, and
 * what the record changed at run time (the patch and the chosen profile). An edit to any makes a publication made before it
 * unavailable until the owner publishes again.
 */
const phaseFingerprint = (
    settings: ConfigV2,
    scenario: ScenarioDocument,
    phaseName: string,
    change?: RuntimeChange,
): string => {
    const phase = scenario.phases[phaseName];
    const profile = profileOf(phase, change);
    return hashText(
        stableJson({
            scenario: scenario.name,
            phase: phaseName,
            literals: phase.settings,
            bindings: phase.bindings,
            profile: profile === undefined ? null : [profile, storedProfile(settings, profile)],
            // Only a record that changed something at run time adds to what a publication is made from.
            patch: hasPatch(change) ? change?.phasePatch : undefined,
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
 * Whether a saved profile can be a phase's profile (a `useProfile` action's check): it exists, reads as a valid profile, and
 * sets only keys a phase may change (never the scenario assignment or Manual Only). The name as saved when it can.
 */
const checkPhaseProfileIn = (
    settings: ConfigV2,
    name: string,
): { ok: true; name: string } | { ok: false; reason: string } => {
    const key = findProfileKey(settings.profiles, normalizeProfileName(name));
    if (key === null) return { ok: false, reason: `there is no profile named "${name}"` };
    const values = sanitizeProfileValues(settings.profiles[key], true, globalChallengeValues(settings), false);
    if (values === null) return { ok: false, reason: `the profile "${key}" is not valid` };
    const forbidden = Object.keys(values).find(
        (settingKey) => !scenarioCapability(settingKey)?.phaseWrite.includes('challenge'),
    );
    return forbidden === undefined
        ? { ok: true, name: key }
        : { ok: false, reason: `the profile "${key}" sets ${forbidden}, which a phase cannot change` };
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
    if (published.documentFingerprint !== phaseFingerprint(settings, scenario, state.phase, state)) {
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
    const profileName = profileOf(phase, state);
    if (profileName !== undefined) {
        const resolved = resolvePhaseProfile(settings, profileName);
        if (!resolved.ok) return resolved;
        profile = resolved.value;
    }
    if ((profile?.name ?? null) !== published.profile) {
        return { ok: false, reason: 'the published settings name another profile' };
    }
    return {
        ok: true,
        value: {
            patch: { ...state.phasePatch },
            literals: phase.settings ?? {},
            bindings: { ...published.bindings },
            profile,
        },
    };
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
        return Object.values(scenario.phases).some((phase) => isBoundPhase(phase))
            ? { kind: 'unreadable', reason: 'the saved progress of this challenge cannot be read' }
            : { kind: 'none' };
    }
    if (!state || normalizeProfileName(state.scenario) !== normalizeProfileName(scenario.name)) {
        return { kind: 'none' };
    }
    const phase = scenario.phases[state.phase];
    if (!phase) return { kind: 'none' };
    const bound = isBoundPhase(phase, state);
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
                : { ok: true, value: { patch: {}, literals: phase.settings ?? {}, bindings: {}, profile: null } },
        },
    };
};

/**
 * What the overlay of a layer gives for a key, or null when it does not set it. The phase's literals and bindings are
 * one source, its profile the next. A phase with bindings or a profile resolves a group of settings as one
 * (OVERLAY_GROUPS): the first source that sets any member owns the group, and a member it omits reads as 0.
 */
const readOverlay = (overlay: ResolvedOverlay, bound: boolean, key: string): { value: unknown } | null => {
    const { patch, literals, bindings, profile } = overlay;
    const sets = (source: 'patch' | 'phase' | 'profile', member: string): boolean => {
        if (source === 'patch') return hasOwn(patch, member);
        return source === 'phase'
            ? hasOwn(literals, member) || hasOwn(bindings, member)
            : profile !== null && hasOwn(profile.values, member);
    };
    const members = (bound ? OVERLAY_GROUPS.find((group) => group.includes(key)) : undefined) ?? [key];
    const owner = (['patch', 'phase', 'profile'] as const).find((source) =>
        members.some((member) => sets(source, member)),
    );
    if (owner === undefined) return null;
    if (!sets(owner, key)) return { value: 0 };
    if (owner === 'patch') return { value: patch[key] };
    if (owner === 'profile') return { value: (profile as NonNullable<typeof profile>).values[key] };
    return { value: hasOwn(literals, key) ? literals[key] : bindings[key] };
};

const readLayer = (layer: PhaseLayer, key: string): { value: unknown } | null =>
    layer.overlay.ok ? readOverlay(layer.overlay.value, layer.bound, key) : null;

/**
 * The keys each source of a layer's overlay sets, for the status reads.
 */
const overlaySources = (
    layer: PhaseLayer,
): { patch: string[]; literals: string[]; bindings: string[]; profile: string[] } => {
    const overlay = layer.overlay.ok ? layer.overlay.value : null;
    return {
        patch: Object.keys(overlay?.patch ?? layer.state.phasePatch ?? {}),
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
    state: Pick<ScenarioState, 'phase' | 'phaseEnteredAt' | 'published' | 'phasePatch' | 'phaseProfile'>,
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
    const profileName = profileOf(phase, state);
    if (profileName !== undefined) {
        const resolved = resolvePhaseProfile(settings, profileName);
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
    const patch = { ...state.phasePatch };
    const candidates: ChallengeValues = { ...profile?.values, ...literals, ...bindings, ...patch };
    const context = { ...base, ...candidates };
    // A patch is the top tier: a key a phase may not write, or a value that does not hold, is refused like a binding.
    for (const key of Object.keys(patch)) {
        if (!scenarioCapability(key)?.phaseWrite.includes('challenge')) {
            return refuse(key, 'not a setting a phase may change');
        }
    }
    for (const key of [...Object.keys(bindings), ...Object.keys(patch)]) {
        const value = hasOwn(patch, key) ? patch[key] : bindings[key];
        if (!validateSetting(key, value, context)) return refuse(key, String(getValidationError(key, value, context)));
    }
    if (!challengeValueSetIsValid(context, candidates, challengeId)) {
        return refuse(
            Object.keys(patch)[0] ?? Object.keys(bindings)[0] ?? null,
            'these values conflict with each other or with the settings they combine with',
        );
    }
    return {
        ok: true,
        overlay: { patch, literals, bindings, profile },
        publication: {
            revision: (state.published?.revision ?? 0) + 1,
            documentFingerprint: phaseFingerprint(settings, scenario, state.phase, state),
            phase: state.phase,
            phaseEnteredAt: state.phaseEnteredAt,
            observedAt: now,
            validUntil,
            bindings,
            profile: profile?.name ?? null,
        },
    };
};

// --- the installation scenario's overlay -------------------------------------------------------------------------------

/** What an installation publication stands for: the runtime patch, the phase's own literals and the resolved binding values. */
type InstallationOverlayValues = {
    patch: Record<string, unknown>;
    literals: Record<string, unknown>;
    bindings: Record<string, unknown>;
};

/** What the installation scenario overlays: nothing, or the keys of its current phase and the overlay to read them from. */
type InstallationLayer =
    | { kind: 'none' }
    | {
          kind: 'phase';
          /** The keys the phase sets or binds. */
          keys: ReadonlySet<string>;
          overlay: { ok: true; value: InstallationOverlayValues } | { ok: false; reason: string };
      }
    | { kind: 'unreadable'; reason: string; keys: ReadonlySet<string> };

/** The keys one phase of an installation scenario sets or binds, or its record patched: what its overlay reaches. */
const installationPhaseKeys = (phase: ScenarioPhase, change?: RuntimeChange): string[] => [
    ...new Set([
        ...Object.keys(change?.phasePatch ?? {}),
        ...Object.keys(phase.settings ?? {}),
        ...Object.keys(phase.bindings ?? {}),
    ]),
];

/** Whether a phase of an installation scenario overlays anything: it is then read through a publication. */
const overlaysInstallation = (phase: ScenarioPhase, change?: RuntimeChange): boolean =>
    installationPhaseKeys(phase, change).length > 0;

/**
 * Reads the installation's published overlay if it is valid now: the owner generation it was made under, the phase entry,
 * the document it was made from, and its clock. Pure over the loaded configuration and the record.
 *
 * @param assignedGeneration - the generation the configuration's assignment is at
 * @param state - the installation's record when it is the assigned scenario's, else null (nothing was started)
 * @param now - unix seconds
 */
const readInstallationPublication = (
    settings: ConfigV2,
    scenario: ScenarioDocument,
    assignedGeneration: number,
    phaseName: string,
    state: ScenarioState | null,
    now: number,
): { ok: true; value: InstallationOverlayValues } | { ok: false; reason: string } => {
    const phase = scenario.phases[phaseName];
    if (state?.publicationUnreadable)
        return { ok: false, reason: 'the published settings of this phase are malformed' };
    const published = state?.published;
    if (!state || !published) return { ok: false, reason: 'nothing is published for this phase yet' };
    // The record is advanced before the configuration at every change of owner, so the later of the two is current.
    const generation = Math.max(state.generation ?? 0, assignedGeneration);
    if (published.generation !== generation) {
        return { ok: false, reason: 'the published settings were made under another owner of the installation' };
    }
    if (published.phase !== state.phase || published.phaseEnteredAt !== state.phaseEnteredAt) {
        return { ok: false, reason: 'the published settings are from an earlier visit to a phase' };
    }
    if (published.documentFingerprint !== phaseFingerprint(settings, scenario, phaseName, state)) {
        return { ok: false, reason: 'the scenario changed after its settings were published' };
    }
    if (published.validUntil !== null && published.validUntil <= now) {
        return { ok: false, reason: 'the published settings of this phase have expired' };
    }
    const boundKeys = Object.keys(phase.bindings ?? {});
    if (
        boundKeys.length !== Object.keys(published.bindings).length ||
        boundKeys.some((key) => !hasOwn(published.bindings, key))
    ) {
        return { ok: false, reason: 'the published settings do not match the bindings of this phase' };
    }
    return {
        ok: true,
        value: { patch: { ...state.phasePatch }, literals: phase.settings ?? {}, bindings: { ...published.bindings } },
    };
};

/**
 * What the installation scenario overlays now. No overlay is expected without an assignment, for a scenario that does not
 * run (unknown, or not an installation one), while the installation is paused (a known withdrawal: the saved values
 * apply at once), or when the current phase sets nothing. With no record of the assigned scenario (a scenario never
 * started) its start phase is the one whose settings are expected. The assignment is checked first: an installation
 * with none never reads the progress record.
 *
 * @param now - unix seconds
 */
const installationLayer = (settings: ConfigV2, now: number): InstallationLayer => {
    const assignment = settings.installationScenario;
    if (!assignment) return { kind: 'none' };
    const scenario = findStoredScenario(settings, assignment.scenario);
    if (!scenario || scenario.scope !== 'installation') return { kind: 'none' };
    const { corrupt, state } = ledgerFor(settings).get(INSTALLATION_KEY);
    if (corrupt) {
        const keys = new Set(Object.values(scenario.phases).flatMap((phase) => installationPhaseKeys(phase)));
        return keys.size === 0
            ? { kind: 'none' }
            : { kind: 'unreadable', reason: 'the saved progress of the installation scenario cannot be read', keys };
    }
    if (state?.paused) return { kind: 'none' };
    const recorded = state !== null && normalizeProfileName(state.scenario) === normalizeProfileName(scenario.name);
    const phaseName = recorded ? state.phase : scenario.start;
    const phase = scenario.phases[phaseName];
    if (!phase) return { kind: 'none' };
    const keys = new Set(installationPhaseKeys(phase, recorded ? state : undefined));
    if (keys.size === 0) return { kind: 'none' };
    return {
        kind: 'phase',
        keys,
        overlay: readInstallationPublication(
            settings,
            scenario,
            assignment.generation,
            phaseName,
            recorded ? state : null,
            now,
        ),
    };
};

/** What a read of one installation setting finds in the overlay. */
type InstallationFinding =
    | { kind: 'saved' }
    | { kind: 'overlay'; value: unknown }
    | { kind: 'unavailable'; reason: string };

const readInstallationLayer = (layer: InstallationLayer, key: string): InstallationFinding => {
    if (layer.kind === 'none' || !layer.keys.has(key)) return { kind: 'saved' };
    if (layer.kind === 'unreadable') return { kind: 'unavailable', reason: layer.reason };
    if (!layer.overlay.ok) return { kind: 'unavailable', reason: layer.overlay.reason };
    const { patch, literals, bindings } = layer.overlay.value;
    if (hasOwn(patch, key)) return { kind: 'overlay', value: patch[key] };
    return { kind: 'overlay', value: hasOwn(literals, key) ? literals[key] : bindings[key] };
};

/**
 * Settings that are valid only as a whole: the check frequency's two ends, and the three API transport values (a request
 * runs under all of them at once).
 */
const INSTALLATION_ATOMIC_GROUPS: ReadonlyArray<{
    keys: readonly string[];
    holds: (values: Record<string, unknown>) => boolean;
}> = [
    {
        keys: ['checkFrequencyMin', 'checkFrequencyMax'],
        holds: (values) => Number(values.checkFrequencyMin) <= Number(values.checkFrequencyMax),
    },
    {
        keys: ['apiTimeout', 'apiMaxRetries', 'apiRetryBaseDelayMs'],
        holds: (values) =>
            ['apiTimeout', 'apiMaxRetries', 'apiRetryBaseDelayMs'].every((key) => appValueAllowed(key, values[key])),
    },
];

/**
 * Prepares the installation overlay of the current phase from the binding values its owner resolved: converts each to the
 * setting's stored form, validates every value (a schema setting by its validation against the values it combines with, an
 * app setting by its range), and the atomic groups as a whole. Nothing partial: one binding that is not known or does not
 * fit, or one value or group that is invalid, refuses the whole phase.
 *
 * @param base - the raw saved value of every setting (what the overlay sits on)
 * @param bound - the resolved value of each binding of the phase
 * @param generation - the installation generation the owner prepares this under
 * @param now - unix seconds
 */
const prepareInstallationOverlay = (
    settings: ConfigV2,
    scenario: ScenarioDocument,
    state: Pick<ScenarioState, 'phase' | 'phaseEnteredAt' | 'published' | 'phasePatch'>,
    base: Record<string, unknown>,
    bound: Record<string, ValueState<ExprValue>>,
    generation: number,
    validUntil: number | null,
    now: number,
):
    | { ok: true; overlay: InstallationOverlayValues; publication: ScenarioPublication }
    | { ok: false; key: string | null; reason: string } => {
    const phase = scenario.phases[state.phase];
    const refuse = (key: string | null, reason: string) => ({ ok: false as const, key, reason });
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
    const patch = { ...state.phasePatch };
    const candidates: Record<string, unknown> = { ...literals, ...bindings, ...patch };
    const context = { ...base, ...candidates };
    // A patch is the top tier: a key an installation phase may not write is refused.
    for (const key of Object.keys(patch)) {
        if (!scenarioCapability(key)?.phaseWrite.includes('installation')) {
            return refuse(key, 'not a setting a phase may change');
        }
    }
    for (const key of Object.keys(candidates)) {
        const allowed = schemaEntry(key)
            ? validateSetting(key, candidates[key], context)
            : appValueAllowed(key, candidates[key]);
        if (!allowed) {
            return refuse(key, String(getValidationError(key, candidates[key], context) ?? `${key} is out of range`));
        }
    }
    for (const group of INSTALLATION_ATOMIC_GROUPS) {
        const touched = group.keys.find((key) => hasOwn(candidates, key));
        if (touched !== undefined && !group.holds(context)) {
            return refuse(touched, `${group.keys.join(' and ')} do not hold together`);
        }
    }
    return {
        ok: true,
        overlay: { patch, literals, bindings },
        publication: {
            revision: (state.published?.revision ?? 0) + 1,
            documentFingerprint: phaseFingerprint(settings, scenario, state.phase, state),
            phase: state.phase,
            phaseEnteredAt: state.phaseEnteredAt,
            observedAt: now,
            validUntil,
            bindings,
            profile: null,
            generation,
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
    checkPhaseProfileIn,
    hasOwn,
    installationLayer,
    installationPhaseKeys,
    isBoundPhase,
    isOverlayKey,
    profileOf,
    overlaysInstallation,
    phaseFingerprint,
    prepareInstallationOverlay,
    prepareOverlay,
    overlaySources,
    readInstallationLayer,
    readLayer,
    readOverlay,
    readPublication,
    subjectLayer,
};
export type { InstallationLayer, ResolvedOverlay, SubjectLayer };
