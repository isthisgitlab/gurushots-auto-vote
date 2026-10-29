/**
 * The CLI `deadlines` command: the per-challenge deadline-actions preview the
 * challenge card's timeline shows — which of auto-submit / emergency-submit /
 * boost / turbo will actually fire and when — plus the Boost/Turbo conflict
 * lines and when a blocking pin gives way. Read-only: it reaches the same
 * `get-deadline-actions` handler the renderer uses (which takes the whole
 * challenge object, so the challenge is resolved first), through a lazy
 * require like actions.ts's handler access. Nothing is spent, and the preview
 * is a snapshot: the runner re-reads live state before each action, so the
 * times can drift.
 */

import * as logger from '../../logger';
import { stripTerminalControl } from '../../format/logSafe';
import { formatDuration } from '../../format/duration';
import { errorMessage } from '../../errorMessage';
import { resolveChallenge } from './actions';

import type { NullEventHandlers } from '../../types/cli';
import type * as computations_handlersModule from '../../ipc/computations.handlers';
type ComputationHandlers = NullEventHandlers<ReturnType<typeof computations_handlersModule.buildHandlers>>;

// Built lazily on first use so simply requiring this module (the dispatcher
// loads it for `help`) does not construct the handler set or pull in its
// transitive dependencies.
let _handlers: ComputationHandlers | undefined;
const handlers = (): ComputationHandlers =>
    (_handlers ??= (
        require('../../ipc/computations.handlers') as typeof import('../../ipc/computations.handlers')
    ).buildHandlers());

// The action kinds the preview answers, worded as the card's timeline words them.
const ACTION_LABELS: Record<string, string> = {
    autoSubmit: 'Auto-submit',
    emergencySubmit: 'Emergency submit',
    boost: 'Boost',
    turbo: 'Turbo',
};

/** The time an action is due, as the duration from now ("due now" at or past the instant). */
const dueText = (dueAt: number | null, now: number): string => {
    if (dueAt === null) return 'no due time could be read for it';
    const seconds = dueAt - now;
    return seconds <= 0 ? 'due now' : `due in ${formatDuration(seconds)}`;
};

/**
 * Why a blocked Boost/Turbo cannot be placed, in words for the terminal: a flag
 * means every entry carries the other feature, so unpinning cannot help; a pin
 * means the photo pinned for the other feature is in the way — naming when it
 * gives way when that is known (null reads as never).
 */
const conflictLine = (
    kind: 'Boost' | 'Turbo',
    blockedBy: 'flag' | 'pin' | null,
    releaseAt: number | null,
    now: number,
): string | null => {
    if (blockedBy === null) return null;
    const other = kind === 'Boost' ? 'Turbo' : 'Boost';
    if (blockedBy === 'flag') {
        return `  ${kind} is blocked: every entry carries the other feature (${other}), so no photo is left for ${kind}. Add another entry to use both.`;
    }
    if (releaseAt !== null) {
        return `  ${kind} is blocked: the photo pinned for ${other} is in the way. The pin gives way in ${formatDuration(releaseAt - now)}, or unpin it to use ${kind} sooner.`;
    }
    return `  ${kind} is blocked: the photo pinned for ${other} is in the way, and the pin will not give way on its own. Unpin it or add another entry.`;
};

/**
 * The `deadlines` command body. Returns false on an unknown or unreadable
 * challenge, a failed handler reply, or a thrown handler (exit 1).
 */
const deadlinesCmd = async (challengeId: string): Promise<boolean> => {
    const challenge = await resolveChallenge(challengeId);
    if (!challenge) return false;
    try {
        const result = await handlers()['get-deadline-actions'](null, challenge);
        if (!result?.success) {
            logger
                .withCategory('voting')
                .error(
                    `Could not read the deadline actions for "${stripTerminalControl(challenge.title)}": ${stripTerminalControl(String(result?.error ?? 'no answer'))}. Try again in a moment.`,
                );
            return false;
        }
        const now = Math.floor(Date.now() / 1000);
        const lines = [`Deadline actions for "${stripTerminalControl(challenge.title)}":`];
        if (result.actions.length === 0) {
            lines.push('  Nothing is scheduled to run by itself on this challenge.');
        }
        for (const action of result.actions) {
            // The handler's preview emits only the four kinds the map words.
            const label = ACTION_LABELS[action.action];
            lines.push(`  ${label}: ${dueText(action.dueAt, now)}`);
        }
        const conflicts = [
            conflictLine('Boost', result.boostBlockedBy, result.boostReleaseAt, now),
            conflictLine('Turbo', result.turboBlockedBy, result.turboReleaseAt, now),
        ];
        for (const line of conflicts) {
            if (line !== null) lines.push(line);
        }
        for (const line of lines) logger.withCategory('voting').info(line);
        return true;
    } catch (err) {
        logger
            .withCategory('voting')
            .error(`Failed to read the deadline actions: ${stripTerminalControl(errorMessage(err) || err)}`);
        return false;
    }
};

export { deadlinesCmd };
