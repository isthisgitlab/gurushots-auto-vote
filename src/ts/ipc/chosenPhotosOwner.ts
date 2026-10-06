/**
 * Which account a Chosen Photos list belongs to. Photo ids are only meaningful
 * for the account that owns them, so the settings IPC records the signed-in
 * member whenever a write carries a chosen list (`chosenPhotosMemberId`), and
 * the fill and join paths ignore the list for any other member
 * (services/autoFill/chosenPhotos.ts).
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
 * After a successful settings write: when it saved a chosen list and the
 * signed-in member is already known, record them as the list's owner. An
 * unknown member leaves the record alone — it never guesses.
 *
 * @param args - the channel's arguments as the renderer sent them
 */
const stampChosenPhotosOwner = (args: readonly unknown[]): void => {
    // The single-key channels (`set-global-default(key, value)`,
    // `set-challenge-override(key, id, value)`) name the key first.
    const last = args[args.length - 1];
    const single = args[0] === 'chosenPhotos' && Array.isArray(last) && last.length > 0;
    if (!single && !args.some((arg) => carriesChosenList(arg))) return;
    const { token } = settings.loadSettings();
    const memberId = token ? peekMemberId(token) : null;
    if (memberId !== null && settings.getSetting('chosenPhotosMemberId') !== memberId) {
        settings.setSetting('chosenPhotosMemberId', memberId);
    }
};

export { stampChosenPhotosOwner };
