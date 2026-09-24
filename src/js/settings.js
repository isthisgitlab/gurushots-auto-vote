/**
 * Settings facade — the only module callers import. It re-exports the public
 * surface of the internal ./settings/* modules:
 *
 *   schema.js             keys, defaults, validation, groups/tiers
 *   storage.js            persistence transport + runtime/environment detection
 *   defaults.js           default blob and shared challenge-value helpers
 *   persistence.js        load (merge + migrations + obsolete cleanup) / save,
 *                         top-level keys, window bounds
 *   migrations.js         load-time migrations and obsolete-key prune
 *   challengeOverrides.js global defaults, per-challenge overrides, effective values
 *   challengeFacts.js     process-local cache of the active challenges' titles/facts
 *   titleRuleSanitize.js  write-side validation of challenge rules
 *   ruleResolution.js     read-side rule matching, profile layer, suppression
 *   titleRules.js         persisted challenge rules and rule-aware resolvers
 *   profileStore.js       profile names and value sanitization
 *   profiles.js           named challenge-settings profiles
 *   titlePins.js          persisted first-seen challenge-title pins
 *   reset.js              reset helpers and "modified" checks
 */

const {
    SETTINGS_SCHEMA,
    SETTINGS_GROUPS,
    SETTINGS_TIERS,
    getValidationError,
    getSettingsSchema,
} = require('./settings/schema');
const { titleRuleTitles } = require('./settings/challengeRules');
const {
    initializeAsync,
    flushPendingWrites,
    getUserDataPath,
    getSettingsPath,
    getEnvironmentInfo,
} = require('./settings/storage');
const { getDefaultSettings } = require('./settings/defaults');
const persistence = require('./settings/persistence');
const challengeOverrides = require('./settings/challengeOverrides');
const { rememberChallengeTitles } = require('./settings/challengeFacts');
const { TITLE_RULE_INLINE_KEYS, MAX_TITLE_LENGTH } = require('./settings/titleRuleSanitize');
const titleRules = require('./settings/titleRules');
const profiles = require('./settings/profiles');
const titlePins = require('./settings/titlePins');
const reset = require('./settings/reset');

module.exports = {
    initializeAsync,
    flushPendingWrites,
    loadSettings: persistence.loadSettings,
    saveSettings: persistence.saveSettings,
    getSetting: persistence.getSetting,
    setSetting: persistence.setSetting,
    isReloadRequired: persistence.isReloadRequired,
    getDefaultSettings,
    getUserDataPath,
    getSettingsPath,
    saveWindowBounds: persistence.saveWindowBounds,
    getWindowBounds: persistence.getWindowBounds,

    // Environment detection functions
    getEnvironmentInfo,

    // Challenge-specific settings
    getGlobalDefault: challengeOverrides.getGlobalDefault,
    setGlobalDefault: challengeOverrides.setGlobalDefault,
    getChallengeOverride: challengeOverrides.getChallengeOverride,
    setChallengeOverride: challengeOverrides.setChallengeOverride,
    setChallengeOverrides: challengeOverrides.setChallengeOverrides,
    removeChallengeOverride: challengeOverrides.removeChallengeOverride,
    getEffectiveSetting: challengeOverrides.getEffectiveSetting,
    getExposureResolver: challengeOverrides.getExposureResolver,

    // Challenge rules (survive challenge rotation)
    getTitleRules: titleRules.getTitleRules,
    titleRuleTitles,
    setTitleRules: titleRules.setTitleRules,
    resolveRuleSetting: titleRules.resolveRuleSetting,
    hasRuleJoinOptIn: titleRules.hasRuleJoinOptIn,
    TITLE_RULE_INLINE_KEYS,
    getEffectiveTagSetting: titleRules.getEffectiveTagSetting,
    getEffectiveIgnoreTitleWords: titleRules.getEffectiveIgnoreTitleWords,
    getTitleProfile: titleRules.getTitleProfile,
    rememberChallengeTitles,

    // Named challenge-settings profiles (survive challenge rotation).
    // The caps are exported so tests and the get-settings-schema handler
    // share the same literals the facade enforces.
    getChallengeOverrides: challengeOverrides.getChallengeOverrides,
    replaceChallengeOverrides: challengeOverrides.replaceChallengeOverrides,
    getChallengeProfiles: profiles.getChallengeProfiles,
    saveChallengeProfile: profiles.saveChallengeProfile,
    deleteChallengeProfile: profiles.deleteChallengeProfile,
    applyChallengeProfile: profiles.applyChallengeProfile,
    seedIntentProfiles: profiles.seedIntentProfiles,
    MAX_CHALLENGE_PROFILES: profiles.MAX_CHALLENGE_PROFILES,
    MAX_PROFILE_NAME_LENGTH: profiles.MAX_PROFILE_NAME_LENGTH,

    // First-seen challenge-title pins (internal cache — no IPC wiring).
    // MAX_TITLE_LENGTH is exported so challengeTitlePin.js bounds incoming
    // titles with the same cap mergeTitlePins accepts.
    getTitlePins: titlePins.getTitlePins,
    mergeTitlePins: titlePins.mergeTitlePins,
    MAX_TITLE_LENGTH,

    // Cleanup functions
    cleanupStaleChallengeSetting: challengeOverrides.cleanupStaleChallengeSetting,
    cleanupObsoleteSettings: persistence.cleanupObsoleteSettings,

    // Reset functions
    resetSetting: reset.resetSetting,
    resetGlobalDefault: reset.resetGlobalDefault,
    resetAllGlobalDefaults: reset.resetAllGlobalDefaults,
    resetAllSettings: reset.resetAllSettings,

    // Validation functions
    getValidationError,

    // Utility functions
    getSettingsSchema,
    isSettingModified: reset.isSettingModified,
    isGlobalDefaultModified: reset.isGlobalDefaultModified,

    // Schema
    SETTINGS_SCHEMA,
    SETTINGS_GROUPS,
    SETTINGS_TIERS,
};
