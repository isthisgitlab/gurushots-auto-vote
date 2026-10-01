/**
 * Settings facade — the only module callers import. It re-exports the public
 * surface of the internal ./settings/* modules:
 *
 *   schema.ts             keys, defaults, validation, groups/tiers
 *   storage.ts            persistence transport + runtime/environment detection
 *   defaults.ts           default blob and shared challenge-value helpers
 *   persistence.ts        load (merge + migrations + obsolete cleanup) / save,
 *                         top-level keys, window bounds
 *   migrations.ts         load-time migrations and obsolete-key prune
 *   challengeOverrides.ts global defaults, per-challenge overrides, effective values
 *   challengeFacts.ts     process-local cache of the active challenges' titles/facts
 *   titleRuleSanitize.ts  write-side validation of challenge rules
 *   ruleResolution.ts     read-side rule matching, profile layer, suppression
 *   titleRules.ts         persisted challenge rules and rule-aware resolvers
 *   profileStore.ts       profile names and value sanitization
 *   profiles.ts           named challenge-settings profiles
 *   titlePins.ts          persisted first-seen challenge-title pins
 *   scenarioSchema.ts     validation of user-defined scenario documents
 *   scenarios.ts          stored scenarios, JSON import/export
 *   scenarioOverlay.ts    the active scenario phase's settings layer
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
    initializeAsync,
    flushPendingWrites,
    getUserDataPath,
    getSettingsPath,
    getEnvironmentInfo,
} from './settings/storage';
import { getDefaultSettings } from './settings/defaults';
import * as persistence from './settings/persistence';
import * as challengeOverrides from './settings/challengeOverrides';
import { rememberChallengeTitles } from './settings/challengeFacts';
import { TITLE_RULE_INLINE_KEYS, MAX_TITLE_LENGTH } from './settings/titleRuleSanitize';
import * as titleRules from './settings/titleRules';
import * as profiles from './settings/profiles';
import * as titlePins from './settings/titlePins';
import * as scenarios from './settings/scenarios';
import * as reset from './settings/reset';

export const loadSettings = persistence.loadSettings;
export const saveSettings = persistence.saveSettings;
export const getSetting = persistence.getSetting;
export const setSetting = persistence.setSetting;
export const isReloadRequired = persistence.isReloadRequired;
export const saveWindowBounds = persistence.saveWindowBounds;
export const getWindowBounds = persistence.getWindowBounds;
// Challenge-specific settings
export const getGlobalDefault = challengeOverrides.getGlobalDefault;
export const setGlobalDefault = challengeOverrides.setGlobalDefault;
export const getChallengeOverride = challengeOverrides.getChallengeOverride;
export const setChallengeOverride = challengeOverrides.setChallengeOverride;
export const setChallengeOverrides = challengeOverrides.setChallengeOverrides;
export const removeChallengeOverride = challengeOverrides.removeChallengeOverride;
export const getEffectiveSetting = challengeOverrides.getEffectiveSetting;
// Challenge rules (survive challenge rotation)
export const getTitleRules = titleRules.getTitleRules;
export const setTitleRules = titleRules.setTitleRules;
export const resolveRuleSetting = titleRules.resolveRuleSetting;
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
export const getScenario = scenarios.getScenario;
export const saveScenario = scenarios.saveScenario;
export const renameScenario = scenarios.renameScenario;
export const deleteScenario = scenarios.deleteScenario;
export const describeScenario = scenarios.describeScenario;
export const checkScenario = scenarios.checkScenario;
export const previewScenarioImport = scenarios.previewScenarioImport;
export const importScenario = scenarios.importScenario;
export const exportScenario = scenarios.exportScenario;
export const MAX_SCENARIOS = scenarios.MAX_SCENARIOS;
// First-seen challenge-title pins (internal cache — no IPC wiring).
// MAX_TITLE_LENGTH is exported so challengeTitlePin.ts bounds incoming
// titles with the same cap mergeTitlePins accepts.
export const getTitlePins = titlePins.getTitlePins;
export const mergeTitlePins = titlePins.mergeTitlePins;
// Cleanup functions
export const cleanupStaleChallengeSetting = challengeOverrides.cleanupStaleChallengeSetting;
export const cleanupObsoleteSettings = persistence.cleanupObsoleteSettings;
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
