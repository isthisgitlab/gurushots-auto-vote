/**
 * Host-agnostic continuous voting scheduler.
 *
 * A single recursive setTimeout chain: after every cycle the next delay is
 * decided in one place (`computeNextCycleDelayMs` in ./thresholdWindow) so the
 * cadence can never sleep past an upcoming last-minute boundary — the delay is
 * always the minimum of the rolled random delay and the time until the soonest
 * upcoming threshold entry, or a fixed fast cadence once a challenge is inside
 * its window. There is no separate boundary timer (e.g. a node-cron switch
 * beside the setTimeout chain): an independent one could race a mid-run
 * per-challenge threshold change and overshoot the boundary.
 *
 * The loop itself (decide → arm → cycle → re-arm) is the shared
 * `createCadenceChain` from ./cadenceChain — the same chain the GUI's
 * AutovoteContext drives — so this module only supplies the Node transport:
 * synchronous settings reads, the direct challenge fetcher, the logger, and
 * the host lifecycle (SIGINT on CLI, Service.onDestroy on Android).
 */

import * as logger from '../../core/logger';
import * as settings from '../../core/settings';
import { createCadenceChain, DECISION_ERROR_MESSAGE, formatOversleptMessage } from '../../core/scheduling/cadenceChain';
import { createRunGate } from '../../core/autovote/runGate';
import { registerAutovoteControl } from '../../core/autovote/control';
import { nodeStopFence, reArmInstallation, withdrawInstallation } from '../../core/autovote/nodeSeams';
import {
    loadCadenceSettings,
    resolveThreshold,
    resolveScheduledFill,
    resolveAutoSubmitClock,
    resolveAutoSubmitSchedule,
    resolveFinalWindowTopUp,
    resolveBoostPrefill,
    resolveCurrencyAuto,
    resolveScenarioWake,
    resolveAccountWake,
} from '../../core/scheduling/nodeResolvers';
import { createNodeDeadlineNotifier, createNodeScenarioNotifier } from './nodeNotify';

import type { ActiveChallengesResponse, Challenge } from '../../core/types/gurushots';
import type { TimerHandle } from '../../core/scheduling/cadenceChain';
import type { ExecutionMode } from '../../core/autovote/state';
import type { StopFencePort, StopResult, WithdrawalOutcome } from '../../core/autovote/runGate';
import type { VotingStagesResult } from '../../core/autovote/types';
import type { RunCapture } from '../../core/scheduling/cadenceChain/types';

let stopCounter = 0;

/**
 * Create a continuous voting scheduler.
 *
 * @param deps.runVotingCycle - one-shot voting cycle; resolves with the active list it fetched (null on failure/manual). A non-array `challenges` (or a plain boolean return) is treated as "no list" and triggers a fresh fetch when deciding the next delay.
 * @param deps.getActiveChallenges - fetcher used only when a cycle didn't hand its list over.
 */
const createScheduler = ({
    runVotingCycle,
    getActiveChallenges,
    runArmedCycle = null,
    stopFence = nodeStopFence,
}: {
    runVotingCycle: (cycleNumber: number) => Promise<{ success: boolean; challenges: Challenge[] | null }>;
    getActiveChallenges: () => Promise<ActiveChallengesResponse>;
    /** One installation-only cycle (the installation scenario's publication and account rules, nothing else); none: this host cannot be armed. */
    runArmedCycle?: ((cycleNumber: number) => Promise<{ success: boolean; challenges: Challenge[] | null }>) | null;
    /** The priority Stop fence (the settings facade by default); null: a Stop is local only and says so. */
    stopFence?: StopFencePort | null;
}): {
    start: () => Promise<void>;
    /** Full Stop: cancels at once (the result is the fence's, for the caller that wants to wait for it). */
    stop: () => void;
    stopAll: () => Promise<StopResult>;
    arm: () => Promise<boolean>;
    requestVotingStages: (on: boolean, captured: RunCapture) => Promise<VotingStagesResult>;
    getCycleCount: () => number;
    isRunning: () => boolean;
    getMode: () => ExecutionMode;
} => {
    let cycleCount = 0;
    // What the scheduler is doing: `armed` keeps the chain alive for the installation scenario with the voting stages paused.
    let mode: ExecutionMode = 'stopped';
    let timer: TimerHandle | null = null;
    const gate = createRunGate(stopFence);

    // One notifier per scheduler (holds the fire-once dedupe + re-entrancy
    // guard across cycles). The chain fires it in its own isolated wrapper, so
    // it can never disturb the cadence.
    const notifyDeadlines = createNodeDeadlineNotifier();
    const notifyScenarios = createNodeScenarioNotifier();

    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const runCycleFor = (cycle: typeof runVotingCycle) => async () => (await cycle(++cycleCount))?.challenges;

    const chain = createCadenceChain({
        // The Stop fence: a run that a full Stop made obsolete arms and dispatches nothing.
        gate,
        onObsolete: () => {
            // A Stop recorded elsewhere: this run is over (no second Stop is recorded).
            gate.latch();
            mode = 'stopped';
            clearTimer();
        },
        isRunning: () => mode !== 'stopped',
        isArmed: () => mode === 'armed',
        getTimer: () => timer,
        setTimer: (handle) => {
            timer = handle;
        },
        loadSettings: loadCadenceSettings,
        fetchChallenges: () => getActiveChallenges(),
        resolveLastMinuteCheckMinutes: () => settings.getEffectiveSetting('lastMinuteCheckFrequency', 'global'),
        resolveThreshold,
        resolveScheduledFill,
        resolveAutoSubmitClock,
        resolveAutoSubmitSchedule,
        resolveFinalWindowTopUp,
        resolveBoostPrefill,
        resolveCurrencyAuto,
        resolveScenarioWake,
        resolveAccountWake,
        // The chain hands the resolved value straight back to the next
        // decision as the prefetched-list candidate, so unwrap `challenges`
        // here; a cycle failure/plain boolean yields a non-array → fresh fetch.
        runCycle: () =>
            mode === 'armed' && runArmedCycle ? runCycleFor(runArmedCycle)() : runCycleFor(runVotingCycle)(),
        log: {
            cadence: (mode, message) => {
                logger.withCategory('voting').info(message);
            },
            decisionError: (error) => {
                logger.withCategory('voting').warning(DECISION_ERROR_MESSAGE);
                logger.withCategory('voting').debug('scheduleNext error details:', error);
            },
            // No emoji here: logger.warning already prefixes one (see
            // logger.ts), exactly as the decisionError callback above relies on.
            overslept: (lateMs, waitMs) => {
                logger.withCategory('voting').warning(formatOversleptMessage(lateMs, waitMs));
            },
            cycleError: (error) => {
                logger.withCategory('voting').error('Error in scheduled voting cycle');
                logger.withCategory('voting').debug('Full voting cycle error details:', error);
            },
        },
        // OS "action coming up" notifications (opt-in; no-op when all toggles
        // are off, which is the default).
        // Both notifiers are self-contained and never throw.
        onCycleChallenges: (challenges, now) =>
            Promise.all([notifyDeadlines(challenges, now), notifyScenarios(challenges)]),
    });

    /** An explicit user re-arm lifts the withdrawal before the next publication; one that stands is said. */
    const liftWithdrawal = () => {
        if (reArmInstallation() === 'failed') {
            logger
                .withCategory('voting')
                .warning('The installation scenario could not be re-armed: its withdrawal still stands');
        }
    };

    const start = async () => {
        if (mode === 'voting') return;
        // The user's own Run: it alone may lift a Stop block. (Armed: Run is Resume voting under the same chain.)
        const admitted = gate.fenced ? await gate.admitUser(gate.capture()) : gate.admitLocal('user', gate.capture());
        if (!admitted.ok) {
            logger.withCategory('voting').warning(`Voting was not started (${admitted.reason})`);
            return;
        }
        const wasArmed = mode === 'armed';
        mode = 'voting';
        register();
        if (wasArmed) {
            clearTimer();
            await chain.scheduleNext();
            return;
        }

        // The user's own Run lifts the withdrawal a Stop made, before the first publication.
        liftWithdrawal();
        logger.withCategory('voting').info('🚀 Running initial voting cycle...');
        const initialCycleStartMs = Date.now();
        const initialCycle = await runVotingCycle(++cycleCount);

        logger
            .withCategory('voting')
            .success(
                `Continuous voting started with check frequency range ${settings.getSetting('checkFrequencyMin')}-${settings.getSetting('checkFrequencyMax')} min`,
            );

        // A Stop during the first cycle: nothing is handed to the chain.
        if (!gate.current(admitted.capture)) return;
        await chain.scheduleNext(initialCycle?.challenges, initialCycleStartMs);
    };

    /** The user's explicit installation arm: the chain runs for the installation scenario, the voting stages paused. */
    const arm = async (): Promise<boolean> => {
        if (mode !== 'stopped' || !runArmedCycle) return false;
        const admitted = gate.fenced ? await gate.admitUser(gate.capture()) : gate.admitLocal('user', gate.capture());
        if (!admitted.ok) return false;
        mode = 'armed';
        register();
        liftWithdrawal();
        const first = await runArmedCycle(++cycleCount);
        if (!gate.current(admitted.capture)) return true;
        await chain.scheduleNext(first?.challenges, Date.now());
        return true;
    };

    /**
     * An installation scenario's request for the voting stages: only under the chain that is armed or voting, only while its
     * capture is current and the fence allows it, and it never lifts a Stop.
     */
    const requestVotingStages = async (on: boolean, captured: RunCapture): Promise<VotingStagesResult> => {
        // Turning the voting stages on resumes execution: its final decision is the fence's CAS. Anything else only reads it.
        const allowed = on && mode === 'armed' ? await gate.armsAt(captured) : await gate.admits(captured);
        if (!allowed) return { ok: false, reason: 'obsolete' };
        if (mode === 'stopped') return { ok: false, reason: 'not-armed' };
        if (on === (mode === 'voting')) return { ok: true, mode, changed: false };
        if (!on && !runArmedCycle) return { ok: false, reason: 'unsupported' };
        mode = on ? 'voting' : 'armed';
        const run = gate.run();
        clearTimer();
        await chain.scheduleNext();
        return gate.current(run) ? { ok: true, mode, changed: true } : { ok: false, reason: 'obsolete' };
    };

    // The control the installation scenario's actions reach this scheduler through: registered while it runs.
    let unregister: (() => void) | null = null;
    const register = () => {
        unregister ??= registerAutovoteControl({
            capture: gate.capture,
            admits: gate.admits,
            request: requestVotingStages,
        });
    };

    /**
     * Full Stop: the local latch, the timer and the mode first and synchronously; then the withdrawal of the installation's
     * publication and the fence, together. Neither undoes the cancellation, and each is reported as it came out.
     */
    const stopAll = async (): Promise<StopResult> => {
        gate.latch();
        clearTimer();
        mode = 'stopped';
        unregister?.();
        unregister = null;
        const withdrawal: WithdrawalOutcome = withdrawInstallation((gate.knownEpoch() ?? 0) + 1);
        const recorded = await gate.persistStop(
            `cli-stop-${Date.now().toString(36)}-${(stopCounter++).toString(36)}`,
            Date.now(),
        );
        return { ...recorded, withdrawal };
    };

    return {
        start,
        stop: () => void stopAll(),
        stopAll,
        arm,
        requestVotingStages,
        getCycleCount: () => cycleCount,
        isRunning: () => mode !== 'stopped',
        getMode: () => mode,
    };
};

export { createScheduler };
