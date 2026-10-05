/**
 * Applies a boost auto-vote would apply soon when the device goes to sleep.
 *
 * WHY: macOS does not let an app cancel a user-initiated sleep, and a Mac asleep
 * (or dark-waking without a network) cannot reach the API. A boost whose
 * window closes while the device sleeps is lost, so on Electron's powerMonitor
 * `'suspend'` a boost due within SUSPEND_BOOST_HORIZON_SEC goes out right away —
 * losing some timing beats losing the boost. The log line says how early it went.
 *
 * Best effort: `'suspend'` only notifies the app, which races the CPU halt and
 * the network going down. Some boosts sent here land, others do not, and some
 * land without the app seeing the reply — so a null result reads "not confirmed",
 * never "failed", and the next pass after wake shows what happened.
 *
 * Which challenges and when is the quit guard's remembered list and the boost
 * row of describeDeadlineActions (autoBoost / Boost Time 0 = off / turbo-conflict
 * gating already applied). The boost itself is the voting pass's own decision
 * (services/votingOrchestrator/boost.ts runSuspendBoost), reached through
 * the API strategy so mock mode never touches the real entry-age file.
 *
 * Known race: a voting pass already running can boost the same challenge at the
 * same moment; the second POST is rejected, which "not confirmed" keeps from
 * reading as an error. The same goes for a stale list: the remembered list is
 * only refreshed by get-active-challenges (up to ~60 s old), so a boost the pass
 * applied just before sleep can be sent again — the server rejects it, nothing
 * is spent twice, and it logs as not confirmed.
 */

import * as logger from '../logger';
import * as settings from '../settings';
import * as apiFactory from '../apiFactory';
import * as votingLogic from '../services/VotingLogic';
import { formatDuration } from '../format/duration';
import { failureText } from '../format/logSafe';
import {
    imminentBoostChallenges,
    markBoostApplied,
    rememberedChallengesMock,
    SUSPEND_BOOST_HORIZON_SEC,
} from './quitGuard';

// Two quick sleeps must not send duplicate POSTs while a batch is still pending.
let running = false;

/**
 * @param deps.autovoteRunning - nothing is boosted unless auto-vote is running
 * @param deps.now - Unix seconds
 * @param deps.describeDeadlineActions - test seam
 */
const applyImminentBoostsOnSuspend = async ({
    autovoteRunning,
    now = Math.floor(Date.now() / 1000),
    describeDeadlineActions = votingLogic.describeDeadlineActions,
}: {
    autovoteRunning: boolean;
    now?: number;
    describeDeadlineActions?: Parameters<typeof imminentBoostChallenges>[1];
}): Promise<void> => {
    if (!autovoteRunning || running) return;
    running = true;
    // The batch can stay pending across the sleep while transport retries run, so
    // `running` is released in `finally`.
    try {
        const { token, mock } = settings.loadSettings();
        // The remembered list must be the one the current API surface would act on.
        if (!token || rememberedChallengesMock() !== (mock === true)) return;
        const selected = imminentBoostChallenges(now, describeDeadlineActions, SUSPEND_BOOST_HORIZON_SEC);
        if (selected.length === 0) return;

        const boostLog = logger.withCategory('boost');
        for (const { challenge, dueAt } of selected) {
            boostLog.info(
                `Device is going to sleep — trying to boost ${logger.challengeTag(challenge)} now, ${formatDuration(dueAt - now)} before its Boost Time`,
                null,
            );
        }
        const results = await apiFactory.getApiStrategy().applyBoostsOnSuspend(
            selected.map(({ challenge }) => challenge),
            token,
        );
        results.forEach((result, index) => {
            const { challenge } = selected[index];
            if (result.status === 'rejected') {
                boostLog.error(
                    `${logger.challengeTag(challenge)} boost before sleep errored: ${failureText(result.reason)}`,
                    null,
                );
            } else if (result.value === 'applied') {
                markBoostApplied(challenge.id);
            } else if (result.value === 'skipped') {
                boostLog.info(`${logger.challengeTag(challenge)} boost not sent before sleep — skipped`, null);
            } else {
                boostLog.warning(
                    `${logger.challengeTag(challenge)} boost not confirmed before sleep — the next pass after wake shows whether it landed`,
                    null,
                );
            }
        });
    } catch (error) {
        logger.withCategory('boost').error(`Boost on sleep could not run: ${failureText(error)}`, null);
    } finally {
        running = false;
    }
};

export { applyImminentBoostsOnSuspend };
