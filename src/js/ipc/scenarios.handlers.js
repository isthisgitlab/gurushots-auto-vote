/**
 * IPC handlers for user-defined scenarios (settings/scenarios.js,
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

const logger = require('../logger');
const settings = require('../settings');
const apiFactory = require('../apiFactory');
const auth = require('../services/auth');
const { registerHandlers } = require('./registerHandlers');
const { errorResult } = require('./errorResult');
const { getScenarioStatus, ledgerForMode } = require('../services/scenarioStatus');
const { findActiveChallenge } = require('../services/findActiveChallenge');
const { evaluateScenario } = require('../scenarios/evaluate');
const { simulateScenario } = require('../scenarios/simulate');
const { SCENARIO_TEMPLATES } = require('../scenarios/templates');
const { refreshScenarioStateAsync } = require('../scenarioStateStore');

const log = () => logger.withCategory('scenario');

const isIdArg = (value) => (typeof value === 'string' && value.trim() !== '') || Number.isFinite(value);
const isName = (value) => typeof value === 'string' && value.trim() !== '';

const invalidArgs = { success: false, error: 'invalid-args' };

/** A facade `{ok, issues}` result as an IPC result. */
const fromResult = ({ ok, ...result }) =>
    ok
        ? { success: true, ...result }
        : { success: false, error: result.issues[0]?.message ?? 'Invalid scenario', issues: result.issues };

/** Runs a handler body, turning a throw into an error result. */
const safely = async (label, body) => {
    try {
        return await body();
    } catch (error) {
        log().error(`Error handling ${label} request:`, error);
        return errorResult(error, `The ${label} request failed`);
    }
};

const startState = (scenario, now) => ({
    phase: scenario.start,
    phaseEnteredAt: now,
    memory: {},
    fired: {},
    inFlight: null,
});

/**
 * What the dry run and the simulation both need: the challenge's scenario
 * status, the live challenge, its state (or a start state) and the bankroll.
 * `draft` replaces the assigned scenario with an unsaved document, which then
 * starts from its start phase.
 */
const loadLiveScenario = async (label, challengeId, draft = null) => {
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
    const response = await strategy.getActiveChallenges(guard.token);
    const challenge = findActiveChallenge(response?.challenges, challengeId);
    if (!challenge) return refuse('challenge-not-found');
    const now = Math.floor(Date.now() / 1000);
    return {
        ok: true,
        status,
        challenge,
        now,
        state: status.state ?? startState(status.scenario, now),
        bankroll: await strategy.getBankroll(guard.token),
    };
};

const buildHandlers = () => ({
    'get-scenarios': async () =>
        safely('get-scenarios', () => ({
            success: true,
            scenarios: settings.getScenarios(),
            templates: SCENARIO_TEMPLATES,
        })),

    'check-scenario': async (event, doc) =>
        safely('check-scenario', () => {
            const result = settings.checkScenario(doc);
            return result.ok ? { success: true } : fromResult(result);
        }),

    'save-scenario': async (event, doc, options) =>
        safely('save-scenario', () =>
            fromResult(settings.saveScenario(doc, { overwrite: options?.overwrite !== false })),
        ),

    'rename-scenario': async (event, oldName, newName) => {
        if (!isName(oldName) || typeof newName !== 'string') return invalidArgs;
        return safely('rename-scenario', () => fromResult(settings.renameScenario(oldName, newName)));
    },

    'delete-scenario': async (event, name) => {
        if (!isName(name)) return invalidArgs;
        return safely('delete-scenario', () =>
            settings.deleteScenario(name) ? { success: true } : { success: false, error: 'not-found' },
        );
    },

    'preview-scenario-import': async (event, text) =>
        safely('preview-scenario-import', () => fromResult(settings.previewScenarioImport(text))),

    'import-scenario': async (event, text, options) =>
        safely('import-scenario', () =>
            fromResult(settings.importScenario(text, { overwrite: options?.overwrite === true })),
        ),

    'export-scenario': async (event, name) => {
        if (!isName(name)) return invalidArgs;
        return safely('export-scenario', () => {
            const json = settings.exportScenario(name);
            return json === null ? { success: false, error: 'not-found' } : { success: true, json };
        });
    },

    'get-scenario-status': async (event, challengeId) => {
        if (!isIdArg(challengeId)) return invalidArgs;
        return safely('get-scenario-status', async () => {
            await refreshScenarioStateAsync();
            return { success: true, ...getScenarioStatus(challengeId) };
        });
    },

    'reset-scenario-state': async (event, challengeId) => {
        if (!isIdArg(challengeId)) return invalidArgs;
        return safely('reset-scenario-state', async () => {
            await refreshScenarioStateAsync();
            ledgerForMode().remove(String(challengeId));
            log().info(`Scenario progress reset for challenge ${logger.sanitizeLogString(String(challengeId))}`, null);
            return { success: true };
        });
    },

    'dry-run-scenario': async (event, challengeId) => {
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
                          actions: decision.fire.rule.do.map((action) => action.type),
                      }
                    : null,
                explain: decision.explain,
                nextWakeAt: decision.nextWakeAt,
            };
        });
    },

    'simulate-scenario': async (event, challengeId, draft) => {
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

const register = (ipcMain) => registerHandlers(ipcMain, buildHandlers());

module.exports = { register, buildHandlers };
