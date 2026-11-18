/**
 * The Android service's half of the control inbox (core/settings/scenarioControls.ts). The window queues the five lifecycle
 * effects for the service while it owns scenarios (core/ipc/scenarioLifecycle.handlers.ts); at the start of each cycle, before
 * any scenario work, the service claims what is pending, applies each request through the very handler the window would have
 * called (with its generation fences and preflight; here the service owns nothing, so the handler applies directly), and records
 * the result. A request claimed by a run that did not finish it is recorded `interrupted` and is not applied again by itself.
 *
 * The run id is made once, when this page loads (one per service process), in memory only.
 */

import * as settings from '../../core/settings';
import * as logger from '../../core/logger';
import { buildLifecycleHandlers } from '../../core/ipc/scenarioLifecycle.handlers';
import { invokeHandler } from '../../core/ipc/invokeHandler';
import { errorMessage } from '../../core/errorMessage';
import { isPlainObject } from '../../core/plainObject';

const log = () => logger.withCategory('scenario');

/** A random id for this service run: letters, digits and `-` only (the inbox's identity pattern). */
const newRunId = (): string =>
    `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

const RUN_ID = newRunId();

/** The longest reason the inbox records for a failed change. */
const MAX_RECORDED_ERROR = 120;

/** The operations the service applies: the five the window queues for it. */
const OPERATIONS = [
    'set-installation-scenario',
    'pause-scenario',
    'resume-scenario',
    'handoff-scenario',
    'clear-scenario-assignment',
] as const;

const handlers = (): ReturnType<typeof buildLifecycleHandlers> => buildLifecycleHandlers();

const handlerFor = (operation: string) => {
    const built = handlers();
    return OPERATIONS.find((name) => name === operation) === undefined
        ? undefined
        : built[operation as (typeof OPERATIONS)[number]];
};

/** What the handler answered, as a recorded outcome: an explicit `false` or `{ success: false }` is a change that did not land. */
const outcomeOf = (answer: unknown): { ok: boolean; error: string | null } => {
    const failed = answer === false || (isPlainObject(answer) && answer.success === false);
    const reason = isPlainObject(answer) && typeof answer.error === 'string' ? answer.error : null;
    return { ok: !failed, error: failed ? (reason ?? 'failed').slice(0, MAX_RECORDED_ERROR) : null };
};

const parseArgs = (text: string): unknown[] | null => {
    try {
        const value: unknown = JSON.parse(text);
        return Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
};

/** Applies one claimed request and records its result. A request whose operation or arguments are not usable fails, recorded as such. */
const applyRequest = async (request: settings.ClaimedControlRequest): Promise<void> => {
    const { requestId, operation, target } = request;
    const handler = handlerFor(operation);
    const args = parseArgs(request.args);
    let outcome: { ok: boolean; error: string | null };
    if (handler === undefined) outcome = { ok: false, error: 'unsupported-operation' };
    else if (args === null) outcome = { ok: false, error: 'invalid-args' };
    else {
        try {
            outcome = outcomeOf(await invokeHandler(operation, handler, null, args));
        } catch (error) {
            outcome = { ok: false, error: (errorMessage(error) ?? 'failed').slice(0, MAX_RECORDED_ERROR) };
        }
    }
    const finished = await settings.finishControlRequest({
        requestId,
        target,
        ok: outcome.ok,
        error: outcome.error,
        at: Date.now(),
    });
    if (!finished.ok) log().warning(`A queued request's result was not recorded (${finished.reason})`, null);
};

/**
 * The claim pass of one cycle. Never throws: a failure is logged and the cycle goes on (the requests stay pending, to be
 * claimed by the next pass).
 */
const processServiceControls = async (): Promise<void> => {
    try {
        const fence = settings.readStopFence();
        const claim = await settings.claimServiceControlRequests({
            runId: RUN_ID,
            epoch: fence.state === 'ok' ? fence.fence.stopEpoch : null,
            at: Date.now(),
        });
        if (!claim.ok) {
            log().warning(`The control inbox could not be claimed (${claim.reason})`, null);
            return;
        }
        for (const request of claim.claimed) await applyRequest(request);
    } catch (error) {
        log().error('The control inbox pass failed', errorMessage(error));
    }
};

export { processServiceControls, RUN_ID };
