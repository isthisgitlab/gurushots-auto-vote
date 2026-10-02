/**
 * Shared autovote cadence chain — the recursive "decide delay → arm timer →
 * run cycle → re-arm" loop both schedulers run (runScheduler.ts for
 * CLI/Android, AutovoteContext.tsx for the GUI).
 * The MATH is shared in ./thresholdWindow and ./randomDelay; this factory
 * shares the LOOP: guard ordering, fresh-settings read per cycle, prefetched
 * challenge reuse, the normal-vs-threshold wait decision, the cadence log
 * lines, the error → plain-random-cadence fallback, and the stale-timer
 * re-arm guard.
 *
 * Hosts inject transport only — how to read settings, fetch challenges,
 * resolve per-challenge values, run a cycle, store the timer handle, and emit
 * a log line — mirroring how ./nodeResolvers.ts vs
 * react/contexts/autovoteScheduler.ts split the per-challenge
 * resolvers by platform. CJS on purpose: required directly by the Node hosts
 * and imported by the esbuild-bundled renderer.
 */

export { createCadenceChain } from './cadenceChain/chain';
export { DECISION_ERROR_MESSAGE } from './cadenceChain/decision';
export {
    formatOversleptMessage,
    oversleptBy,
    OVERSLEEP_ABSOLUTE_MS,
    OVERSLEEP_ALWAYS_MS,
} from './cadenceChain/oversleep';
export { OFFLINE_RETRY_MS } from './randomDelay';

export type { TimerHandle } from './cadenceChain/types';
