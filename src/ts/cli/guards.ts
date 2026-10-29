/**
 * Small CLI guard helpers shared across commands: the auth gate every
 * networked command starts with, the profile-argument validation the
 * three profile commands repeat, the --challenge requirement the
 * challenge-scoped action commands share, and the shared challenge lookup
 * the command implementations start with, plus the failed-fetch message the
 * active-challenges reads print. Each caller keeps its own
 * return shape; only the check + user-facing guidance live here.
 */

import * as logger from '../logger';
import { getMiddleware } from '../apiFactory';
import { findActionableChallenge } from '../services/findActiveChallenge';
import { errorMessage } from '../errorMessage';

import type { ActiveChallengesResponse, Challenge } from '../types/gurushots';

// What the IPC handlers' 'invalid-args' refusal means for the CLI user.
const INVALID_ID_TEXT = 'Invalid challenge or image id.';

/**
 * The failed-fetch message the active-challenges reads share — challengesCmd's
 * listing and resolveChallenge's action lookup: what happened (the read did
 * not succeed, so nothing was shown or changed) and what to do next (the
 * connection, or an expired login). `error` carries a thrown error's text
 * when there is one.
 */
const failedFetchMessage = (error?: string): string =>
    `Could not read the active challenges from GuruShots${error ? `: ${error}` : ''}, so nothing was shown or changed. Check the connection and try again. If the login has expired, run login first.`;

/**
 * True when a getActiveChallenges response carries no usable list — the
 * request failed outright (a null response) or the transport marked it
 * failed. Either way it reads as an empty list downstream, so every caller
 * reports the fetch's failure through failedFetchMessage instead of looking
 * an id up and blaming a missing challenge.
 */
const failedFetch = (resp: ActiveChallengesResponse | null | undefined): boolean =>
    resp == null || resp.fetchFailed === true;

/**
 * True when a token is present. On miss, logs the standard "login first"
 * guidance; the caller decides what to return/exit.
 */
const ensureAuthenticated = () => {
    if (getMiddleware().isAuthenticated()) return true;
    logger.withCategory('authentication').error('No authentication token found. Please login first');
    logger.withCategory('ui').info('Run: login');
    return false;
};

/**
 * Shared auth guard + challenge lookup. Returns the live challenge object,
 * or null after logging a user-facing reason (not authenticated / not found
 * / data cannot be read / fetch failure) so callers can simply bail on null.
 *
 * Note: the turbo/fill handlers re-fetch and re-validate the live challenge
 * themselves, so this lookup is the friendly auth gate + early "not found"
 * (and the source of the title for logging), not the authoritative state
 * check — don't remove the handlers' own fetch on the assumption this covers it.
 */
const resolveChallenge = async (challengeId: string): Promise<Challenge | null> => {
    if (!ensureAuthenticated()) {
        return null;
    }
    try {
        const resp = await getMiddleware().getActiveChallenges();
        // A failed fetch reads as an empty list, so without this gate it would
        // be reported as "not found" — the fetch's failure is the real cause.
        if (failedFetch(resp)) {
            logger.withCategory('challenges').error(failedFetchMessage());
            return null;
        }
        const found = findActionableChallenge(resp, challengeId);
        if ('refused' in found) {
            // The handlers re-read below refuse the same way, so bailing here
            // only spares the round trip; the wording is the user-facing part.
            if (found.refused === 'data-incomplete') {
                logger.withCategory('challenges').error(`Challenge ${challengeId}: challenge data cannot be read`);
            } else {
                logger.withCategory('challenges').error(`Challenge ${challengeId} not found among active challenges`);
            }
            return null;
        }
        return found.challenge;
    } catch (err) {
        logger.withCategory('challenges').error(failedFetchMessage(errorMessage(err) || String(err)));
        return null;
    }
};

/**
 * The usage line the profile commands share: `needsChallenge` adds the
 * --challenge=<id> requirement. One home — requireProfileArgs prints it on
 * a missing or extra argument, and profileCommand (commandKit.ts) on a
 * repeated --challenge.
 */
const profileUsage = (command: string, needsChallenge: boolean): string =>
    needsChallenge ? `Usage: ${command} "<name>" --challenge=<id>` : `Usage: ${command} "<name>"`;

/**
 * Validate the `<name>` (+ optional --challenge=<id>) arguments the profile
 * commands share. Exits the process with usage guidance on any miss;
 * returns the validated profile name otherwise.
 *
 * @param command - e.g. 'save-profile' (used in usage strings)
 * @param parsed - extractChallenge() output
 * @returns the profile name
 */
const requireProfileArgs = (
    command: string,
    { challengeId, rest }: { challengeId: string | null; rest: string[] },
    { needsChallenge = false, challengeHint = '' }: { needsChallenge?: boolean; challengeHint?: string } = {},
): string => {
    const usage = profileUsage(command, needsChallenge);
    if (!rest[0]) {
        logger.withCategory('ui').error('Please specify a profile name');
        logger.withCategory('ui').info(usage);
        process.exit(1);
    }
    if (rest.length > 1) {
        // An unquoted multi-word name splits into several argv tokens —
        // fail loudly rather than acting on the first word.
        logger.withCategory('ui').error(`Unexpected extra arguments: ${rest.slice(1).join(' ')}`);
        logger
            .withCategory('ui')
            .info(
                `Quote profile names containing spaces: ${command} "2-pic tactic"${needsChallenge ? ' --challenge=<id>' : ''}`,
            );
        process.exit(1);
    }
    if (needsChallenge && !challengeId) {
        logger.withCategory('ui').error(challengeHint);
        logger.withCategory('ui').info(usage);
        process.exit(1);
    }
    return rest[0];
};

/**
 * Require the --challenge=<id> argument the challenge-scoped action commands
 * (boost / turbo / fill) share. Exits the process with the command's usage
 * guidance on a miss; returns the challenge id otherwise.
 *
 * @param parsed - extractChallenge() output
 * @param usage - the command's usage string
 * @returns the challenge id
 */
const requireChallenge = ({ challengeId }: { challengeId: string | null }, usage: string): string => {
    if (challengeId == null) {
        logger.withCategory('ui').error('Please specify a challenge');
        logger.withCategory('ui').info(usage);
        process.exit(1);
    }
    return challengeId;
};

export {
    ensureAuthenticated,
    failedFetch,
    failedFetchMessage,
    profileUsage,
    requireProfileArgs,
    requireChallenge,
    resolveChallenge,
    INVALID_ID_TEXT,
};
