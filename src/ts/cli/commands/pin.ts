/**
 * CLI `pin`: the parity of the challenge card's "Pin for Boost / Turbo" toggles. It reads and writes through the
 * same `get-entry-pins` / `set-entry-pin` handlers the GUI uses, called with a null event like the Capacitor
 * bridge does, so the id is validated the same way and the pin cap applies.
 */

import * as logger from '../../logger';
import { stripTerminalControl } from '../../format/logSafe';
import { errorMessage } from '../../errorMessage';
import { canStillFire, featureNeverFires, findPinnedEntry } from '../../voting/entryPins';
import { actionError, resolveChallenge } from './actions';

import type { Challenge } from '../../types/gurushots';
import type { NullEventHandlers } from '../../types/cli';
import type { EntryPinKind } from '../../types/settings';
import type { NeverFiresReason } from '../../voting/entryPins';
import type * as settings_handlersModule from '../../ipc/settings.handlers';
type SettingsHandlers = NullEventHandlers<ReturnType<typeof settings_handlersModule.buildHandlers>>;

// Built lazily on first use, like the other command modules: requiring this one must not build the handler set.
let _settingsHandlers: SettingsHandlers | undefined;
const settingsHandlers = (): SettingsHandlers =>
    (_settingsHandlers ??= (
        require('../../ipc/settings.handlers') as typeof import('../../ipc/settings.handlers')
    ).buildHandlers());

const PIN_USAGE = 'Usage: pin --challenge=<id> [--boost=<imageId|none>] [--turbo=<imageId|none>]';

// What a failed save says, per machine code from `set-entry-pin`; other failures use the shared action wording.
const PIN_ERROR_TEXT: Record<string, string> = {
    'pin-cap-reached':
        'Too many challenges already have pins. Pins are removed when a challenge ends; clear a pin on another challenge, then try again.',
    'pin-write-failed': 'The settings file could not be written. Try again.',
};

// What a challenge that can never take the feature is, per reason from `featureNeverFires`.
const NEVER_FIRES_TEXT: Record<NeverFiresReason, string> = {
    flash: 'a flash challenge',
    'single-photo': 'a single-photo challenge, so Boost never unlocks',
    exhibition: 'an exhibition challenge',
};

// A challenge id is printed at most this long, like `status` does: the argument can be any length.
const MAX_PRINTED_ID = 64;

/**
 * A line saying why pinning `imageId` for `kind` cannot take effect on the challenge, or null when it can. The
 * pin is saved either way: the challenge may change, or the id may be entered later. Judged by the same rules as
 * the card's pin toggles and the voting pass (voting/entryPins).
 */
const pinProblem = (
    challenge: Challenge | null,
    kind: EntryPinKind,
    imageId: string | null,
    label: string,
): string | null => {
    if (!challenge || imageId === null) return null;
    const neverFires = featureNeverFires(challenge, kind);
    if (neverFires) {
        return `${kind} never fires on ${label}: it is ${NEVER_FIRES_TEXT[neverFires]} — pinning it anyway.`;
    }
    if (!canStillFire(challenge, kind)) {
        return `${kind} can no longer fire on ${label}: it is already used or spent — pinning it anyway.`;
    }
    const other = kind === 'boost' ? 'turbo' : 'boost';
    return findPinnedEntry(challenge, kind, imageId).state === 'conflict'
        ? `${imageId} already carries ${other} on ${label}, so it cannot take ${kind} — pinning it anyway.`
        : null;
};

const pinError = (result: { error?: string | null } | null | undefined, fallback: string): string =>
    result?.error && Object.hasOwn(PIN_ERROR_TEXT, result.error)
        ? PIN_ERROR_TEXT[result.error]
        : actionError(result, fallback);

/**
 * Pin a photo for a challenge's Boost and/or Turbo (`none` clears a pin), or —
 * with neither flag — print the current pins. Listing and clearing never look
 * the challenge up, so they work offline and logged out; pinning does, to warn
 * about an id that is not one of the challenge's current entries (it is saved
 * anyway: the pin takes effect if that photo is entered later) or a pin that
 * cannot take effect (also saved), and to name the challenge by its title. The
 * caller has already checked the image ids.
 *
 * @param pins - per feature: an image id, null to clear, undefined to leave as is
 * @returns false when a pin could not be read or saved
 */
const pinCmd = async (
    challengeId: string,
    pins: Partial<Record<EntryPinKind, string | null>> = {},
): Promise<boolean> => {
    const kinds = (['boost', 'turbo'] as const).filter((kind) => pins[kind] !== undefined);
    const idLabel = `challenge ${stripTerminalControl(challengeId).slice(0, MAX_PRINTED_ID)}`;
    try {
        if (kinds.length === 0) {
            const current = await settingsHandlers()['get-entry-pins'](null, challengeId);
            if (!current) {
                logger.withCategory('settings').error(`The pins on ${idLabel} could not be read. Try again.`);
                return false;
            }
            logger.withCategory('settings').info(`Pins on ${idLabel}:`);
            logger.withCategory('settings').info(`  Boost: ${current.boost ?? 'none'}`);
            logger.withCategory('settings').info(`  Turbo: ${current.turbo ?? 'none'}`);
            return true;
        }
        let challenge: Challenge | null = null;
        if (kinds.some((kind) => pins[kind] != null)) {
            challenge = await resolveChallenge(challengeId);
            if (!challenge) return false;
        }
        const label = challenge?.title ? `"${challenge.title}"` : idLabel;
        const entryIds = (challenge?.member?.ranking?.entries ?? []).map((entry) => String(entry.id));
        // One read of what is held now (null = unreadable), then followed through the saves in order, so the
        // lines describe what each save really did even when the command sets both features.
        const initial = await settingsHandlers()['get-entry-pins'](null, challengeId);
        const held = initial ? { boost: initial.boost, turbo: initial.turbo } : null;
        let ok = true;
        for (const kind of kinds) {
            const imageId = pins[kind] ?? null;
            const other = kind === 'boost' ? 'turbo' : 'boost';
            if (imageId === null && initial && initial[kind] == null) {
                logger.withCategory('settings').info(`${label} had no ${kind} pin`);
                continue;
            }
            if (imageId !== null && !entryIds.includes(imageId)) {
                logger
                    .withCategory('settings')
                    .warning(
                        `${imageId} is not one of the entries in ${label} (${entryIds.join(', ') || 'none'}) — pinning it anyway.`,
                    );
            }
            const problem = pinProblem(challenge, kind, imageId, label);
            if (problem) logger.withCategory('settings').warning(problem);
            // A photo is pinned for one feature only: saving it here drops the other feature's pin on it.
            const displaced = imageId !== null && held !== null && held[other] === imageId;
            const result = await settingsHandlers()['set-entry-pin'](null, kind, challengeId, imageId);
            if (!result?.success) {
                ok = false;
                logger.withCategory('settings').error(pinError(result, `Failed to pin for ${kind}`));
                continue;
            }
            if (held) {
                held[kind] = imageId;
                if (displaced) held[other] = null;
            }
            logger
                .withCategory('settings')
                .success(
                    imageId === null
                        ? `Cleared the ${kind} pin on ${label}`
                        : `Pinned ${imageId} for ${kind} on ${label}`,
                );
            // Said only when this command leaves that feature alone; otherwise its own line tells the outcome.
            if (displaced && pins[other] === undefined) {
                logger
                    .withCategory('settings')
                    .info(`Cleared the ${other} pin on ${label}: a photo is pinned for one feature only.`);
            }
        }
        return ok;
    } catch (err) {
        logger.withCategory('settings').error(`Failed to pin: ${errorMessage(err) || err}`);
        return false;
    }
};

export { pinCmd, PIN_USAGE };
