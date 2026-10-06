// Chosen Photos from the CLI: recording which account saved a list, and removing every saved list.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import * as apiFactory from '../../../apiFactory';
import { resolveMemberId } from '../../../services/autoFill';
import { recordChosenPhotosOwner, writeCarriesChosenList } from '../../../ipc/chosenPhotosOwner';
import { parseSettingValue } from '../../parseValue';

/**
 * Before the CLI saves `key`: when it is about to save a Chosen Photos list, look up
 * the signed-in account and — when lists saved under a different account are on
 * record, which saving now makes apply to this one too — say so, with the remedy.
 * Returns what to run once the write has landed: it records the signed-in account as
 * the list's owner, the same record the settings IPC keeps, so a list saved here is
 * not ignored as "another account's". An account that cannot be resolved (or a write
 * that carries no list) leaves the record unchanged: the returned function does nothing.
 *
 * @param value - the raw argv token about to be saved
 */
export const beforeChosenPhotosWrite = async (key: string, value: string): Promise<() => void> => {
    const nothing = () => undefined;
    if (!writeCarriesChosenList([key, parseSettingValue(value)])) return nothing;
    const { token } = settings.loadSettings();
    if (!token) return nothing;
    const memberId = await resolveMemberId(
        token,
        apiFactory.getApiStrategy().getCurrentMemberProfile,
        logger,
        'settings',
    );
    if (memberId === null) return nothing;
    const savedBy = settings.getSetting('chosenPhotosMemberId');
    if (typeof savedBy === 'string' && savedBy !== '' && savedBy !== memberId) {
        logger
            .withCategory('settings')
            .warning(
                'Chosen-photo lists saved under another account stay in your settings and will apply to this account too once this list is saved. To remove them, run clear-chosen-photos (it also removes the list you are setting now), then set this list again.',
            );
    }
    return () => recordChosenPhotosOwner(memberId);
};

/**
 * `clear-chosen-photos`: remove every saved Chosen Photos list (global, per
 * challenge, rules, profiles, scenarios) and forget which account saved them.
 * Submit Only Chosen Photos is left as it is.
 *
 * @returns whether the settings were saved
 */
export const clearChosenPhotos = (): boolean => {
    try {
        const removed = settings.clearChosenPhotos();
        if (removed === null) {
            logger
                .withCategory('settings')
                .error('Could not remove the chosen-photo lists — the settings file could not be saved');
            return false;
        }
        logger
            .withCategory('settings')
            .success(`Removed ${removed} chosen-photo list(s) from settings, rules, profiles and scenarios`);
        return true;
    } catch (error) {
        logger.withCategory('settings').error('Error removing the chosen-photo lists', error);
        return false;
    }
};
