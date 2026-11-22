/**
 * Settings facade — the only module callers import. It re-exports the public
 * surface of the internal ./settings/* modules:
 *
 *   schema.ts             keys, defaults, validation, groups/tiers (entries in schema/)
 *   storage.ts            persistence transport (config.json, and settings.json) + runtime/environment detection
 *   defaults.ts           default configuration and shared challenge-value helpers
 *   persistence.ts        load (fill + validate, the one-time import of settings.json) / save,
 *                         app and auth keys, window bounds, recovery actions
 *   legacyImport.ts       the import of settings.json (the conversion is importV1/)
 *   challengeOverrides.ts global defaults, per-challenge overrides, effective values
 *   challengeFacts.ts     process-local cache of the active challenges' titles/facts
 *   titleRuleSanitize.ts  write-side validation of challenge rules
 *   ruleResolution.ts     read-side rule matching, profile layer, suppression
 *   titleRules.ts         persisted challenge rules and rule-aware resolvers
 *   profileStore.ts       profile names and value sanitization
 *   profiles.ts           named challenge-settings profiles
 *   titlePins.ts          first-seen challenge-title pins (a cache store beside the configuration)
 *   entryPins.ts          the photo a challenge's Boost and Turbo are pinned to
 *   scenarioSchema.ts     validation of user-defined scenario documents (scenarioSchema/)
 *   scenarios.ts          stored scenarios, JSON import/export
 *   scenarioLifecycle.ts  the gate every assignment change runs under, the installation scenario, handoff, the Stop fence
 *   scenarioOverlay.ts    the active scenario phase's overlay: literals, bindings, one profile, and the owner's publication
 *   scenarioCapabilities.ts what a scenario may read or write per configuration key (the phase gate, the projection)
 *   reset.ts              reset helpers and "modified" checks
 */

import {
    SETTINGS_SCHEMA,
    SETTINGS_GROUPS,
    SETTINGS_TIERS,
    getValidationError,
    getSettingsSchema,
} from './settings/schema';
import { titleRuleTitles } from './settings/challengeRules';
import {
    initializeAsync as initializeStorageAsync,
    flushPendingWrites,
    getUserDataPath,
    getSettingsPath,
    getEnvironmentInfo,
} from './settings/storage';
import { getDefaultSettings } from './settings/defaults';
import * as persistence from './settings/persistence';
import * as challengeOverrides from './settings/challengeOverrides';
import * as staleChallengeCleanup from './settings/staleChallengeCleanup';
import * as openChallenges from './settings/openChallenges';
import { rememberChallengeTitles } from './settings/challengeFacts';
import { importMarkerStore } from './settings/importMarker';
import { TITLE_RULE_INLINE_KEYS, MAX_TITLE_LENGTH } from './settings/titleRuleSanitize';
import * as titleRules from './settings/titleRules';
import * as profiles from './settings/profiles';
import * as titlePins from './settings/titlePins';
import * as entryPins from './settings/entryPins';
import * as scenarios from './settings/scenarios';
import * as scenarioControls from './settings/scenarioControls';
import * as scenarioLifecycle from './settings/scenarioLifecycle';
import * as scenarioCapabilities from './settings/scenarioCapabilities';
import * as reset from './settings/reset';

/**
 * Hydrates every store the settings read on Capacitor (the configuration, `settings.json`, the import marker and the
 * title pins) before the window mounts. No-op elsewhere.
 */
const initializeAsync = async (): Promise<void> => {
    await Promise.all([
        initializeStorageAsync(),
        importMarkerStore.initializeAsync(),
        titlePins.titlePinStore.initializeAsync(),
    ]);
};

export const loadSettings = persistence.loadSettings;
export const saveSettings = persistence.saveSettings;
export const saveAppSettings = persistence.saveAppSettings;
export const getSetting = persistence.getSetting;
export const setSetting = persistence.setSetting;
export const getSettingsRecovery = persistence.getSettingsRecovery;
// Recovery of a configuration that could not be imported or read (see persistence.ts)
export const retryImport = persistence.retryImport;
export const retryImportDetailed = persistence.retryImportDetailed;
export const startFresh = persistence.startFresh;
export const startFreshDetailed = persistence.startFreshDetailed;
// What the import left unresolved
export const getImportReport = persistence.getImportReport;
export const acknowledgeImportReport = persistence.acknowledgeImportReport;
export type SettingsRecovery = persistence.SettingsRecovery;
export const getSettingsSaveDropped = persistence.getSettingsSaveDropped;
export const onSettingsSaveDroppedChange = persistence.onSettingsSaveDroppedChange;
export const onSettingsRecoveryChange = persistence.onSettingsRecoveryChange;
export const saveWindowBounds = persistence.saveWindowBounds;
export const getWindowBounds = persistence.getWindowBounds;
// Challenge-specific settings
export const getGlobalDefault = challengeOverrides.getGlobalDefault;
export const setGlobalDefault = challengeOverrides.setGlobalDefault;
export const getChallengeOverride = challengeOverrides.getChallengeOverride;
export const setChallengeOverride = challengeOverrides.setChallengeOverride;
export const setChallengeOverrides = challengeOverrides.setChallengeOverrides;
export const removeChallengeOverride = challengeOverrides.removeChallengeOverride;
export const consumeChosenPhotos = challengeOverrides.consumeChosenPhotos;
export const getEffectiveSetting = challengeOverrides.getEffectiveSetting;
// A challenge's scenario settings as typed values: the base view (below its phase overlay), the effective view (with the
// overlay its runner published), whether they can be read at all, and the snapshot the runner prepares and publishes.
// getEffectiveSetting throws ScenarioSettingUnavailableError for a setting a phase with bindings or a profile would
// write when none is published; a route checks scenarioSubjectAvailable first.
export const getScenarioBaseSettings = challengeOverrides.getScenarioBaseSettings;
export const readScenarioSetting = challengeOverrides.readScenarioSetting;
export const scenarioSubjectAvailable = challengeOverrides.scenarioSubjectAvailable;
export const scenarioSubjectReason = challengeOverrides.scenarioSubjectReason;
export const scenarioOverlayStatus = challengeOverrides.scenarioOverlayStatus;
export const prepareScenarioSnapshot = challengeOverrides.prepareScenarioSnapshot;
export const checkPhaseProfile = challengeOverrides.checkPhaseProfile;
export const listPhaseProfiles = challengeOverrides.listPhaseProfiles;
export const ScenarioSettingUnavailableError = challengeOverrides.ScenarioSettingUnavailableError;
// The installation scenario's settings (account policy, app and device preferences) as the code that acts on them reads them:
// the saved value with the published phase over it, captured at the consumer's boundary. Saved values never change.
export const getInstallationSetting = challengeOverrides.getInstallationSetting;
export const readInstallationSetting = challengeOverrides.readInstallationSetting;
export const captureInstallationSettings = challengeOverrides.captureInstallationSettings;
// The same capture read by the step that publishes the installation's overlay: a key with no publication that applies
// answers the saved value (the one in force before that publication); an unreadable state still fails.
export const captureInstallationSettingsForPublication = challengeOverrides.captureInstallationSettingsForPublication;
export const prepareInstallationSnapshot = challengeOverrides.prepareInstallationSnapshot;
export type InstallationCapture<K extends string> = challengeOverrides.InstallationCapture<K>;
export type ScenarioOverlayStatus = challengeOverrides.ScenarioOverlayStatus;
export type ScenarioSnapshot = challengeOverrides.ScenarioSnapshot;
export type BindingResolution = challengeOverrides.BindingResolution;
// Challenge rules (survive challenge rotation)
export const getTitleRules = titleRules.getTitleRules;
export const setTitleRules = titleRules.setTitleRules;
// The dry-run of setTitleRules: what the write would store, drop and collapse,
// without saving (the CLI import preview runs it).
export const previewTitleRules = titleRules.previewTitleRules;
export type TitleRuleNote = titleRules.TitleRuleNote;
export type TitleRulesPreview = titleRules.TitleRulesPreview;
export const resolveRuleSetting = titleRules.resolveRuleSetting;
export const resolveRuleSettingGroup = titleRules.resolveRuleSettingGroup;
export const hasRuleJoinOptIn = titleRules.hasRuleJoinOptIn;
export const getEffectiveTagSetting = titleRules.getEffectiveTagSetting;
export const getEffectiveIgnoreTitleWords = titleRules.getEffectiveIgnoreTitleWords;
export const getTitleProfile = titleRules.getTitleProfile;
// Named challenge-settings profiles (survive challenge rotation).
// The caps are exported so tests and the get-settings-schema handler
// share the same literals the facade enforces.
export const getChallengeOverrides = challengeOverrides.getChallengeOverrides;
export const replaceChallengeOverrides = challengeOverrides.replaceChallengeOverrides;
export const getChallengeProfiles = profiles.getChallengeProfiles;
export const saveChallengeProfile = profiles.saveChallengeProfile;
export const deleteChallengeProfile = profiles.deleteChallengeProfile;
export const applyChallengeProfile = profiles.applyChallengeProfile;
export const seedIntentProfiles = profiles.seedIntentProfiles;
export const MAX_CHALLENGE_PROFILES = profiles.MAX_CHALLENGE_PROFILES;
export const MAX_PROFILE_NAME_LENGTH = profiles.MAX_PROFILE_NAME_LENGTH;
// User-defined scenarios (survive challenge rotation) and their JSON
// import/export. Results are {ok, name} / {ok: false, issues}.
export const getScenarios = scenarios.getScenarios;
export const getScenarioLibrary = scenarios.getScenarioLibrary;
export const getScenario = scenarios.getScenario;
export const saveScenario = scenarios.saveScenario;
export const renameScenario = scenarios.renameScenario;
export const deleteScenario = scenarios.deleteScenario;
export const describeScenario = scenarios.describeScenario;
export const checkScenario = scenarios.checkScenario;
export const previewScenarioImport = scenarios.previewScenarioImport;
export const importScenario = scenarios.importScenario;
export const exportScenario = scenarios.exportScenario;
export const exportScenarioWithNotes = scenarios.exportScenarioWithNotes;
export const MAX_SCENARIOS = scenarios.MAX_SCENARIOS;
// The lifecycle of an assignment (settings/scenarioLifecycle.ts): the installation scenario and its owner, the handoff
// to another scenario, the interrupted handoff the runner finishes, and the priority Stop fence.
export const getInstallationScenario = scenarioLifecycle.getInstallationScenario;
export const installationGeneration = scenarioLifecycle.installationGeneration;
export const setInstallationScenario = scenarioLifecycle.setInstallationScenario;
export const transferInstallationOwner = scenarioLifecycle.transferInstallationOwner;
export const requestScenarioHandoff = scenarioLifecycle.requestScenarioHandoff;
export const setScenarioPaused = scenarioLifecycle.setScenarioPaused;
export const settleHandoff = scenarioLifecycle.settleHandoff;
export const unresolvedScenarioWork = scenarioLifecycle.unresolvedWork;
export const readStopFence = scenarioLifecycle.readStopFence;
export const initializeStopFence = scenarioLifecycle.initializeStopFence;
export const recordFullStop = scenarioLifecycle.recordFullStop;
export const clearStopBlock = scenarioLifecycle.clearStopBlock;
export const armIfAllowed = scenarioLifecycle.armIfAllowed;
export const withdrawInstallationPublication = scenarioLifecycle.withdrawInstallationPublication;
export const restoreInstallationPublication = scenarioLifecycle.restoreInstallationPublication;
export const isArmAllowed = scenarioLifecycle.isArmAllowed;
// The ordinary control inbox (settings/scenarioControls.ts): the identity and recorded result of each remote scenario change.
export const beginControlRequest = scenarioControls.beginControlRequest;
export const finishControlRequest = scenarioControls.finishControlRequest;
export const readControlStatus = scenarioControls.readControlStatus;
export const claimServiceControlRequests = scenarioControls.claimServiceRequests;
export const refreshScenarioControlsAsync = scenarioControls.refreshScenarioControlsAsync;
export const SERVICE_EXECUTOR = scenarioControls.SERVICE_EXECUTOR;
export const CONTROL_ID_PATTERN = scenarioControls.CONTROL_ID_PATTERN;
export const CONTROL_NAME_PATTERN = scenarioControls.CONTROL_NAME_PATTERN;
export const CONTROL_MAX_ERROR = scenarioControls.CONTROL_MAX_ERROR;
export type ControlStatusQuery = scenarioControls.ControlStatusQuery;
export type ClaimedControlRequest = scenarioControls.ClaimedRequest;
export type ScenarioRefusal = scenarios.ScenarioRefusal;
export type InstallationResult = scenarioLifecycle.InstallationResult;
export type HandoffResult = scenarioLifecycle.HandoffResult;
export type PauseResult = scenarioLifecycle.PauseResult;
export type StopFenceRead = scenarioLifecycle.StopFenceRead;
// What a scenario may read or write per configuration key: the serialized projection, and one key's capability.
export const getScenarioCapabilities = scenarioCapabilities.getScenarioCapabilities;
export const scenarioCapability = scenarioCapabilities.scenarioCapability;
// First-seen challenge-title pins (internal cache — no IPC wiring).
// MAX_TITLE_LENGTH is exported so challengeTitlePin.ts bounds incoming
// titles with the same cap mergeTitlePins accepts.
export const getTitlePins = titlePins.getTitlePins;
export const mergeTitlePins = titlePins.mergeTitlePins;
// The photo a challenge's Boost and Turbo are pinned to. `getEntryPins` is what is in force for the challenge now (its
// scenario phase's runtime pin, then the phase's pin, then the saved one: what the Boost and Turbo picks, the status and the
// scenario facts read); `getStoredEntryPins` is what the user saved, which only `setEntryPin` writes (IPC: get-entry-pins /
// set-entry-pin).
export const getEntryPins = challengeOverrides.getEffectiveEntryPins;
export const getStoredEntryPins = entryPins.getEntryPins;
export const setEntryPin = entryPins.setEntryPin;
export const isPinnableImageId = entryPins.isPinnableImageId;
// The account's named photo pools, which a scenario phase draws photos from; what a phase has given out of one is in the
// scenario ledger (getChosenPoolView). A delete or a rename of a pool a stored scenario uses goes through the lifecycle gate.
export const getPhotoPools = entryPins.getPhotoPools;
export const setPhotoPool = entryPins.setPhotoPool;
export const createPhotoPool = entryPins.createPhotoPool;
export const deletePhotoPool = scenarios.deletePhotoPool;
export const renamePhotoPool = scenarios.renamePhotoPool;
export const getChosenPoolView = challengeOverrides.getChosenPoolView;
// What a challenge's phase published for its dynamic submit, vote and pause schedules (none, resolved, or unavailable).
export const getPhaseSchedules = challengeOverrides.getPhaseSchedules;
export const getPoolViewFor = challengeOverrides.getPoolViewFor;
export const recordPhotoPoolEvents = challengeOverrides.recordPhotoPoolEvents;
export const reconcilePhotoPool = challengeOverrides.reconcilePhotoPool;
export type PhotoPoolView = challengeOverrides.PhotoPoolView;
export type PhaseSchedulesRead = challengeOverrides.PhaseSchedulesRead;
// Cleanup functions
export const cleanupStaleChallengeSetting = staleChallengeCleanup.cleanupStaleChallengeSetting;
// What the last complete post-close pass found in the completed listing (null: forget it), for cleanup to go by.
export const rememberPostCloseListing = staleChallengeCleanup.rememberPostCloseListing;
// The open (joinable) challenge ids cleanupStaleChallengeSetting spares chosen-photo entries for
export const rememberOpenChallengeIds = openChallenges.rememberOpenChallengeIds;
export const getOpenChallengeIds = openChallenges.getOpenChallengeIds;
// The upcoming (not started) ids Discover listed: written by the Discover handler alone
export const rememberUpcomingChallenges = openChallenges.rememberUpcomingChallenges;
export const getUpcomingChallengeIds = openChallenges.getUpcomingChallengeIds;
export const forgetOpenChallengeIds = openChallenges.forgetOpenChallengeIds;
// Reset functions
export const resetSetting = reset.resetSetting;
export const resetGlobalDefault = reset.resetGlobalDefault;
export const resetAllGlobalDefaults = reset.resetAllGlobalDefaults;
export const resetAllSettings = reset.resetAllSettings;
export const isSettingModified = reset.isSettingModified;
export const isGlobalDefaultModified = reset.isGlobalDefaultModified;
export {
    initializeAsync,
    flushPendingWrites,
    getDefaultSettings,
    getUserDataPath,
    getSettingsPath,
    getEnvironmentInfo,
    titleRuleTitles,
    TITLE_RULE_INLINE_KEYS,
    rememberChallengeTitles,
    MAX_TITLE_LENGTH,
    getValidationError,
    getSettingsSchema,
    SETTINGS_SCHEMA,
    SETTINGS_GROUPS,
    SETTINGS_TIERS,
};
