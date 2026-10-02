/**
 * CLI settings commands. Each function is a thin shell around the
 * settings facade; the CLI host (cli.ts) handles argv parsing and
 * exit codes, this module formats values, validates schema keys,
 * and emits the user-facing logs.
 */

export { formatSettingForLog } from './settings/shared';
export { getSetting, setSetting, setGlobalDefault } from './settings/access';
export { listSettings, dumpSchema, listGlobalDefaults } from './settings/listing';
export { resetSetting, resetGlobalDefault, resetAllSettings, resetWindows } from './settings/resetCommands';
export { listProfiles, saveProfileFromChallenge, applyProfile, deleteProfile } from './settings/profileCommands';
export { helpSettings } from './settings/help';
