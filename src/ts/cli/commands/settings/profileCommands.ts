// List, save, apply and delete challenge-settings profiles from the CLI.
// The profile listing prints to the console only (never into the log files): it carries the
// account's per-challenge settings, masked by formatSettingForLog.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import { stripTerminalControl } from '../../../format/logSafe';
import { formatSettingForLog } from './shared';

export const listProfiles = () => {
    try {
        const profiles = settings.getChallengeProfiles();
        const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
        if (names.length === 0) {
            logger.printLine('No saved challenge profiles');
            logger.printLine('💡 Save one with: save-profile "<name>" --challenge=<id>');
            return;
        }
        logger.printLine('=== Challenge Profiles ===');
        names.forEach((name) => {
            const values = profiles[name];
            const keys = Object.keys(values).sort();
            const summary =
                keys.length === 0
                    ? '(no overrides — applying it resets the challenge to global defaults)'
                    : keys.map((key) => `${key}=${formatSettingForLog(key, values[key])}`).join(', ');
            logger.printLine(`${stripTerminalControl(name)} (${keys.length}): ${summary}`);
        });
    } catch (error) {
        logger.withCategory('settings').error('Error listing profiles', error);
    }
};

export const saveProfileFromChallenge = (name: string, challengeId: string) => {
    try {
        const overrides = settings.getChallengeOverrides(challengeId);
        if (settings.saveChallengeProfile(name, overrides)) {
            const count = Object.keys(overrides).length;
            logger
                .withCategory('settings')
                .success(`Saved profile "${name}" with ${count} override(s) from challenge ${challengeId}`);
        } else {
            logger
                .withCategory('settings')
                .error(
                    'Failed to save profile — the name is empty/too long/reserved, the profile cap is reached, or a value failed validation (see the settings log)',
                );
        }
    } catch (error) {
        logger.withCategory('settings').error('Error saving profile', error);
    }
};

export const applyProfile = (name: string, challengeId: string) => {
    try {
        if (settings.applyChallengeProfile(name, challengeId)) {
            logger.withCategory('settings').success(`Applied profile "${name}" to challenge ${challengeId}`);
            logger
                .withCategory('ui')
                .info(`💡 Run "list-settings --challenge=${challengeId}" to review the applied overrides`);
        } else {
            logger
                .withCategory('settings')
                .error(
                    `Failed to apply profile "${name}" — no such profile, or a value failed validation (see the settings log)`,
                );
        }
    } catch (error) {
        logger.withCategory('settings').error('Error applying profile', error);
    }
};

export const deleteProfile = (name: string) => {
    try {
        if (settings.deleteChallengeProfile(name)) {
            logger.withCategory('settings').success(`Deleted profile "${name}"`);
        } else {
            logger.withCategory('settings').error(`No profile named "${name}"`);
        }
    } catch (error) {
        logger.withCategory('settings').error('Error deleting profile', error);
    }
};
