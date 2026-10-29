/**
 * CLI submit commands: `fillChallenge` drives the auto-fill path
 * (`fill-challenge-now`, the same handler the GUI card's submit uses) and
 * `submitPickedCmd` submits exactly the photos named (`submit-picked-photos`).
 * Both report through the shared submit outcome wording and return the exit
 * code the `submit` command yields.
 */

import * as logger from '../../logger';
import { resolveChallenge } from '../guards';
import { actionError } from './spend';
import { stripTerminalControl } from '../../format/logSafe';

import type { NullEventHandlers } from '../../types/cli';
import type * as actions_handlersModule from '../../ipc/actions.handlers';
import { errorMessage } from '../../errorMessage';
type ActionHandlers = NullEventHandlers<ReturnType<typeof actions_handlersModule.buildHandlers>>;

// Built lazily on first use so simply requiring this module (e.g. when the
// dispatcher loads it for `help` or `logout`) does not construct the handler
// set or pull in its transitive dependencies.
let _handlers: ActionHandlers | undefined;
const handlers = (): ActionHandlers =>
    (_handlers ??= (
        require('../../ipc/actions.handlers') as typeof import('../../ipc/actions.handlers')
    ).buildHandlers());

// The wording both submit paths (fill-challenge-now and submit-picked-photos)
// share for the handler's fixed error codes: what happened and what to do next.
// 'submit-unclear' is never shown as a failure — the photo(s) may have been
// submitted, so it exits 2 instead of 1.
const SUBMIT_OUTCOME_TEXT: Record<string, string> = {
    'not-enough-slots':
        'The challenge has fewer open slots than photos to submit, so nothing was sent. Submit fewer photos, or wait for a slot to free up.',
    'already-entered':
        'One of those photos is already entered in this challenge, so nothing was sent. Submit without it.',
    'submit-rejected':
        'GuruShots rejected the submit, so nothing was sent. Check the challenge on the GuruShots website, then try again.',
    'submit-busy': 'A submit for this challenge is already running. Wait for it to finish, then run the command again.',
    'submit-unclear':
        'The submit got no answer, so the photo(s) may have been submitted. Check the challenge before retrying.',
};

// The line for a failed submit reply: the fixed submit codes are worded from the
// shared table — 'submit-unclear' as a warning, never as a failure — and any
// other error (the invalid-id wording, a challenge-data-incomplete refusal, a
// free-text message carrying API wording) is stripped before it reaches the
// terminal. Returns the exit code: 2 for unclear, 1 otherwise.
const reportSubmitFailure = (result: { error?: string | null } | null | undefined): number => {
    const code = result?.error;
    if (code === 'submit-unclear') {
        logger.withCategory('autoSubmit').warning(SUBMIT_OUTCOME_TEXT['submit-unclear']);
        return 2;
    }
    const text =
        code !== undefined && code !== null && Object.hasOwn(SUBMIT_OUTCOME_TEXT, code)
            ? SUBMIT_OUTCOME_TEXT[code]
            : actionError(result, 'Failed to submit photos');
    logger.withCategory('autoSubmit').error(stripTerminalControl(text));
    return 1;
};

/**
 * Submit photo(s) to a challenge's empty slots through the auto-fill path
 * (`fill-challenge-now`). `--all` submits to every empty slot; otherwise a
 * single best-ranked eligible photo is submitted. Returns the exit code:
 * 0 sent, 2 the submit got no answer (it may have landed), 1 every other
 * failure, including an unknown challenge or a thrown handler.
 */
const fillChallenge = async (challengeId: string, { all = false }: { all?: boolean } = {}): Promise<number> => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return 1;

    const mode = all ? 'all' : 'one';
    try {
        const result = await handlers()['fill-challenge-now'](null, challengeId, mode);
        if (result?.success) {
            logger
                .withCategory('autoSubmit')
                .success(
                    `${result.message || `Submitted photos to "${challenge.title}"`} (submitted ${result.submitted ?? 0}, skipped ${result.skipped ?? 0})`,
                );
            return 0;
        }
        return reportSubmitFailure(result);
    } catch (err) {
        logger
            .withCategory('autoSubmit')
            .error(`Failed to submit photos: ${stripTerminalControl(errorMessage(err) || err)}`);
        return 1;
    }
};

/**
 * Submit exactly the photos named with `--image=<id>[,<id>…]` through the same
 * handler the card's picked-photos submit uses (submit-picked-photos): no
 * ranking, no tag rules — the ids go to the challenge as given. Returns the
 * exit code: 0 sent, 2 unclear (may have landed), 1 every other failure.
 */
const submitPickedCmd = async (challengeId: string, imageIds: string[]): Promise<number> => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return 1;
    try {
        const result = await handlers()['submit-picked-photos'](null, challengeId, imageIds);
        if (result?.success) {
            logger
                .withCategory('autoSubmit')
                .success(`Submitted ${result.submitted} photo(s) to "${challenge.title}".`);
            return 0;
        }
        return reportSubmitFailure(result);
    } catch (err) {
        logger
            .withCategory('autoSubmit')
            .error(`Failed to submit photos: ${stripTerminalControl(errorMessage(err) || err)}`);
        return 1;
    }
};

export { fillChallenge, submitPickedCmd };
