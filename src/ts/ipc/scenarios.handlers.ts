/**
 * IPC handlers for user-defined scenarios (settings/scenarios.ts,
 * services/scenarioRunner.ts). Every handler returns `{success, error}` —
 * validation failures also carry `issues: [{path, message}]` — and never
 * throws to the renderer. The CLI reuses these handlers, so both surfaces
 * behave identically.
 *
 *   get-scenarios            stored scenarios + the example templates
 *   check-scenario           validate a document without storing it
 *   save-scenario            validate and store a document
 *   rename-scenario          rename (assignments follow)
 *   delete-scenario          delete (assignments are cleared)
 *   preview-scenario-import  validate shared JSON and describe what it does, storing nothing
 *   import-scenario          validate and store shared JSON
 *   export-scenario          a stored scenario as JSON text
 *   get-scenario-status      where a challenge is in its scenario (the GUI
 *                            scheduler's boundary and the card status read it)
 *   reset-scenario-state     forget a challenge's progress — its plan restarts
 *   dry-run-scenario         what would fire right now and why; spends nothing
 *   simulate-scenario        a what-if timeline until the challenge closes, of
 *                            the assigned scenario or an unsaved draft
 */

import * as logger from '../logger';
import * as settings from '../settings';
import * as apiFactory from '../apiFactory';
import * as auth from '../services/auth';
import { registerHandlers } from './registerHandlers';
import { errorResult } from './errorResult';
import { isIdArg } from './isIdArg';
import { getScenarioStatus, ledgerForMode } from '../services/scenarioStatus';
import { findActiveChallenge } from '../services/findActiveChallenge';
import { evaluateScenario, startState } from '../scenarios/evaluate';
import { simulateScenario } from '../scenarios/simulate';
import { SCENARIO_TEMPLATES } from '../scenarios/templates';
import { refreshScenarioStateAsync } from '../scenarioStateStore';

import type { IpcMain } from 'electron';
import type { IpcHandlerMap } from './registerHandlers';
import type { ScenarioDocument, ScenarioIssue } from '../settings/scenarioSchema';
import type { ActiveChallengesResponse, Bankroll, Challenge } from '../types/gurushots';

/**
 * A facade `{ok, ...}` result mapped onto the IPC `{success, ...}` shape.
 */
type FromResult<R> = R extends { ok: false }
    ? { success: false; error: string; issues: ScenarioIssue[] }
    : Omit<R, 'ok'> & { success: true };

type ScenarioStatus = ReturnType<typeof getScenarioStatus>;

const log = () => logger.withCategory('scenario');

const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

// `issues?: undefined` keeps this arm distinct from the validation failures that
// do carry issues, so a renderer narrowing on `'issues' in result` keeps them.
const invalidArgs: { success: false; error: string; issues?: undefined } = { success: false, error: 'invalid-args' };

/**
 * A facade `{ok, issues}` result as an IPC result.
 *
 * A failed result always carries `issues` (every facade failure path does).
 */
const fromResult = <R extends { ok: boolean; issues?: ScenarioIssue[] }>({ ok, ...result }: R): FromResult<R> =>
    (ok
        ? { success: true as const, ...result }
        : {
              success: false as const,
              error: (result as { issues: ScenarioIssue[] }).issues[0]?.message ?? 'Invalid scenario',
              issues: (result as { issues: ScenarioIssue[] }).issues,
          }) as FromResult<R>;

/**
 * Runs a handler body, turning a throw into an error result.
 */
const safely = async <T>(
    label: string,
    body: () => T | Promise<T>,
): Promise<T | { success: false; error: string; issues?: undefined }> => {
    try {
        return await body();
    } catch (error) {
        log().error(`Error handling ${label} request:`, error);
        return errorResult(error, `The ${label} request failed`);
    }
};

/**
 * What the dry run and the simulation both need: the challenge's scenario
 * status, the live challenge, its state (or a start state) and the bankroll.
 * `draft` replaces the assigned scenario with an unsaved document, which then
 * starts from its start phase.
 */
const loadLiveScenario = async (
    label: string,
    challengeId: string | number,
    draft: unknown = null,
): Promise<
    | { ok: false; response: { success: false; error: string; issues?: ScenarioIssue[] } }
    | {
          ok: true;
          status: Omit<ScenarioStatus, 'scenario'> & { scenario: ScenarioDocument };
          challenge: Challenge;
          now: number;
          state: NonNullable<ScenarioStatus['state']> | ReturnType<typeof startState>;
          bankroll: Bankroll | null;
      }
> => {
    const refuse = (
        error: string,
        extra: { issues?: ScenarioIssue[] } = {},
    ): { ok: false; response: { success: false; error: string; issues?: ScenarioIssue[] } } => ({
        ok: false,
        response: { success: false as const, error, ...extra },
    });
    const guard = auth.requireAuthToken(label);
    if (!guard.ok) return { ok: false, response: guard.response };
    await refreshScenarioStateAsync();
    let status = getScenarioStatus(challengeId);
    if (draft !== null) {
        const checked = settings.checkScenario(draft);
        if (!checked.ok) return refuse(checked.issues[0]?.message ?? 'Invalid scenario', { issues: checked.issues });
        status = { ...status, scenario: checked.scenario, state: null, corrupt: false };
    }
    if (!status.scenario) return refuse(status.assigned ? 'unknown-scenario' : 'no-scenario');
    if (status.corrupt) return refuse('state-unreadable');
    const strategy = apiFactory.getApiStrategy();
    const response: ActiveChallengesResponse | null = await strategy.getActiveChallenges(guard.token);
    const challenge = findActiveChallenge(response?.challenges, challengeId);
    if (!challenge) return refuse('challenge-not-found');
    const now = Math.floor(Date.now() / 1000);
    return {
        ok: true,
        // The guard above returned when status.scenario was null.
        status: status as Omit<ScenarioStatus, 'scenario'> & { scenario: ScenarioDocument },
        challenge,
        now,
        state: status.state ?? startState(status.scenario, now),
        bankroll: await strategy.getBankroll(guard.token),
    };
};

type LiveScenario = Extract<Awaited<ReturnType<typeof loadLiveScenario>>, { ok: true }>;

/**
 * The input `evaluateScenario` and `simulateScenario` both take.
 */
const runInput = ({ status, challenge, state, now, bankroll }: LiveScenario) => ({
    scenario: status.scenario,
    state,
    challenge,
    now,
    timezone: status.timezone,
    bankroll,
});

const buildHandlers = () =>
    ({
        'get-scenarios': async () =>
            safely('get-scenarios', () => ({
                success: true as const,
                scenarios: settings.getScenarios(),
                templates: SCENARIO_TEMPLATES,
            })),

        'check-scenario': async (event: unknown, doc: unknown) =>
            safely('check-scenario', () => {
                const result = settings.checkScenario(doc);
                return result.ok ? { success: true as const } : fromResult(result);
            }),

        'save-scenario': async (event: unknown, doc: unknown, options?: { overwrite?: boolean } | null) =>
            safely('save-scenario', () =>
                fromResult(settings.saveScenario(doc, { overwrite: options?.overwrite !== false })),
            ),

        'rename-scenario': async (event: unknown, oldName: string, newName: string) => {
            if (!isName(oldName) || typeof newName !== 'string') return invalidArgs;
            return safely('rename-scenario', () => fromResult(settings.renameScenario(oldName, newName)));
        },

        'delete-scenario': async (event: unknown, name: string) => {
            if (!isName(name)) return invalidArgs;
            return safely('delete-scenario', () =>
                settings.deleteScenario(name)
                    ? { success: true as const }
                    : { success: false as const, error: 'not-found' },
            );
        },

        'preview-scenario-import': async (event: unknown, text: string) =>
            safely('preview-scenario-import', () => fromResult(settings.previewScenarioImport(text))),

        'import-scenario': async (event: unknown, text: string, options?: { overwrite?: boolean } | null) =>
            safely('import-scenario', () =>
                fromResult(settings.importScenario(text, { overwrite: options?.overwrite === true })),
            ),

        'export-scenario': async (event: unknown, name: string) => {
            if (!isName(name)) return invalidArgs;
            return safely('export-scenario', () => {
                const json = settings.exportScenario(name);
                return json === null
                    ? { success: false as const, error: 'not-found' }
                    : { success: true as const, json };
            });
        },

        'get-scenario-status': async (event: unknown, challengeId: string | number) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('get-scenario-status', async () => {
                await refreshScenarioStateAsync();
                return { success: true as const, ...getScenarioStatus(challengeId) };
            });
        },

        'reset-scenario-state': async (event: unknown, challengeId: string | number) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('reset-scenario-state', async () => {
                await refreshScenarioStateAsync();
                ledgerForMode().remove(String(challengeId));
                log().info(
                    `Scenario progress reset for challenge ${logger.sanitizeLogString(String(challengeId))}`,
                    null,
                );
                return { success: true as const };
            });
        },

        'dry-run-scenario': async (event: unknown, challengeId: string | number) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('dry-run-scenario', async () => {
                const loaded = await loadLiveScenario('scenario dry run', challengeId);
                if (!loaded.ok) return loaded.response;
                const { status } = loaded;
                const decision = evaluateScenario(runInput(loaded));
                return {
                    success: true as const,
                    scenario: status.scenario.name,
                    phase: decision.phase,
                    started: status.state !== null,
                    halted: decision.halted,
                    fire: decision.fire
                        ? {
                              ruleId: decision.fire.ruleId,
                              startIndex: decision.fire.startIndex,
                              // `rule` is untyped in scenarios/evaluate; a validated rule's `do` is its action list.
                              actions: (decision.fire.rule.do as Array<{ type: string }>).map((action) => action.type),
                          }
                        : null,
                    explain: decision.explain,
                    nextWakeAt: decision.nextWakeAt,
                };
            });
        },

        'simulate-scenario': async (event: unknown, challengeId: string | number, draft?: unknown) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('simulate-scenario', async () => {
                const loaded = await loadLiveScenario('scenario simulation', challengeId, draft ?? null);
                if (!loaded.ok) return loaded.response;
                const { status, state, now } = loaded;
                const timeline = simulateScenario(runInput(loaded));
                return {
                    success: true as const,
                    scenario: status.scenario.name,
                    startPhase: state.phase,
                    now,
                    ...timeline,
                };
            });
        },
    }) satisfies IpcHandlerMap;

const register = (ipcMain: IpcMain) => registerHandlers(ipcMain, buildHandlers());

export { register, buildHandlers };
