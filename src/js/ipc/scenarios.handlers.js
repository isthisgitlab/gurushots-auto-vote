/**
 * IPC handlers for user-defined scenarios (settings/scenarios.ts,
 * services/scenarioRunner.js). Every handler returns `{success, error}` —
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
import { getScenarioStatus, ledgerForMode } from '../services/scenarioStatus';
import { findActiveChallenge } from '../services/findActiveChallenge';
import { evaluateScenario, startState } from '../scenarios/evaluate';
import { simulateScenario } from '../scenarios/simulate';
import { SCENARIO_TEMPLATES } from '../scenarios/templates';
import { refreshScenarioStateAsync } from '../scenarioStateStore';

/**
 * @import { IpcMain } from 'electron'
 * @import { IpcHandlerMap } from './registerHandlers'
 * @import { ScenarioDocument, ScenarioIssue } from '../settings/scenarioSchema'
 * @import { ActiveChallengesResponse, Bankroll, Challenge } from '../types/gurushots'
 */

/**
 * A facade `{ok, ...}` result mapped onto the IPC `{success, ...}` shape.
 *
 * @template R
 * @typedef {R extends { ok: false }
 *   ? { success: false, error: string, issues: ScenarioIssue[] }
 *   : Omit<R, 'ok'> & { success: true }} FromResult
 */

/** @typedef {ReturnType<typeof getScenarioStatus>} ScenarioStatus */

const log = () => logger.withCategory('scenario');

/**
 * @param {unknown} value
 * @returns {value is string | number}
 */
const isIdArg = (value) => (typeof value === 'string' && value.trim() !== '') || Number.isFinite(value);
/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isName = (value) => typeof value === 'string' && value.trim() !== '';

// `issues?: undefined` keeps this arm distinct from the validation failures that
// do carry issues, so a renderer narrowing on `'issues' in result` keeps them.
/** @type {{ success: false, error: string, issues?: undefined }} */
const invalidArgs = { success: false, error: 'invalid-args' };

/**
 * A facade `{ok, issues}` result as an IPC result.
 *
 * A failed result always carries `issues` (every facade failure path does).
 *
 * @template {{ ok: boolean, issues?: ScenarioIssue[] }} R
 * @param {R} r
 * @returns {FromResult<R>}
 */
const fromResult = ({ ok, ...result }) =>
    /** @type {FromResult<R>} */ (
        ok
            ? { success: true, ...result }
            : {
                  success: false,
                  error: /** @type {{ issues: ScenarioIssue[] }} */ (result).issues[0]?.message ?? 'Invalid scenario',
                  issues: /** @type {{ issues: ScenarioIssue[] }} */ (result).issues,
              }
    );

/**
 * Runs a handler body, turning a throw into an error result.
 *
 * @template T
 * @param {string} label
 * @param {() => T | Promise<T>} body
 * @returns {Promise<T | { success: false, error: string, issues?: undefined }>}
 */
const safely = async (label, body) => {
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
 *
 * @param {string} label
 * @param {string | number} challengeId
 * @param {unknown} [draft]
 * @returns {Promise<
 *   | { ok: false, response: { success: false, error: string, issues?: ScenarioIssue[] } }
 *   | {
 *       ok: true,
 *       status: Omit<ScenarioStatus, 'scenario'> & { scenario: ScenarioDocument },
 *       challenge: Challenge,
 *       now: number,
 *       state: NonNullable<ScenarioStatus['state']> | ReturnType<typeof startState>,
 *       bankroll: Bankroll | null,
 *     }
 * >}
 */
const loadLiveScenario = async (label, challengeId, draft = null) => {
    /**
     * @param {string} error
     * @param {{ issues?: ScenarioIssue[] }} [extra]
     * @returns {{ ok: false, response: { success: false, error: string, issues?: ScenarioIssue[] } }}
     */
    const refuse = (error, extra = {}) => ({ ok: false, response: { success: false, error, ...extra } });
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
    /** @type {ActiveChallengesResponse | null} */
    const response = await strategy.getActiveChallenges(guard.token);
    const challenge = findActiveChallenge(response?.challenges, challengeId);
    if (!challenge) return refuse('challenge-not-found');
    const now = Math.floor(Date.now() / 1000);
    return {
        ok: true,
        // The guard above returned when status.scenario was null.
        status: /** @type {Omit<ScenarioStatus, 'scenario'> & { scenario: ScenarioDocument }} */ (status),
        challenge,
        now,
        state: status.state ?? startState(status.scenario, now),
        bankroll: await strategy.getBankroll(guard.token),
    };
};

const buildHandlers = () =>
    /** @satisfies {IpcHandlerMap} */ ({
        'get-scenarios': async () =>
            safely('get-scenarios', () => ({
                success: true,
                scenarios: settings.getScenarios(),
                templates: SCENARIO_TEMPLATES,
            })),

        'check-scenario': async (/** @type {unknown} */ event, /** @type {unknown} */ doc) =>
            safely('check-scenario', () => {
                const result = settings.checkScenario(doc);
                return result.ok ? { success: true } : fromResult(result);
            }),

        'save-scenario': async (
            /** @type {unknown} */ event,
            /** @type {unknown} */ doc,
            /** @type {{ overwrite?: boolean } | null | undefined} */ options,
        ) =>
            safely('save-scenario', () =>
                fromResult(settings.saveScenario(doc, { overwrite: options?.overwrite !== false })),
            ),

        'rename-scenario': async (
            /** @type {unknown} */ event,
            /** @type {string} */ oldName,
            /** @type {string} */ newName,
        ) => {
            if (!isName(oldName) || typeof newName !== 'string') return invalidArgs;
            return safely('rename-scenario', () => fromResult(settings.renameScenario(oldName, newName)));
        },

        'delete-scenario': async (/** @type {unknown} */ event, /** @type {string} */ name) => {
            if (!isName(name)) return invalidArgs;
            return safely('delete-scenario', () =>
                settings.deleteScenario(name) ? { success: true } : { success: false, error: 'not-found' },
            );
        },

        'preview-scenario-import': async (/** @type {unknown} */ event, /** @type {string} */ text) =>
            safely('preview-scenario-import', () => fromResult(settings.previewScenarioImport(text))),

        'import-scenario': async (
            /** @type {unknown} */ event,
            /** @type {string} */ text,
            /** @type {{ overwrite?: boolean } | null | undefined} */ options,
        ) =>
            safely('import-scenario', () =>
                fromResult(settings.importScenario(text, { overwrite: options?.overwrite === true })),
            ),

        'export-scenario': async (/** @type {unknown} */ event, /** @type {string} */ name) => {
            if (!isName(name)) return invalidArgs;
            return safely('export-scenario', () => {
                const json = settings.exportScenario(name);
                return json === null ? { success: false, error: 'not-found' } : { success: true, json };
            });
        },

        'get-scenario-status': async (/** @type {unknown} */ event, /** @type {string | number} */ challengeId) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('get-scenario-status', async () => {
                await refreshScenarioStateAsync();
                return { success: true, ...getScenarioStatus(challengeId) };
            });
        },

        'reset-scenario-state': async (/** @type {unknown} */ event, /** @type {string | number} */ challengeId) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('reset-scenario-state', async () => {
                await refreshScenarioStateAsync();
                ledgerForMode().remove(String(challengeId));
                log().info(
                    `Scenario progress reset for challenge ${logger.sanitizeLogString(String(challengeId))}`,
                    null,
                );
                return { success: true };
            });
        },

        'dry-run-scenario': async (/** @type {unknown} */ event, /** @type {string | number} */ challengeId) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('dry-run-scenario', async () => {
                const loaded = await loadLiveScenario('scenario dry run', challengeId);
                if (!loaded.ok) return loaded.response;
                const { status, challenge, state, now, bankroll } = loaded;
                const decision = evaluateScenario({
                    scenario: status.scenario,
                    state,
                    challenge,
                    now,
                    timezone: status.timezone,
                    bankroll,
                });
                return {
                    success: true,
                    scenario: status.scenario.name,
                    phase: decision.phase,
                    started: status.state !== null,
                    halted: decision.halted,
                    fire: decision.fire
                        ? {
                              ruleId: decision.fire.ruleId,
                              startIndex: decision.fire.startIndex,
                              // `rule` is untyped in scenarios/evaluate; a validated rule's `do` is its action list.
                              actions: /** @type {Array<{ type: string }>} */ (decision.fire.rule.do).map(
                                  (action) => action.type,
                              ),
                          }
                        : null,
                    explain: decision.explain,
                    nextWakeAt: decision.nextWakeAt,
                };
            });
        },

        'simulate-scenario': async (
            /** @type {unknown} */ event,
            /** @type {string | number} */ challengeId,
            /** @type {unknown} */ draft,
        ) => {
            if (!isIdArg(challengeId)) return invalidArgs;
            return safely('simulate-scenario', async () => {
                const loaded = await loadLiveScenario('scenario simulation', challengeId, draft ?? null);
                if (!loaded.ok) return loaded.response;
                const { status, challenge, state, now, bankroll } = loaded;
                const timeline = simulateScenario({
                    scenario: status.scenario,
                    state,
                    challenge,
                    now,
                    timezone: status.timezone,
                    bankroll,
                });
                return { success: true, scenario: status.scenario.name, startPhase: state.phase, now, ...timeline };
            });
        },
    });

/** @param {IpcMain} ipcMain */
const register = (ipcMain) => registerHandlers(ipcMain, buildHandlers());

export { register, buildHandlers };
