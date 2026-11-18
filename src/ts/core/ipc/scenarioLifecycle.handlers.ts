/**
 * IPC handlers for the installation scenario and the lifecycle of an assignment (settings/scenarioLifecycle.ts), the
 * photo pools, the capability and snapshot reads, the effective projections, and the controller's routes to the priority
 * Stop fence. Spread into the scenario handler map (scenarios.handlers.ts), so Electron, the CLI, the web shell and the
 * Capacitor bridge all answer them. Every handler returns `{success, error}` and never throws to the renderer; every
 * argument is checked at runtime. The CLI reuses these handlers.
 *
 *   reads        get-scenario-capabilities, get-scenario-snapshot, get-installation-scenario, list-simulation-subjects,
 *                get-photo-pools, get-effective-entry-pins, get-effective-installation-settings,
 *                get-effective-presentation, get-stop-status, get-scenario-request-status
 *   inbox        begin-scenario-request, finish-scenario-request (the remote host's routes into the control inbox)
 *   effects      set-installation-scenario, transfer-installation-scenario-owner, pause-scenario, resume-scenario,
 *                handoff-scenario, clear-scenario-assignment, set-photo-pool, delete-photo-pool, rename-photo-pool
 *   controller   scenario-stop-fence, record-full-stop, arm-autovote, arm-if-allowed, withdraw-installation,
 *                rearm-installation, get-account-wake
 *
 * While the Android service owns scenarios (`backgroundServiceOwnsScenarios()`), the five lifecycle effects that change a
 * subject's assignment or pause (set-installation-scenario, pause-scenario, resume-scenario, handoff-scenario,
 * clear-scenario-assignment) are queued in the control inbox for the service and answered as pending; the window never
 * writes the progress ledger for them. The service applies them through these same handlers (where it owns nothing, so they
 * apply directly) and records the result. A full Stop never uses the inbox.
 *
 * Authority: `arm-autovote` is the only handler that reaches `clearStopBlock`. Whose Run it is comes from the route,
 * never from an argument: a startup resume or a scenario request has `arm-if-allowed`, which cannot lift a block.
 */

import * as settings from '../settings';
import * as apiFactory from '../apiFactory';
import * as auth from '../services/auth';
import { INSTALLATION_KEY, refreshScenarioStateAsync } from '../scenarioStateStore';
import { ledgerForMode, listSimulationSubjects } from '../services/scenarioStatus';
import { announceEffectiveChange, readEffective } from '../services/effectiveEvents';
import { nodeStopFence, reArmInstallation, withdrawInstallation } from '../autovote/nodeSeams';
import { resolveAccountWake } from '../scheduling/nodeResolvers';
import { isPlainObject } from '../plainObject';
import { backgroundServiceOwnsScenarios } from '../services/scenarioRunner';
import { isIdArg } from './isIdArg';
import { isRendererHiddenKey } from './rendererSettings';
import { invalidArgs, isCount, isName, safely } from './scenarioSupport';

import type { IpcHandlerMap } from './invokeHandler';
import type { ControlStatusQuery, StopFenceRead } from '../settings';
import type { SubjectKind } from '../services/scenarioStatus';
import type { ExprValue } from '../scenarios/expressions';
import type { ValueState } from '../scenarios/valueState';
import type { InstallationExecutor } from '../types/config';
import type { ScenarioState } from '../types/stores';

/** The longest reason a pause may carry. */
const MAX_PAUSE_REASON = 200;
/** The longest request identity a Stop may carry. */
const MAX_REQUEST_ID = 128;

const SUBJECT_KINDS: readonly SubjectKind[] = ['candidate', 'active', 'completed'];

/** A subject of a lifecycle call: a challenge id, or the installation. */
const isSubject = (value: unknown): value is string | number => value === INSTALLATION_KEY || isIdArg(value);

/** A failure with only its reason, the generation the facade says it is at when it does. */
const refused = (reason: string, generation?: number) => ({
    success: false as const,
    error: reason,
    ...(generation === undefined ? {} : { generation }),
});

/** An installation change's result as the IPC shape; a success is announced to the windows. */
const installationResult = (result: settings.InstallationResult) => {
    if (!result.ok) return refused(result.reason, result.generation);
    announceEffectiveChange();
    return { success: true as const, installation: result.installation, generation: result.generation };
};

/** A handoff's result as the IPC shape; a success is announced to the windows. */
const handoffResult = (result: settings.HandoffResult) => {
    if (!result.ok) return refused(result.reason);
    announceEffectiveChange();
    return { success: true as const, generation: result.generation };
};

/** The values of one subject's settings that a client may see: no key a renderer may not read, only keys read as values. */
const visibleKeys = (): string[] =>
    settings
        .getScenarioCapabilities()
        .settings.filter((row) => row.read === 'value' && !isRendererHiddenKey(row.key))
        .map((row) => row.key);

const pick = (states: Record<string, ValueState<ExprValue>>, keys: readonly string[]) =>
    Object.fromEntries(keys.filter((key) => Object.hasOwn(states, key)).map((key) => [key, states[key]]));

/** What a publication tells a client: that there is one, from when and until when. Never its values. */
const publicationOf = (state: ScenarioState | null) =>
    state?.published
        ? {
              revision: state.published.revision,
              observedAt: state.published.observedAt,
              validUntil: state.published.validUntil,
              profile: state.published.profile,
          }
        : null;

/** One subject's scenario state for a client: its settings as they are saved and as they apply, its schedules, pins and pool, its pause and generation. */
const buildSnapshot = async (subject: string) => {
    await refreshScenarioStateAsync();
    const installation = subject === INSTALLATION_KEY;
    const challengeId = installation ? null : subject;
    const keys = visibleKeys();
    const { corrupt, state } = ledgerForMode().get(subject);
    const installationScenario = installation ? settings.getInstallationScenario() : null;
    const effective: Record<string, ValueState<ExprValue>> = Object.fromEntries(
        keys.map((key) => [
            key,
            challengeId === null
                ? settings.readInstallationSetting(key)
                : settings.readScenarioSetting(key, 'effective', challengeId),
        ]),
    );
    let generation: number | null = null;
    if (installation) generation = settings.installationGeneration();
    else if (!corrupt) generation = state?.generation ?? 0;
    return {
        success: true as const,
        subject,
        assignment: installation ? installationScenario : settings.getEffectiveSetting('scenario', subject) || null,
        corrupt,
        paused: state?.paused ?? null,
        generation,
        withdrawn: installation ? Boolean(state?.withdrawn) : false,
        base: pick(settings.getScenarioBaseSettings(challengeId), keys),
        effective,
        overlay: challengeId === null ? null : settings.scenarioOverlayStatus(challengeId),
        publication: publicationOf(state),
        schedules: challengeId === null ? null : settings.getPhaseSchedules(challengeId),
        pins:
            challengeId === null
                ? null
                : { effective: settings.getEntryPins(challengeId), stored: settings.getStoredEntryPins(challengeId) },
        pool: challengeId === null ? null : settings.getChosenPoolView(challengeId),
    };
};

/** The fence a client may see: its state and, when it reads, its epoch, block and last Stop and arm. */
const fenceView = (read: StopFenceRead) => (read.state === 'ok' ? { state: 'ok' as const, ...read.fence } : read);

/**
 * Whether the installation's owner has acknowledged the Stop: its record shows a withdrawal under the fence's epoch. Null when
 * that cannot be told (no fence that reads, no installation record, an unreadable one).
 */
const ownerAcknowledged = (read: StopFenceRead): boolean | null => {
    if (read.state !== 'ok') return null;
    const { corrupt, state } = ledgerForMode().get(INSTALLATION_KEY);
    if (corrupt || state === null) return null;
    return (state.withdrawn?.epoch ?? -1) >= read.fence.stopEpoch;
};

/** The options of `scenario-stop-fence`, or null when they are not exactly what it takes. */
const fenceOptions = (options: unknown): { initialize: boolean; armEpoch: number | null } | null => {
    if (options === undefined) return { initialize: false, armEpoch: null };
    if (!isPlainObject(options)) return null;
    const { initialize, armEpoch } = options;
    if (initialize !== undefined && typeof initialize !== 'boolean') return null;
    if (armEpoch !== undefined && !isCount(armEpoch)) return null;
    return { initialize: initialize === true, armEpoch: armEpoch ?? null };
};

let queuedCount = 0;

/**
 * Queues one lifecycle effect in the control inbox for the Android service, which applies it on its next cycle: the request is
 * persisted as pending and answered as such (`pending: true`), never as applied. The identity is made here (a window call
 * carries none); the arguments are the handler's own, validated by the caller and again by the service.
 */
const queueForService = async (operation: string, target: string, args: unknown[]) => {
    const requestId = `app-${Date.now().toString(36)}-${(queuedCount++).toString(36)}`;
    const begun = await settings.beginControlRequest({
        requestId,
        operation,
        target,
        args: JSON.stringify(args),
        stopEpoch: currentStopEpoch(),
        at: Date.now(),
        executor: settings.SERVICE_EXECUTOR,
    });
    if (!begun.ok) return refused(begun.reason);
    return { success: true as const, pending: true as const, requestId, target, revision: begun.revision };
};

/** The current Stop epoch, or null where the fence cannot be read. */
const currentStopEpoch = (): number | null => {
    const read = settings.readStopFence();
    return read.state === 'ok' ? read.fence.stopEpoch : null;
};

/** The query of `get-scenario-request-status`: exactly a request identity or exactly a target. */
const statusQuery = (query: unknown): ControlStatusQuery | null => {
    if (!isPlainObject(query)) return null;
    const keys = Object.keys(query);
    if (keys.length !== 1) return null;
    if (query.requestId !== undefined)
        return isControlText(query.requestId, settings.CONTROL_ID_PATTERN) ? { requestId: query.requestId } : null;
    return isControlText(query.target, settings.CONTROL_NAME_PATTERN) ? { target: query.target } : null;
};

const isControlText = (value: unknown, pattern: RegExp): value is string =>
    typeof value === 'string' && pattern.test(value);

/** The request a host asks to have persisted: exactly its identity, operation, target and argument text, and the revision it expects. */
const beginRequest = (request: unknown) => {
    if (!isPlainObject(request)) return null;
    const { requestId, operation, target, args, expectedRevision } = request;
    const allowed = ['requestId', 'operation', 'target', 'args', 'expectedRevision'];
    if (!Object.keys(request).every((key) => allowed.includes(key)) || typeof args !== 'string') return null;
    if (expectedRevision !== undefined && !isCount(expectedRevision)) return null;
    if (
        !isControlText(requestId, settings.CONTROL_ID_PATTERN) ||
        !isControlText(operation, settings.CONTROL_NAME_PATTERN)
    )
        return null;
    if (!isControlText(target, settings.CONTROL_NAME_PATTERN)) return null;
    return { requestId, operation, target, args, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
};

/** The result a host asks to have recorded: exactly the identity, the target, whether it landed, and a bounded reason. */
const finishRequest = (request: unknown) => {
    if (!isPlainObject(request)) return null;
    const { requestId, target, ok, error } = request;
    const allowed = ['requestId', 'target', 'ok', 'error'];
    if (!Object.keys(request).every((key) => allowed.includes(key)) || typeof ok !== 'boolean') return null;
    if (error !== undefined && (typeof error !== 'string' || error.length > settings.CONTROL_MAX_ERROR)) return null;
    if (!isControlText(requestId, settings.CONTROL_ID_PATTERN) || !isControlText(target, settings.CONTROL_NAME_PATTERN))
        return null;
    return { requestId, target, ok, error: error ?? null };
};

const buildLifecycleHandlers = () =>
    ({
        'get-scenario-capabilities': async () =>
            safely('get-scenario-capabilities', () => ({
                success: true as const,
                capabilities: settings.getScenarioCapabilities(),
            })),

        'get-scenario-snapshot': async (event: unknown, subject: string | number) => {
            if (!isSubject(subject)) return invalidArgs;
            return safely('get-scenario-snapshot', () => buildSnapshot(String(subject)));
        },

        'get-installation-scenario': async () =>
            safely('get-installation-scenario', () => ({
                success: true as const,
                installation: settings.getInstallationScenario(),
                generation: settings.installationGeneration(),
            })),

        'list-simulation-subjects': async (event: unknown, kind: SubjectKind) => {
            if (!SUBJECT_KINDS.includes(kind)) return invalidArgs;
            return safely('list-simulation-subjects', async () => {
                const guard = auth.requireAuthToken('scenario subjects');
                if (!guard.ok) return guard.response;
                const listed = await listSimulationSubjects(kind, guard.token, apiFactory.getApiStrategy());
                return { success: true as const, ...listed };
            });
        },

        'get-effective-installation-settings': async () =>
            safely('get-effective-installation-settings', () => ({
                success: true as const,
                ...readEffective().settings,
            })),

        'get-effective-presentation': async () =>
            safely('get-effective-presentation', () => ({ success: true as const, ...readEffective().presentation })),

        'get-photo-pools': async () =>
            safely('get-photo-pools', () => ({ success: true as const, pools: settings.getPhotoPools() })),

        'get-effective-entry-pins': async (event: unknown, challengeId: string | number) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('get-effective-entry-pins', () => ({
                success: true as const,
                pins: settings.getEntryPins(challengeId),
            }));
        },

        'get-stop-status': async () =>
            safely('get-stop-status', async () => {
                const read = await nodeStopFence.read();
                return {
                    success: true as const,
                    fence: fenceView(read),
                    // Whether the Stop that was recorded last reached the durable fence; null when none was recorded.
                    durable: read.state === 'ok' ? (read.fence.lastStop?.durable ?? null) : null,
                    ownerAcknowledged: ownerAcknowledged(read),
                };
            }),

        'get-scenario-request-status': async (event: unknown, query: ControlStatusQuery) => {
            const asked = statusQuery(query);
            if (asked === null) return invalidArgs;
            return safely('get-scenario-request-status', async () => {
                // The service records results behind this window's cache of the inbox: it is read again first.
                if (backgroundServiceOwnsScenarios()) await settings.refreshScenarioControlsAsync();
                return { success: true as const, ...settings.readControlStatus(asked, currentStopEpoch()) };
            });
        },

        'begin-scenario-request': async (event: unknown, request: unknown) => {
            const asked = beginRequest(request);
            if (asked === null) return invalidArgs;
            return safely('begin-scenario-request', async () => {
                const begun = await settings.beginControlRequest({
                    ...asked,
                    stopEpoch: currentStopEpoch(),
                    at: Date.now(),
                });
                return begun.ok ? { success: true as const, ...begun } : refused(begun.reason);
            });
        },

        'finish-scenario-request': async (event: unknown, request: unknown) => {
            const asked = finishRequest(request);
            if (asked === null) return invalidArgs;
            return safely('finish-scenario-request', async () => {
                const finished = await settings.finishControlRequest({ ...asked, at: Date.now() });
                return finished.ok ? { success: true as const, ...finished } : refused(finished.reason);
            });
        },

        'set-installation-scenario': async (
            event: unknown,
            name: string | null,
            executor: InstallationExecutor,
            expectedGeneration: number,
        ) => {
            if ((name !== null && !isName(name)) || typeof executor !== 'string' || !isCount(expectedGeneration)) {
                return invalidArgs;
            }
            if (backgroundServiceOwnsScenarios()) {
                return safely('set-installation-scenario', () =>
                    queueForService('set-installation-scenario', INSTALLATION_KEY, [
                        name,
                        executor,
                        expectedGeneration,
                    ]),
                );
            }
            return safely('set-installation-scenario', () =>
                installationResult(settings.setInstallationScenario(name, executor, expectedGeneration)),
            );
        },

        'transfer-installation-scenario-owner': async (
            event: unknown,
            executor: InstallationExecutor,
            expectedGeneration: number,
        ) => {
            if (typeof executor !== 'string' || !isCount(expectedGeneration)) return invalidArgs;
            return safely('transfer-installation-scenario-owner', () =>
                installationResult(settings.transferInstallationOwner(executor, expectedGeneration)),
            );
        },

        'pause-scenario': async (event: unknown, subject: string | number, reason?: string) => {
            if (!isSubject(subject)) return invalidArgs;
            if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_PAUSE_REASON)) {
                return invalidArgs;
            }
            if (backgroundServiceOwnsScenarios()) {
                return safely('pause-scenario', () =>
                    queueForService(
                        'pause-scenario',
                        String(subject),
                        reason === undefined ? [subject] : [subject, reason],
                    ),
                );
            }
            return safely('pause-scenario', () => {
                const result = settings.setScenarioPaused(String(subject), true, reason ?? '');
                if (!result.ok) return refused(result.reason);
                announceEffectiveChange();
                return { success: true as const, paused: result.paused };
            });
        },

        'resume-scenario': async (event: unknown, subject: string | number) => {
            if (!isSubject(subject)) return invalidArgs;
            if (backgroundServiceOwnsScenarios()) {
                return safely('resume-scenario', () => queueForService('resume-scenario', String(subject), [subject]));
            }
            return safely('resume-scenario', () => {
                const result = settings.setScenarioPaused(String(subject), false);
                if (!result.ok) return refused(result.reason);
                announceEffectiveChange();
                return { success: true as const, paused: result.paused };
            });
        },

        'handoff-scenario': async (
            event: unknown,
            subject: string | number,
            to: string,
            expectedGeneration: number,
        ) => {
            if (!isSubject(subject) || !isName(to) || !isCount(expectedGeneration)) return invalidArgs;
            if (backgroundServiceOwnsScenarios()) {
                return safely('handoff-scenario', () =>
                    queueForService('handoff-scenario', String(subject), [subject, to, expectedGeneration]),
                );
            }
            return safely('handoff-scenario', async () =>
                handoffResult(await settings.requestScenarioHandoff(String(subject), to, expectedGeneration)),
            );
        },

        'clear-scenario-assignment': async (event: unknown, subject: string | number, expectedGeneration: number) => {
            if (!isSubject(subject) || !isCount(expectedGeneration)) return invalidArgs;
            if (backgroundServiceOwnsScenarios()) {
                return safely('clear-scenario-assignment', () =>
                    queueForService('clear-scenario-assignment', String(subject), [subject, expectedGeneration]),
                );
            }
            return safely('clear-scenario-assignment', async () => {
                if (subject !== INSTALLATION_KEY) {
                    return handoffResult(
                        await settings.requestScenarioHandoff(String(subject), null, expectedGeneration),
                    );
                }
                // The installation is cleared under the owner it has: the change is the same fence as any other.
                const current = settings.getInstallationScenario();
                if (current === null) return refused('no-installation');
                const result = settings.setInstallationScenario(null, current.executor, expectedGeneration);
                if (!result.ok) return refused(result.reason, result.generation);
                announceEffectiveChange();
                return { success: true as const, generation: result.generation };
            });
        },

        'set-photo-pool': async (event: unknown, name: string, ids: string[]) => {
            if (typeof name !== 'string' || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
                return invalidArgs;
            }
            return safely('set-photo-pool', () => {
                const outcome = settings.setPhotoPool(name, ids);
                return outcome === 'ok' ? { success: true as const } : refused(outcome);
            });
        },

        'delete-photo-pool': async (event: unknown, name: string) => {
            if (typeof name !== 'string') return invalidArgs;
            return safely('delete-photo-pool', () => {
                const result = settings.deletePhotoPool(name);
                return result.ok ? { success: true as const } : refused(result.reason);
            });
        },

        'rename-photo-pool': async (event: unknown, from: string, to: string) => {
            if (typeof from !== 'string' || typeof to !== 'string') return invalidArgs;
            return safely('rename-photo-pool', () => {
                const result = settings.renamePhotoPool(from, to);
                return result.ok ? { success: true as const } : refused(result.reason);
            });
        },

        // --- the controller's routes (autovote/controller.ts) -------------------------------------------------------------

        // Reads the fence. `initialize` creates one that was never created (nothing else of it changes); `armEpoch` also
        // answers whether an arm at that epoch is allowed now. Neither can lift a block or arm anything.
        'scenario-stop-fence': async (event: unknown, options?: { initialize?: boolean; armEpoch?: number }) => {
            const asked = fenceOptions(options);
            if (asked === null) return invalidArgs;
            return safely('scenario-stop-fence', async () => {
                let created: boolean | undefined;
                if (asked.initialize) {
                    const initialized = await nodeStopFence.initialize();
                    if (!initialized.ok) return refused(initialized.reason);
                    created = initialized.created;
                }
                const fence = await nodeStopFence.read();
                return {
                    success: true as const,
                    fence,
                    ...(created === undefined ? {} : { created }),
                    ...(asked.armEpoch === null
                        ? {}
                        : { armAllowed: await nodeStopFence.isArmAllowed(asked.armEpoch) }),
                };
            });
        },

        // A user's full Stop, recorded in the fence alone: nothing else is read or written, so nothing else can refuse it.
        'record-full-stop': async (event: unknown, requestId: string, at: number) => {
            if (
                !isName(requestId) ||
                requestId.length > MAX_REQUEST_ID ||
                typeof at !== 'number' ||
                !Number.isFinite(at)
            ) {
                return invalidArgs;
            }
            return safely('record-full-stop', async () => {
                const recorded = await nodeStopFence.recordFullStop(requestId, at);
                if (!recorded.ok) return refused(recorded.reason);
                announceEffectiveChange();
                return { success: true as const, epoch: recorded.epoch };
            });
        },

        // The user's own Run / Resume / re-arm, the only route that lifts a Stop block, and only at the epoch the user
        // acknowledged: a Stop that came after stays. Then the arm itself, in the fence's compare-and-set.
        'arm-autovote': async (event: unknown, expectedEpoch: number) => {
            if (!isCount(expectedEpoch)) return invalidArgs;
            return safely('arm-autovote', async () => {
                const cleared = await nodeStopFence.clearStopBlock(expectedEpoch);
                if (!cleared.ok) return refused(cleared.reason);
                const armed = await nodeStopFence.armIfAllowed(expectedEpoch, Date.now());
                return armed.ok ? { success: true as const } : refused(armed.reason);
            });
        },

        // The compare-and-set alone (a startup resume, a scenario's request): it never lifts a block.
        'arm-if-allowed': async (event: unknown, epoch: number) => {
            if (!isCount(epoch)) return invalidArgs;
            return safely('arm-if-allowed', async () => {
                const armed = await nodeStopFence.armIfAllowed(epoch, Date.now());
                return armed.ok ? { success: true as const } : refused(armed.reason);
            });
        },

        // A full Stop's withdrawal of the installation's publication under the epoch it is made under.
        'withdraw-installation': async (event: unknown, epoch: number) => {
            if (!isCount(epoch)) return invalidArgs;
            return safely('withdraw-installation', () => {
                const outcome = withdrawInstallation(epoch);
                if (outcome === 'failed') return refused('withdrawal-not-saved');
                announceEffectiveChange();
                return { success: true as const, outcome };
            });
        },

        // The user's explicit re-arm lifts that withdrawal before the next publication.
        'rearm-installation': async () =>
            safely('rearm-installation', () => {
                const outcome = reArmInstallation();
                if (outcome === 'failed') return refused('restore-not-saved');
                announceEffectiveChange();
                return { success: true as const, outcome };
            }),

        // The account's own scheduling boundaries, worked out here: the renderer has no route to the ledgers they come from.
        'get-account-wake': async () =>
            safely('get-account-wake', () => ({ success: true as const, wake: resolveAccountWake() })),
    }) satisfies IpcHandlerMap;

export { buildLifecycleHandlers };
