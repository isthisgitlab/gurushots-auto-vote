/**
 * Schema-based challenge settings: global defaults, id-keyed per-challenge
 * overrides (single-key and batch writes, profile-mode suppression), effective
 * value resolution (scenario phase -> override -> matching rules -> global
 * default), and pruning
 * of overrides for challenges that no longer exist.
 */

import * as logger from '../logger';
import { clockSec } from '../simulationScope';
import { schemaEntry, schemaDefault, getValidationError } from './schema';
import type { SettingKey, SettingsSchemaEntry } from './schema';
import { loadSettings, saveSettings } from './persistence';
import { runGated } from './scenarioMutationGate';
import { valuesEqual, globalChallengeValues, challengeValueSetIsValid } from './defaults';
import { ruleValuesForChallengeId, isTitleProfileSuppressed } from './ruleResolution';
import {
    ScenarioSettingUnavailableError,
    installationLayer,
    isBoundPhase,
    isOverlayKey,
    checkPhaseProfileIn,
    overlaysInstallation,
    overlaySources,
    photoPoolView,
    poolViewOfRecord,
    prepareInstallationOverlay,
    prepareOverlay,
    readInstallationLayer,
    readLayer,
    readOverlay,
    readPhotoPool,
    reconcilePoolProgress,
    recordPoolEvents,
    scheduleKinds,
    subjectLayer,
} from './scenarioOverlay';
import { getEntryPins as getStoredEntryPins, mergeEntryPins } from './entryPins';
import { hasStoredScenarios } from './scenarios';
import { getScenarioCapabilities, scenarioCapability } from './scenarioCapabilities';
import { JOIN_KEPT_KEYS } from './staleChallengeCleanup';
import { isActiveChallengeId, challengeTargetForId } from './challengeFacts';
import { loggableSettingValue } from './logValue';
import { isUnsafeChallengeKey } from '../challengeKey';
import { INSTALLATION_KEY } from '../scenarioStateStore';
import { settingValue } from '../scenarios/expressions';
import { unknownOf } from '../scenarios/valueState';

import type { ExprValue } from '../scenarios/expressions';
import type { ValueState } from '../scenarios/valueState';
import type { ConfigApp, ConfigV2 } from '../types/config';
import type { SettingView } from '../types/scenario';
import type { ChallengeIdInput, ChallengeValues, EntryPins, SettingValueOf } from '../types/settings';
import type { ResolvedSchedules } from '../types/autoFill';
import type { ScenarioPublication, ScenarioState } from '../types/stores';
import type { InstallationLayer, PhotoPoolView, ResolvedOverlay, SubjectLayer } from './scenarioOverlay';
import type { ScenarioDocument } from './scenarioSchema';

/**
 * Whether an override equal to the inherited value is still stored. The join keys
 * are, for a challenge that is not joined yet: a rule cannot be resolved by id for
 * it, so an entry that merely equals what the global default or a rule gives today
 * would silently stop applying to it. A joined challenge resolves rules by id, so
 * it keeps the normal "equal to inherited means no override".
 */
const keepsEqualValue = (settingKey: string, challengeId: string | number): boolean =>
    JOIN_KEPT_KEYS.includes(settingKey) && !isActiveChallengeId(challengeId);

/**
 * Trimmed string form of a caller-supplied challenge id ('' when absent, or when it names an
 * Object.prototype member rather than a challenge).
 */
const trimmedChallengeId = (challengeId: string | number | null | undefined): string => {
    if (challengeId === null || challengeId === undefined) return '';
    const id = String(challengeId).trim();
    return isUnsafeChallengeKey(id) ? '' : id;
};

/**
 * Whether a caller-supplied challenge id names an Object.prototype member, which no write may use as a key.
 */
const isUnsafeId = (challengeId: string | number): boolean => isUnsafeChallengeKey(String(challengeId).trim());

/**
 * A challenge's stored values, or undefined when it has none of its own: an id that names an
 * Object.prototype member is never a challenge.
 */
const ownChallengeValues = (settings: ConfigV2, challengeId: string | number): ChallengeValues | undefined =>
    Object.hasOwn(settings.challenges, challengeId) ? settings.challenges[challengeId].values : undefined;

/**
 * Removes the stored record of a challenge that holds nothing any more: no values of its own, no suppression and no
 * pins.
 */
const dropEmptyChallengeRecord = (settings: ConfigV2, challengeId: string | number): void => {
    if (!Object.hasOwn(settings.challenges, challengeId)) return;
    const record = settings.challenges[challengeId];
    if (record.values && Object.keys(record.values).length === 0) delete record.values;
    if (Object.keys(record).length === 0) delete settings.challenges[challengeId];
};

/**
 * Get global default value for a setting
 */
const getGlobalDefault = <K extends string>(settingKey: K): SettingValueOf<K> => {
    const entry = schemaEntry(settingKey);
    // A challengeOnly key has no global value: the schema default is all there is.
    if (entry?.challengeOnly) return schemaDefault(settingKey);
    const { defaults } = loadSettings();
    if (Object.prototype.hasOwnProperty.call(defaults, settingKey)) {
        // Stored values are validated against the schema on load.
        return defaults[settingKey] as SettingValueOf<K>;
    }

    // Fallback to schema default if not found in settings
    return schemaDefault(settingKey);
};

/**
 * Set global default value for a setting
 */
const setGlobalDefault = (settingKey: string, value: unknown): boolean => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return false;
    }

    if (entry.challengeOnly) {
        logger
            .withCategory('settings')
            .error(`Setting ${settingKey} can only be set on a challenge or a profile, not globally`, null);
        return false;
    }

    // Get current global defaults for context validation
    const settings = loadSettings();
    const contextSettings = { ...settings.defaults, [settingKey]: value };

    // Get detailed validation error information
    const validationError = getValidationError(settingKey, value, contextSettings);
    if (validationError) {
        logger
            .withCategory('settings')
            .error(`Invalid value for setting ${settingKey}:`, loggableSettingValue(settingKey, value));
        logger.withCategory('settings').error(validationError, null);
        return false;
    }

    settings.defaults[settingKey] = value;
    return saveSettings(settings);
};

/**
 * Get per-challenge override value for a setting
 */
const getChallengeOverride = <K extends string>(
    settingKey: K,
    challengeId: string | number,
): SettingValueOf<K> | null => {
    const overrides = ownChallengeValues(loadSettings(), challengeId);
    if (overrides && Object.hasOwn(overrides, settingKey)) {
        // Stored values are validated against the schema on load.
        return overrides[settingKey] as SettingValueOf<K>;
    }

    return null;
};

/**
 * Ensures the `challenges[challengeId].values` container
 * exists on the given configuration and returns it.
 */
const _ensureChallengeContainer = (settings: ConfigV2, challengeId: string | number): ChallengeValues => {
    if (!Object.hasOwn(settings.challenges, challengeId)) {
        settings.challenges[challengeId] = {};
    }
    const record = settings.challenges[challengeId];
    return (record.values ??= {});
};

/**
 * Validates a per-challenge override and writes it onto the in-memory
 * settings object. Returns one of: 'invalid' (rejected),
 * 'set' (override stored), 'cleared' (override removed because it
 * matched the inherited value, except the chosen-photos keys).
 */
const _applyChallengeOverride = (
    settings: ConfigV2,
    settingKey: string,
    challengeId: string | number,
    value: unknown,
): 'invalid' | 'set' | 'cleared' => {
    const entry = schemaEntry(settingKey);
    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return 'invalid';
    }
    if (isUnsafeId(challengeId)) {
        logger.withCategory('settings').error(`Invalid challenge id: ${String(challengeId)}`, null);
        return 'invalid';
    }
    if (!entry.perChallenge) {
        logger.withCategory('settings').error(`Setting ${settingKey} does not support per-challenge overrides`, null);
        return 'invalid';
    }

    const globalDefaults = globalChallengeValues(settings);
    const inheritedDefaults = { ...globalDefaults, ...ruleValuesForChallengeId(settings, challengeId) };
    const existingOverrides = ownChallengeValues(settings, challengeId) || {};
    const contextSettings = { ...inheritedDefaults, ...existingOverrides, [settingKey]: value };

    if (!challengeValueSetIsValid(contextSettings, { [settingKey]: value }, challengeId)) {
        logger
            .withCategory('settings')
            .error(`Invalid value for setting ${settingKey}:`, loggableSettingValue(settingKey, value));
        return 'invalid';
    }

    const container = _ensureChallengeContainer(settings, challengeId);
    // inheritedDefaults always holds every schema key (globalChallengeValues
    // starts from the full schema defaults), and settingKey is schema-checked above.
    if (keepsEqualValue(settingKey, challengeId) || !valuesEqual(value, inheritedDefaults[settingKey])) {
        container[settingKey] = value;
        return 'set';
    }
    delete container[settingKey];
    return 'cleared';
};

/**
 * The scenario a challenge resolves to over an already loaded configuration: its own override, else a matching rule, else
 * the default; '' when none.
 */
const assignedScenarioIn = (settings: ConfigV2, challengeId: string | number): string =>
    // A stored scenario name is validated on load: a text.
    _resolveEffectiveSetting(settings, 'scenario', challengeId) as string;

/**
 * Writes a challenge's own `scenario` override onto a loaded configuration, or removes it (`null`). The same write a
 * single-key override makes: a name equal to what the challenge inherits is stored as no override.
 */
const assignScenarioIn = (settings: ConfigV2, challengeId: string, name: string | null): boolean => {
    if (name !== null) {
        if (_applyChallengeOverride(settings, 'scenario', challengeId, name) === 'invalid') return false;
        dropEmptyChallengeRecord(settings, challengeId);
        return true;
    }
    const own = ownChallengeValues(settings, challengeId);
    if (!own || !Object.hasOwn(own, 'scenario')) return true;
    const next = { ...own };
    delete next.scenario;
    return replaceChallengeOverridesInSettings(
        settings,
        challengeId,
        next,
        isTitleProfileSuppressed(settings, challengeId),
    );
};

/**
 * Makes `change` on the stored configuration and saves it. When the change moves the scenario the challenge runs, it is
 * made under the scenario lifecycle gate instead (settings/scenarioLifecycle.ts), which refuses it while the challenge
 * has unresolved work: a different scenario would start over a spend that may have landed. Any other change is written
 * as it always was.
 */
const writeAssignmentAware = (challengeId: string | number, change: (settings: ConfigV2) => boolean): boolean => {
    const probe = loadSettings();
    const before = assignedScenarioIn(probe, challengeId);
    if (!change(probe)) return false;
    if (assignedScenarioIn(probe, challengeId) === before) return saveSettings(probe);
    const gated = runGated(
        () => ({ challengeIds: [String(challengeId)] }),
        (settings) => change(settings) && saveSettings(settings),
    );
    return gated.ok && gated.value;
};

/**
 * Set per-challenge override value for a setting.
 */
const setChallengeOverride = (settingKey: string, challengeId: string | number, value: unknown): boolean =>
    writeAssignmentAware(challengeId, (settings) => {
        const result = _applyChallengeOverride(settings, settingKey, challengeId, value);
        if (result === 'invalid') return false;

        // If the cleared override left the challenge container empty, drop it.
        dropEmptyChallengeRecord(settings, challengeId);
        return true;
    });

const _challengeOverrideEntries = (overrides: unknown): Array<[string, unknown]> | null => {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
    const entries = Object.entries(overrides);
    return entries.some(([key]) => !schemaEntry(key)?.perChallenge) ? null : entries;
};

const _writeTitleProfileSuppression = (settings: ConfigV2, challengeId: string, suppressed: boolean) => {
    if (suppressed) {
        if (!Object.hasOwn(settings.challenges, challengeId)) settings.challenges[challengeId] = {};
        settings.challenges[challengeId].suppressRuleProfile = true;
    } else if (Object.hasOwn(settings.challenges, challengeId)) {
        delete settings.challenges[challengeId].suppressRuleProfile;
    }
};

/**
 * Validate and write a challenge's whole override container (only values that
 * differ from the inherited global/rule baseline are kept, except the join keys
 * — see JOIN_KEPT_KEYS) plus its profile
 * suppression flag onto the in-memory settings. Returns false when rejected.
 */
const replaceChallengeOverridesInSettings = (
    settings: ConfigV2,
    challengeId: string,
    overrides: unknown,
    suppressTitleProfile: boolean,
): boolean => {
    const entries = _challengeOverrideEntries(overrides);
    if (entries === null || isUnsafeId(challengeId)) return false;

    const globalValues = globalChallengeValues(settings);
    const ruleValues = ruleValuesForChallengeId(settings, challengeId, suppressTitleProfile);
    const inherited = { ...globalValues, ...ruleValues };
    // Non-null plain object: _challengeOverrideEntries returned entries.
    const overrideValues = overrides as ChallengeValues;
    const effective = { ...inherited, ...overrideValues };
    if (!challengeValueSetIsValid(effective, { ...ruleValues, ...overrideValues }, challengeId)) {
        return false;
    }

    const container: ChallengeValues = {};
    for (const [key, value] of entries) {
        if (keepsEqualValue(key, challengeId) || !valuesEqual(value, inherited[key])) container[key] = value;
    }
    if (Object.keys(container).length) {
        if (!Object.hasOwn(settings.challenges, challengeId)) settings.challenges[challengeId] = {};
        settings.challenges[challengeId].values = container;
    } else if (Object.hasOwn(settings.challenges, challengeId)) {
        delete settings.challenges[challengeId].values;
    }

    _writeTitleProfileSuppression(settings, challengeId, suppressTitleProfile);
    dropEmptyChallengeRecord(settings, challengeId);
    return true;
};

/**
 * Atomically merge multiple per-challenge overrides, saving only values that
 * differ from the inherited global/title-profile baseline.
 */
const setChallengeOverrides = (challengeId: ChallengeIdInput, overrides: unknown): boolean => {
    const id = trimmedChallengeId(challengeId);
    if (!id || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return false;
    return writeAssignmentAware(id, (settings) => {
        const current = ownChallengeValues(settings, id) || {};
        const next = { ...current, ...overrides };
        return replaceChallengeOverridesInSettings(settings, id, next, isTitleProfileSuppressed(settings, id));
    });
};

/**
 * Remove per-challenge override for a setting
 */
const removeChallengeOverride = (settingKey: string, challengeId: string): boolean => {
    if (isUnsafeId(challengeId)) return false;
    const current = ownChallengeValues(loadSettings(), challengeId);
    if (!current || !Object.hasOwn(current, settingKey)) return true; // Nothing to remove

    return writeAssignmentAware(challengeId, (settings) => {
        const next = { ...ownChallengeValues(settings, challengeId) };
        delete next[settingKey];
        return replaceChallengeOverridesInSettings(
            settings,
            challengeId,
            next,
            isTitleProfileSuppressed(settings, challengeId),
        );
    });
};

/**
 * Batch reader for one challenge's sparse override map. Own-property-safe
 * copy filtered to schema-known perChallenge keys — shared by the GUI modal
 * load and the CLI save-profile snapshot.
 */
const getChallengeOverrides = (challengeId: string | number): ChallengeValues => {
    const stored = ownChallengeValues(loadSettings(), challengeId);
    const overrides: ChallengeValues = {};
    if (stored) {
        for (const key of Object.keys(stored)) {
            if (schemaEntry(key)?.perChallenge) {
                overrides[key] = stored[key];
            }
        }
    }
    return overrides;
};

/**
 * Atomically replace a challenge form's manual settings and profile mode.
 */
const replaceChallengeOverrides = (
    challengeId: ChallengeIdInput,
    overrides: unknown,
    suppressTitleProfile: unknown = false,
): boolean => {
    const id = trimmedChallengeId(challengeId);
    if (!id || typeof suppressTitleProfile !== 'boolean') return false;
    return writeAssignmentAware(id, (settings) =>
        replaceChallengeOverridesInSettings(settings, id, overrides, suppressTitleProfile),
    );
};

/**
 * The unix second now: the clock a publication's validity is judged on.
 */
const nowSec = clockSec;

/**
 * A challenge's scenario layer over an already loaded settings blob (settings/scenarioOverlay.ts). The scenario name is
 * resolved without the overlay: the assignment itself is never overlaid.
 */
const _subjectLayer = (settings: ConfigV2, challengeId: ChallengeIdInput): SubjectLayer =>
    subjectLayer(
        settings,
        String(challengeId),
        () => _resolveEffectiveSetting(settings, 'scenario', challengeId) as string,
        nowSec(),
    );

/**
 * Why a challenge's scenario layer cannot be read, or null when it can. Only a phase with bindings or a profile, or a
 * scenario state that cannot be read for a scenario that has one, is ever unavailable.
 */
const _unavailableReason = (subject: SubjectLayer): string | null => {
    if (subject.kind === 'unreadable') return subject.reason;
    return subject.kind === 'phase' && !subject.layer.overlay.ok ? subject.layer.overlay.reason : null;
};

/**
 * Whether a phase overlay would write this setting: a key whose capability lets a challenge phase write it.
 */
const _phaseWritesKey = (settingKey: string): boolean =>
    scenarioCapability(settingKey)?.phaseWrite.includes('challenge') === true;

/**
 * Get the effective value for a setting: the active scenario phase's value,
 * then the per-challenge override, matching rules, and the global default. A setting the installation scenario
 * owns is the installation's: the saved value, or the published phase over it (getInstallationSetting).
 *
 * A challenge whose phase has bindings or a profile reads them from the overlay its owner published. With no valid
 * publication a setting the phase may write is never answered from inherited values: it throws
 * ScenarioSettingUnavailableError (see scenarioSubjectAvailable for the check a route makes first).
 */
const getEffectiveSetting = <K extends string>(
    settingKey: K,
    challengeId: ChallengeIdInput = null,
): SettingValueOf<K> => {
    const entry = schemaEntry(settingKey);
    // An installation-owned setting is read from the installation's published phase (getInstallationSetting). A key a
    // challenge's own phase can also write (a card's compact view) keeps its challenge read when a challenge is named.
    if (_installationOwns(settingKey) && !(challengeId && entry?.perChallenge)) {
        return getInstallationSetting(settingKey) as SettingValueOf<K>;
    }

    if (!entry) {
        logger.withCategory('settings').error(`Invalid setting key: ${settingKey}`, null);
        return undefined as SettingValueOf<K>;
    }

    const settings = loadSettings();

    // A scenario phase's values sit above every other layer while the
    // challenge is in that phase (settings/scenarioOverlay.ts). The
    // assignment itself is never overlaid.
    if (challengeId && settingKey !== 'scenario' && entry.perChallenge) {
        const subject = _subjectLayer(settings, challengeId);
        const unavailable = _unavailableReason(subject);
        if (unavailable !== null && _phaseWritesKey(settingKey)) {
            throw new ScenarioSettingUnavailableError(settingKey, String(challengeId), unavailable);
        }
        // A phase's photo pool stands in for its Chosen Photos settings; the runtime patch is above it.
        const found =
            subject.kind === 'phase'
                ? (readPhotoPool(settings, subject.layer, settingKey) ?? readLayer(subject.layer, settingKey))
                : null;
        if (found) return found.value as SettingValueOf<K>;
    }
    return _resolveEffectiveSetting(settings, settingKey, challengeId) as SettingValueOf<K>;
};

/**
 * The stored layers of getEffectiveSetting, over an already loaded settings
 * blob: per-challenge override -> matching rules -> global default.
 *
 * @param settingKey - a known schema key
 */
const _resolveEffectiveSetting = (settings: ConfigV2, settingKey: string, challengeId: ChallengeIdInput): unknown => {
    const entry = schemaEntry(settingKey) as SettingsSchemaEntry;

    // Explicit id-keyed settings remain the highest-precedence layer.
    if (challengeId && entry.perChallenge) {
        const overrides = ownChallengeValues(settings, challengeId);
        if (overrides && Object.hasOwn(overrides, settingKey)) {
            return overrides[settingKey];
        }

        // Rule values are an inherited baseline, not copied per-challenge
        // overrides. That makes them survive rotating challenge ids while still
        // allowing a one-off manual override to win above them.
        const ruleValues = ruleValuesForChallengeId(settings, challengeId);
        if (Object.prototype.hasOwnProperty.call(ruleValues, settingKey)) {
            return ruleValues[settingKey];
        }
    }

    // A challengeOnly key ignores any stored global value (hand-edited or left by
    // an older build): only a challenge override or a profile can turn it on.
    if (entry.challengeOnly) return entry.default;

    return Object.prototype.hasOwnProperty.call(settings.defaults, settingKey)
        ? settings.defaults[settingKey]
        : entry.default;
};

/**
 * The base value of one named setting, raw (see _baseRawValues).
 */
const _baseRawValue = (settings: ConfigV2, key: string, challengeId: ChallengeIdInput): unknown =>
    schemaEntry(key) ? _resolveEffectiveSetting(settings, key, challengeId) : settings.app[key];

/**
 * The base value of every named setting for a challenge, raw: everything below the phase overlay (the challenge's
 * override, its rules, the stored defaults, the schema defaults). A key outside the schema is an app setting, read from
 * the configuration's app block.
 */
const _baseRawValues = (settings: ConfigV2, challengeId: ChallengeIdInput): Record<string, unknown> =>
    Object.fromEntries(
        getScenarioCapabilities().settings.map(({ key }) => [key, _baseRawValue(settings, key, challengeId)]),
    );

/**
 * One setting as a typed value state: converted at the setting boundary (settings/scenarioCapabilities.ts describes
 * what it holds), unknown when the key is no setting, only a restricted projection of it can be observed, or the value
 * has the wrong shape.
 */
const _typedValue = (settingKey: string, raw: unknown): ValueState<ExprValue> => {
    const capability = scenarioCapability(settingKey);
    if (!capability) return unknownOf('setting-unknown', [`setting:${settingKey}`]);
    if (capability.read !== 'value') return unknownOf('setting-not-readable', [`setting:${settingKey}`]);
    return settingValue(capability.value, raw);
};

const _baseStates = (settings: ConfigV2, challengeId: ChallengeIdInput): Record<string, ValueState<ExprValue>> =>
    Object.fromEntries(
        Object.entries(_baseRawValues(settings, challengeId)).map(([key, raw]) => [key, _typedValue(key, raw)]),
    );

/**
 * The base settings of a challenge as typed values: everything below its phase overlay.
 */
const getScenarioBaseSettings = (challengeId: ChallengeIdInput = null): Record<string, ValueState<ExprValue>> =>
    _baseStates(loadSettings(), challengeId);

/**
 * One setting of a challenge as a typed value, in the base view (below the phase overlay) or the effective view (with
 * the published overlay applied). An effective read of a setting the phase would write is unknown, with the reason,
 * when no valid overlay is published: it never answers with an inherited value. Never throws, never writes.
 */
const readScenarioSetting = (
    settingKey: string,
    view: SettingView,
    challengeId: ChallengeIdInput = null,
): ValueState<ExprValue> => {
    const settings = loadSettings();
    const base = () => _typedValue(settingKey, _baseRawValues(settings, challengeId)[settingKey]);
    if (view === 'base' || !challengeId || !isOverlayKey(settingKey)) return base();
    const subject = _subjectLayer(settings, challengeId);
    const unavailable = _unavailableReason(subject);
    if (unavailable !== null && _phaseWritesKey(settingKey)) return unknownOf(unavailable, [`setting:${settingKey}`]);
    const found = subject.kind === 'phase' ? readLayer(subject.layer, settingKey) : null;
    return found ? _typedValue(settingKey, found.value) : base();
};

/**
 * Why a challenge's scenario settings are unavailable, or null when they are readable (a challenge with no scenario, or in
 * a phase without bindings or a profile, always is).
 */
const scenarioSubjectReason = (challengeId: ChallengeIdInput): string | null =>
    challengeId ? _unavailableReason(_subjectLayer(loadSettings(), challengeId)) : null;

/**
 * Whether a route may read this challenge's settings: false while its phase has bindings or a profile and no valid
 * overlay is published (the reads would throw ScenarioSettingUnavailableError).
 */
const scenarioSubjectAvailable = (challengeId: ChallengeIdInput): boolean =>
    scenarioSubjectReason(challengeId) === null;

/** Where a challenge's scenario settings come from and whether they can be read (a status read; it changes nothing). */
type ScenarioOverlayStatus = {
    /** The phase has bindings or a profile, so its settings are read through a publication. */
    bound: boolean;
    available: boolean;
    reason: string | null;
    /** The keys each source of the phase sets: its literals, its bindings, the profile it selects. */
    sources: { patch: string[]; literals: string[]; bindings: string[]; profile: string[] };
    /** The publication in the ledger, when there is a valid one. */
    published: Pick<ScenarioPublication, 'revision' | 'observedAt' | 'validUntil' | 'profile'> | null;
};

const scenarioOverlayStatus = (challengeId: ChallengeIdInput): ScenarioOverlayStatus => {
    const none = {
        bound: false,
        available: true,
        reason: null,
        sources: { patch: [], literals: [], bindings: [], profile: [] },
        published: null,
    };
    if (!challengeId) return none;
    const subject = _subjectLayer(loadSettings(), challengeId);
    if (subject.kind === 'none') return none;
    if (subject.kind === 'unreadable') return { ...none, bound: true, available: false, reason: subject.reason };
    const { layer } = subject;
    const published = layer.overlay.ok && layer.bound ? layer.state.published : undefined;
    return {
        bound: layer.bound,
        available: layer.overlay.ok,
        reason: layer.overlay.ok ? null : layer.overlay.reason,
        sources: overlaySources(layer),
        published: published
            ? {
                  revision: published.revision,
                  observedAt: published.observedAt,
                  validUntil: published.validUntil,
                  profile: published.profile,
              }
            : null,
    };
};

/**
 * Whether a saved profile can be a phase's profile (the `useProfile` action's check): the name as saved, or why not.
 */
const checkPhaseProfile = (name: string) => checkPhaseProfileIn(loadSettings(), name);

/**
 * The saved profiles a phase may apply, by their names as saved: every one the same check accepts that publication and the
 * `useProfile` action make (it reads as a valid profile now, and sets only keys a phase may change).
 */
const listPhaseProfiles = (): string[] => {
    const settings = loadSettings();
    return Object.keys(settings.profiles).filter((name) => checkPhaseProfileIn(settings, name).ok);
};

/**
 * The photos a challenge's Boost and Turbo are pinned to now: the runtime pin of its scenario phase entry, else the phase's
 * pin, else the pin the user saved (null: none; an explicit null in a tier suppresses the lower ones). The one reader the
 * Boost and Turbo picks, the `pinned` selector, the status and the facts use. A scenario's pins are never written to the
 * saved ones; a subject with no readable phase reads the saved pins. See entryPins mergeEntryPins.
 */
const getEffectiveEntryPins = (challengeId: string | number): EntryPins => {
    const stored = getStoredEntryPins(challengeId);
    const subject = _subjectLayer(loadSettings(), challengeId);
    if (subject.kind !== 'phase') return stored;
    const { phase, state } = subject.layer;
    return mergeEntryPins(stored, phase.pins, state.phasePins);
};

/**
 * The photo pool the challenge's phase draws from, as the picks read it (null: the phase has none). A challenge whose
 * progress cannot be read is unavailable, as for any phase that needs it (scenarioSubjectAvailable).
 */
const getChosenPoolView = (challengeId: string | number): PhotoPoolView | null => {
    const settings = loadSettings();
    const subject = _subjectLayer(settings, challengeId);
    return subject.kind === 'phase' ? photoPoolView(settings, subject.layer) : null;
};

/**
 * The photo pool of the phase a challenge's progress record is in, for a subject the overlay does not resolve by id: an
 * un-joined candidate, whose scenario is the one its rules (or its own override) give, named by the caller. Null: no record
 * of that scenario, or a phase with no pool.
 */
const getPoolViewFor = (challengeId: string | number, scenarioName: string): PhotoPoolView | null =>
    poolViewOfRecord(loadSettings(), String(challengeId), scenarioName);

/**
 * Records a submit's or a swap's effect on the photos of the pool of the phase the challenge's progress record is in (see
 * recordPoolEvents), whether the challenge is joined or still a candidate. Nothing is read or written without a stored
 * scenario. Not for use inside a scenario step, which hands the events to its reducer.
 */
const recordPhotoPoolEvents = (
    challengeId: string | number,
    events: { consume: readonly string[]; reserve: readonly string[] },
): boolean => {
    const settings = loadSettings();
    return hasStoredScenarios(settings) && recordPoolEvents(settings, String(challengeId), events);
};

/**
 * Settles the challenge's pool progress against its full, fresh entry list (see reconcilePoolProgress): reserved photos
 * that are entered are consumed, those that are not are released. Nothing is read without a stored scenario.
 */
const reconcilePhotoPool = (challengeId: string | number, entryIds: readonly string[]): boolean => {
    const settings = loadSettings();
    return hasStoredScenarios(settings) && reconcilePoolProgress(settings, String(challengeId), entryIds);
};

/**
 * What a challenge's phase says about its dynamic schedules: none (no phase, or one without schedules), the schedules the
 * owner published (a kind the phase does not carry is absent: that one keeps its literal settings), or why they cannot be
 * read (the published settings are missing, expired or from another document, or the progress record is unreadable).
 */
type PhaseSchedulesRead =
    | { kind: 'none' }
    | { kind: 'resolved'; schedules: ResolvedSchedules }
    | { kind: 'unavailable'; reason: string };

const getPhaseSchedules = (challengeId: string | number): PhaseSchedulesRead => {
    const subject = _subjectLayer(loadSettings(), challengeId);
    if (subject.kind === 'none') return { kind: 'none' };
    if (subject.kind === 'unreadable') return { kind: 'unavailable', reason: subject.reason };
    const { layer } = subject;
    if (scheduleKinds(layer.phase).length === 0) return { kind: 'none' };
    if (!layer.overlay.ok) return { kind: 'unavailable', reason: layer.overlay.reason };
    return { kind: 'resolved', schedules: layer.overlay.value.schedules };
};

/** What the runner holds for one evaluation of a phase: what to publish, and how to read settings in it. */
type ScenarioSnapshot = {
    /** The overlay to publish, or null when the phase has no bindings or profile (there is nothing to publish). */
    publication: ScenarioPublication | null;
    readSetting: (settingKey: string, view: SettingView) => ValueState<ExprValue>;
};

/** What a phase's bindings resolved to, as the runner works them out from the base reads it is handed. */
type BindingResolution = {
    bound: Record<string, ValueState<ExprValue>>;
    validUntil: number | null;
    /** What the phase's dynamic schedules resolved to (absent: the phase has none). */
    schedules?: ResolvedSchedules;
};

/**
 * Prepares the settings of a challenge's phase: the base values, and the overlay the phase gives with its bindings
 * resolved. Nothing is stored; the owner publishes `publication`. A binding that is not known, does not fit its
 * setting or fails validation, or a profile that cannot be used, is refused with the key and reason: there is no partial
 * overlay.
 *
 * @param resolveBindings - the runner's evaluation of the phase's bindings (called only for a phase that has any); it
 *   reads base settings through what it is handed, and raw facts itself. `validUntil` is the next instant (unix
 *   seconds) a binding result can change at, or null
 * @param now - unix seconds
 */
const prepareScenarioSnapshot = (
    challengeId: string | number,
    scenario: ScenarioDocument,
    state: Pick<ScenarioState, 'phase' | 'phaseEnteredAt' | 'published' | 'phasePatch' | 'phaseProfile'>,
    resolveBindings: (readBase: (settingKey: string, view: SettingView) => ValueState<ExprValue>) => BindingResolution,
    now: number,
): { ok: true; snapshot: ScenarioSnapshot } | { ok: false; key: string | null; reason: string } => {
    const settings = loadSettings();
    const phase = scenario.phases[state.phase];
    const baseRaw = _baseRawValues(settings, challengeId);
    const baseStates = Object.fromEntries(Object.entries(baseRaw).map(([key, raw]) => [key, _typedValue(key, raw)]));
    const baseOf = (settingKey: string): ValueState<ExprValue> =>
        Object.hasOwn(baseStates, settingKey)
            ? baseStates[settingKey]
            : unknownOf('setting-unknown', [`setting:${settingKey}`]);
    const reader =
        (overlay: ResolvedOverlay, boundPhase: boolean): ScenarioSnapshot['readSetting'] =>
        (settingKey, view) => {
            const found = view === 'effective' ? readOverlay(overlay, boundPhase, settingKey) : null;
            return found ? _typedValue(settingKey, found.value) : baseOf(settingKey);
        };
    // A phase with literals only is read straight from the document, as it always was: nothing to publish.
    if (!isBoundPhase(phase, state)) {
        const overlay: ResolvedOverlay = {
            patch: {},
            literals: phase.settings ?? {},
            bindings: {},
            profile: null,
            schedules: {},
        };
        return { ok: true, snapshot: { publication: null, readSetting: reader(overlay, false) } };
    }
    // A binding is worked out before the overlay exists, so it reads the base view only.
    const { bound, validUntil, schedules } = resolveBindings((settingKey, view) =>
        view === 'base' ? baseOf(settingKey) : unknownOf('binding-reads-base-only', [`setting:${settingKey}`]),
    );
    const prepared = prepareOverlay(
        settings,
        scenario,
        state,
        baseRaw,
        bound,
        String(challengeId),
        validUntil,
        now,
        schedules,
    );
    if (!prepared.ok) return prepared;
    return { ok: true, snapshot: { publication: prepared.publication, readSetting: reader(prepared.overlay, true) } };
};

// --- installation settings ---------------------------------------------------------------------------------------------

/**
 * Whether a setting belongs to the installation scenario: a key its capability lets an installation phase write (the
 * account policy, the app preferences and the device preferences).
 */
const _installationOwns = (settingKey: string): boolean =>
    scenarioCapability(settingKey)?.phaseWrite.includes('installation') === true;

/** What an installation setting holds: its schema type, its app value type, or unknown for a key only known at runtime. */
type InstallationValueOf<K extends string> = K extends SettingKey
    ? SettingValueOf<K>
    : K extends keyof ConfigApp
      ? ConfigApp[K]
      : unknown;

type InstallationRead = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * A reader of installation settings over one loaded configuration: the saved value, or the installation phase's published
 * value over it, or why it is unavailable. The overlay is worked out once, and none is looked at for an installation
 * with no scenario assigned (its progress record is not read).
 *
 * @param publication - the step that publishes the installation's overlay reads with this: a key whose publication is
 * known not to apply (none stands for the current phase — nothing was published yet, or what stands is expired, from
 * another owner or an earlier visit, made from another document, or malformed) answers the saved value, the one in force
 * before the publication that step is about to make. A progress record that cannot be read stays unavailable, as it is
 * for every reader: the saved value never takes the place of one that cannot be read.
 */
const _installationReader = (settings: ConfigV2, publication = false): ((settingKey: string) => InstallationRead) => {
    const layer: InstallationLayer = installationLayer(settings, nowSec());
    return (settingKey) => {
        const found = _installationOwns(settingKey)
            ? readInstallationLayer(layer, settingKey)
            : { kind: 'saved' as const };
        // The record was read and no publication of it applies: for the publishing step the saved value is in force.
        if (found.kind === 'unavailable' && publication && layer.kind === 'phase') {
            return { ok: true, value: _baseRawValue(settings, settingKey, null) };
        }
        if (found.kind === 'unavailable') return { ok: false, reason: found.reason };
        return { ok: true, value: found.kind === 'overlay' ? found.value : _baseRawValue(settings, settingKey, null) };
    };
};

/**
 * An installation setting's value for the code that acts on it: the saved value, with the installation scenario's current
 * phase over it when the owner published one. No installation scenario, a paused one, or a phase that does not set the
 * key reads the saved value at once (a known withdrawal restores it, nothing is written to the configuration). A phase
 * that sets the key with no valid publication (missing, from another owner, expired, malformed) throws
 * ScenarioSettingUnavailableError: never the saved value. A consumer reads it at its boundary (a cycle's start, a
 * request's entry, a spend) and acts on that one value; readInstallationSetting and captureInstallationSettings
 * answer without throwing.
 */
const getInstallationSetting = <K extends string>(settingKey: K): InstallationValueOf<K> => {
    const read = _installationReader(loadSettings())(settingKey);
    if (!read.ok) throw new ScenarioSettingUnavailableError(settingKey, INSTALLATION_KEY, read.reason);
    return read.value as InstallationValueOf<K>;
};

/**
 * One installation setting as a typed value state, for a status or an inspection: unknown, with the reason, where
 * getInstallationSetting would throw (or the value has no expression form). Never throws, never writes.
 */
const readInstallationSetting = (settingKey: string): ValueState<ExprValue> => {
    const read = _installationReader(loadSettings())(settingKey);
    return read.ok ? _typedValue(settingKey, read.value) : unknownOf(read.reason, [`setting:${settingKey}`]);
};

type InstallationCapture<K extends string> =
    | { ok: true; values: { [P in K]: InstallationValueOf<P> } }
    | { ok: false; key: K; reason: string };

/** Several installation settings at once through one reader: the values, or the first key that is unavailable with the reason. */
const _captureInstallationWith = <K extends string>(
    settingKeys: readonly K[],
    read: (settingKey: string) => InstallationRead,
): InstallationCapture<K> => {
    const values: Partial<{ [P in K]: InstallationValueOf<P> }> = {};
    for (const key of settingKeys) {
        const found = read(key);
        if (!found.ok) return { ok: false, key, reason: found.reason };
        values[key] = found.value as InstallationValueOf<typeof key>;
    }
    return { ok: true, values: values as { [P in K]: InstallationValueOf<P> } };
};

/**
 * Several installation settings at once, from one read of the configuration and of the publication, so that what a boundary
 * captures is consistent: the values, or the first key that is unavailable with the reason. Never throws.
 */
const captureInstallationSettings = <K extends string>(settingKeys: readonly K[]): InstallationCapture<K> =>
    _captureInstallationWith(settingKeys, _installationReader(loadSettings()));

/**
 * The same capture for the step that publishes the installation's overlay (the publication and the staging paths of
 * services/scenarioRunner/installation.ts): a key whose publication is known not to apply reads the saved value — the one
 * in force before that step's own publication — so the first publication of a phase that writes the zone can be made at
 * all. A state that cannot be read still answers the first unavailable key with the reason; the saved value never takes
 * the place of one that cannot be read. Never throws.
 */
const captureInstallationSettingsForPublication = <K extends string>(
    settingKeys: readonly K[],
): InstallationCapture<K> => _captureInstallationWith(settingKeys, _installationReader(loadSettings(), true));

/**
 * Prepares the installation overlay of the current phase, the owner's to publish: the base values, the bindings resolved
 * as the runner works them out from the base reads it is handed, and the validated whole. Nothing is stored. The result is
 * a publication (null for a phase that sets nothing), or the key and reason the phase could not be prepared for.
 *
 * @param resolveBindings - the owner's evaluation of the phase's bindings (called only for a phase that has any)
 * @param generation - the installation generation the owner prepares this under
 * @param now - unix seconds
 */
const prepareInstallationSnapshot = (
    scenario: ScenarioDocument,
    state: Pick<ScenarioState, 'phase' | 'phaseEnteredAt' | 'published' | 'phasePatch'>,
    resolveBindings: (readBase: (settingKey: string, view: SettingView) => ValueState<ExprValue>) => BindingResolution,
    generation: number,
    now: number,
): { ok: true; publication: ScenarioPublication | null } | { ok: false; key: string | null; reason: string } => {
    const settings = loadSettings();
    const phase = scenario.phases[state.phase];
    if (!overlaysInstallation(phase, state)) return { ok: true, publication: null };
    const baseRaw = _baseRawValues(settings, null);
    const baseOf = (settingKey: string): ValueState<ExprValue> =>
        Object.hasOwn(baseRaw, settingKey)
            ? _typedValue(settingKey, baseRaw[settingKey])
            : unknownOf('setting-unknown', [`setting:${settingKey}`]);
    // A binding is worked out before the overlay exists, so it reads the base view only.
    const { bound, validUntil } = resolveBindings((settingKey, view) =>
        view === 'base' ? baseOf(settingKey) : unknownOf('binding-reads-base-only', [`setting:${settingKey}`]),
    );
    const prepared = prepareInstallationOverlay(settings, scenario, state, baseRaw, bound, generation, validUntil, now);
    return prepared.ok ? { ok: true, publication: prepared.publication } : prepared;
};

// The one wording for the chosen-photos consume lines — the log catalog's
// English templates match against exactly this text, so the two drift together.
const formatChosenConsumedMessage = (tag: string, removed: string[], overrideRemoved: boolean): string =>
    overrideRemoved
        ? `${tag}: chosen photos entered — removed from the list: ${removed.join(', ')}; the override was removed`
        : `${tag}: chosen photos entered — removed from the list: ${removed.join(', ')}`;

/**
 * Consumes a challenge's own chosen photos once they are entered in it: every
 * entered id leaves the stored list, a non-empty remainder is stored through
 * the normal override write (so a remainder equal to the inherited value
 * auto-clears the override early), and an emptied list deletes the key —
 * never stores `[]`.
 *
 * Nothing is consumed in two cases. (a) Submit Only Chosen Photos effectively
 * on, resolved over the full layer stack (an active scenario phase above the
 * override, then rules, then the global default): the Submit Only skip needs
 * the ids stored — an emptied list reads as "no preference" and would resume
 * general filling. (b) The facts cache has not seen the challenge as active:
 * at the join-time call site the id is minutes old and rules resolve through
 * the title/facts cache, so a rule-layer Only would be invisible there — an
 * unknown id must hold, and the voting pass's lazy net consumes on the first
 * pass after the cache knows the challenge.
 *
 * Only the challenge's own key is ever consumed: an inherited rule or global
 * list keeps feeding its challenges, and Only set at any layer keeps holding.
 * The Only gate and the list read/write resolve over ONE settings snapshot —
 * a cross-process Only flip between two loads could otherwise consume under a
 * now-on Only, irreversibly. The record is only reached through
 * `ownChallengeValues`' `Object.hasOwn` gate; nothing is created and
 * `_ensureChallengeContainer` is never routed through.
 *
 * @returns whether anything was removed (and saved)
 */
const consumeChosenPhotos = (challengeId: string | number, enteredIds: readonly string[]): boolean => {
    if (isUnsafeId(challengeId)) return false;
    const settings = loadSettings();
    if (!isActiveChallengeId(challengeId)) return false;

    // Submit Only Chosen Photos over the same layer stack getEffectiveSetting
    // reads, resolved over this snapshot. A phase whose overlay cannot be read
    // consumes nothing: whether Only is on is not known.
    const subject = _subjectLayer(settings, challengeId);
    if (_unavailableReason(subject) !== null) return false;
    const phaseOnly = subject.kind === 'phase' ? readLayer(subject.layer, 'chosenPhotosOnly') : null;
    if (phaseOnly) {
        if (phaseOnly.value) return false;
    } else if (_resolveEffectiveSetting(settings, 'chosenPhotosOnly', challengeId)) {
        return false;
    }

    const record = ownChallengeValues(settings, challengeId);
    const stored = record?.chosenPhotos;
    if (!record || !Array.isArray(stored)) return false;
    const entered = new Set(enteredIds.map(String));
    const remainder = stored.filter((id) => !entered.has(String(id)));
    if (remainder.length === stored.length) return false;

    let overrideRemoved: boolean;
    if (remainder.length === 0) {
        // Delete-only: the emptied list never stores [].
        delete record.chosenPhotos;
        overrideRemoved = true;
    } else {
        const outcome = _applyChallengeOverride(settings, 'chosenPhotos', challengeId, remainder);
        // The remainder re-validates like any stored list (its ids passed the
        // schema's CHOSEN_PHOTO_ID_RE at load), so this write cannot come back
        // 'invalid' under Jest.
        /* istanbul ignore if */
        if (outcome === 'invalid') return false;
        // A remainder equal to the inherited rule/global value cleared the
        // override early, so the badge can drop before the list empties.
        overrideRemoved = outcome === 'cleared';
    }
    dropEmptyChallengeRecord(settings, challengeId);
    if (!saveSettings(settings)) return false;
    const removed = stored.filter((id) => entered.has(String(id))).map(String);
    // The id is API-derived: it reaches the line only through the tag, with the
    // title the facts cache holds (settings-layer callers carry no challenge).
    const knownTitle = challengeTargetForId(challengeId).title;
    const tag = logger.challengeTag(challengeId, typeof knownTitle === 'string' && knownTitle ? knownTitle : null);
    logger.withCategory('settings').info(formatChosenConsumedMessage(tag, removed, overrideRemoved), null);
    return true;
};

export type {
    BindingResolution,
    InstallationCapture,
    InstallationValueOf,
    PhaseSchedulesRead,
    PhotoPoolView,
    ScenarioOverlayStatus,
    ScenarioSnapshot,
};
export { ScenarioSettingUnavailableError };

export {
    getGlobalDefault,
    setGlobalDefault,
    getChallengeOverride,
    setChallengeOverride,
    setChallengeOverrides,
    removeChallengeOverride,
    consumeChosenPhotos,
    getChallengeOverrides,
    replaceChallengeOverrides,
    replaceChallengeOverridesInSettings,
    assignedScenarioIn,
    assignScenarioIn,
    writeAssignmentAware,
    getEffectiveSetting,
    getEffectiveEntryPins,
    getChosenPoolView,
    getPhaseSchedules,
    getPoolViewFor,
    recordPhotoPoolEvents,
    reconcilePhotoPool,
    getScenarioBaseSettings,
    readScenarioSetting,
    scenarioSubjectAvailable,
    scenarioSubjectReason,
    scenarioOverlayStatus,
    prepareScenarioSnapshot,
    checkPhaseProfile,
    listPhaseProfiles,
    getInstallationSetting,
    readInstallationSetting,
    captureInstallationSettings,
    captureInstallationSettingsForPublication,
    prepareInstallationSnapshot,
    trimmedChallengeId,
    ownChallengeValues,
    dropEmptyChallengeRecord,
};
