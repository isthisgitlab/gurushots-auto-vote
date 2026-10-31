/**
 * The controller's voting-cycle runner: one cycle over the host's IPC, plus
 * the success bookkeeping (cycle counter, last-run stamp, notification text).
 */

import { ACTIONS } from './state';
import { errorMessage } from '../errorMessage';

import type { Challenge } from '../types/gurushots';
import type { ControllerCore } from './types';

/**
 * Record a successful cycle: bump the counter, stamp the last-run time, and
 * refresh the persistent notification text on Capacitor so the user can see
 * at a glance when the last cycle ran without opening the app (no-op on
 * Electron).
 */
const recordCycleSuccess = (core: ControllerCore) => {
    const { host, apply } = core;
    apply({ type: ACTIONS.INCREMENT_CYCLE });
    const lastRunStr = host.formatTime(Date.now());
    apply({ type: ACTIONS.UPDATE_LAST_RUN, payload: lastRunStr });
    void host.background
        .update(host.translate('app.title'), host.translate('app.autovoteNotificationLastCycle', { time: lastRunStr }))
        .catch((err) => host.logRendererWarning(`Background notification update failed: ${errorMessage(err) || err}`));
};

/**
 * Create the cycle runner over the controller's core.
 */
export const createCycleRunner = (
    core: ControllerCore,
): {
    /**
     * Run a single voting cycle. On success resolves with the active-challenge
     * list the cycle fetched, so the threshold scheduler can reuse it instead of
     * issuing a second IPC fetch; resolves falsy on failure / not-running /
     * not-logged-in (callers fall back to fetching).
     *
     * @returns The fetched challenge list on success (or
     *   `true` when the cycle succeeded without surfacing one), `false` otherwise.
     *   Consumers MUST treat any non-array as "fetch fresh" (Array.isArray guard).
     */
    runCycle: () => Promise<Challenge[] | boolean>;
} => {
    const { host, apply, flags } = core;
    const runCycle = async (): Promise<Challenge[] | boolean> => {
        if (!flags.running() || flags.disposed()) {
            return false;
        }

        try {
            const settings = await host.getSettings();
            if (!settings.hasToken) {
                apply({ type: ACTIONS.SET_ERROR, payload: 'not-logged-in' });
                return false;
            }

            const result = await host.runVotingCycle();

            if (!flags.running() || flags.disposed()) {
                return false;
            }

            if (!result?.success) {
                void host.logRendererWarning(`Voting cycle failed: ${result?.error || 'no reason given'}`);
                apply({ type: ACTIONS.SET_ERROR, payload: result?.error || 'voting-failed' });
                return false;
            }

            recordCycleSuccess(core);
            const refresh = host.getOnChallengesRefresh();
            if (refresh) {
                refresh();
            }

            // Hand the fetched list back so the threshold scheduler can skip its
            // own fetch. Fall back to `true` (truthy, but not an array) when no
            // list is present so callers fetch fresh.
            return result.challenges ?? true;
        } catch (err) {
            void host.logRendererWarning(`Voting cycle threw: ${errorMessage(err) || err}`);
            apply({ type: ACTIONS.SET_ERROR, payload: 'voting-error' });
            return false;
        }
    };
    return { runCycle };
};
