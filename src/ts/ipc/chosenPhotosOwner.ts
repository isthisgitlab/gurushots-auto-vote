/**
 * Which account a Chosen Photos list belongs to. Photo ids are only meaningful
 * for the account that owns them, so the settings IPC records the signed-in
 * member whenever a write carries a chosen list (`chosenPhotosMemberId`), and
 * the fill and join paths ignore the list for any other member
 * (services/autoFill/chosenPhotos.ts). The CLI records the owner through
 * `recordChosenPhotosOwner` too.
 */

import * as settings from '../settings';
import { peekMemberId } from '../services/autoFill';

const MAX_DEPTH = 6;

/**
 * Whether a written value holds a non-empty `chosenPhotos` list anywhere in
 * its structure (a challenge's overrides, a rule list, a profile, a scenario's
 * phase settings).
 */
const carriesChosenList = (value: unknown, depth: number = 0): boolean => {
    if (depth > MAX_DEPTH || !value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some((item) => carriesChosenList(item, depth + 1));
    return Object.entries(value).some(
        ([key, item]) =>
            (key === 'chosenPhotos' && Array.isArray(item) && item.length > 0) || carriesChosenList(item, depth + 1),
    );
};

/**
 * Whether a settings write, as its arguments, saves a chosen list. The
 * single-key channels (`set-global-default(key, value)`,
 * `set-challenge-override(key, id, value)`) name the key first and the value
 * last.
 */
const writeCarriesChosenList = (args: readonly unknown[]): boolean => {
    const last = args[args.length - 1];
    const single = args[0] === 'chosenPhotos' && Array.isArray(last) && last.length > 0;
    return single || args.some((arg) => carriesChosenList(arg));
};

/**
 * Record `memberId` as the owner of the saved lists. An unknown member (null)
 * leaves the record alone — it never guesses.
 */
const recordChosenPhotosOwner = (memberId: string | null): void => {
    if (memberId !== null && settings.getSetting('chosenPhotosMemberId') !== memberId) {
        settings.setSetting('chosenPhotosMemberId', memberId);
    }
};

/**
 * After a successful settings write: when it saved a chosen list and the
 * signed-in member is already known, record them as the list's owner.
 *
 * @param args - the channel's arguments as the renderer sent them
 */
const stampChosenPhotosOwner = (args: readonly unknown[]): void => {
    if (!writeCarriesChosenList(args)) return;
    const { token } = settings.loadSettings();
    recordChosenPhotosOwner(token ? peekMemberId(token) : null);
};

export { stampChosenPhotosOwner, recordChosenPhotosOwner, writeCarriesChosenList };
