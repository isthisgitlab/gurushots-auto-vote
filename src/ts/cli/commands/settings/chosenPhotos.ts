// Chosen Photos from the CLI: recording which account saved a list, and removing every saved list.

import * as logger from '../../../logger';
import * as settings from '../../../settings';
import * as apiFactory from '../../../apiFactory';
import { resolveMemberId } from '../../../services/autoFill';
import { recordChosenPhotosOwner, writeCarriesChosenList } from '../../../ipc/chosenPhotosOwner';
import { parseSettingValue } from '../../parseValue';

/**
 * After the CLI saved `key`: when it saved a Chosen Photos list, record the
 * signed-in account as the list's owner — the same record the settings IPC
 * keeps, so a list saved here is not ignored as "another account's" — and warn
 * when lists saved under a different account are now going to apply to this one.
 * An account that cannot be resolved leaves the record unchanged.
 *
 * @param value - the raw argv token that was saved
 */
export const noteChosenPhotosOwner = async (key: string, value: string): Promise<void> => {
    if (!writeCarriesChosenList([key, parseSettingValue(value)])) return;
    const { token } = settings.loadSettings();
    if (!token) return;
    const memberId = await resolveMemberId(
        token,
        apiFactory.getApiStrategy().getCurrentMemberProfile,
        logger,
        'settings',
    );
    if (memberId === null) return;
    const savedBy = settings.getSetting('chosenPhotosMemberId');
    if (typeof savedBy === 'string' && savedBy !== '' && savedBy !== memberId) {
        logger
            .withCategory('settings')
            .warning(
                'Chosen-photo lists saved under another account stay in your settings and now apply to this account too. Remove them with: clear-chosen-photos',
            );
    }
    recordChosenPhotosOwner(memberId);
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
