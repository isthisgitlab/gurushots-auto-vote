/**
 * Where a challenge is in its assigned scenario — one read shared by the
 * Node-side scheduler resolver (scheduling/nodeResolvers.js), the
 * get-scenario-status IPC channel (the GUI's resolver and status line) and
 * the CLI. Reads only; the runner (scenarioRunner.js) is the only writer.
 */

const settings = require('../settings');
const { DEFAULT_TIMEZONE } = require('../settings/uiDefaults');
const { scenarioStateLedger, mockScenarioStateLedger } = require('../scenarioStateStore');

/**
 * Mock mode keeps scenario state in memory — the same process-wide ledger the
 * mock voting pass writes.
 */
const ledgerForMode = () => (settings.getSetting('mock') === true ? mockScenarioStateLedger : scenarioStateLedger);

/**
 * @param {string|number} challengeId
 * @param {object} [ledger] - defaults to the ledger for the current mode
 * @returns {{assigned: string, scenario: object|null, state: object|null, corrupt: boolean, timezone: string}}
 *   `assigned` is the challenge's `scenario` setting ('' = none); `scenario`
 *   is null when that name is unknown; `state` is null until the plan starts
 *   (or when it belongs to another scenario); `corrupt` means unreadable state.
 */
const getScenarioStatus = (challengeId, ledger = ledgerForMode()) => {
    const id = String(challengeId);
    const timezone = settings.getSetting('timezone') || DEFAULT_TIMEZONE;
    const assigned = settings.getEffectiveSetting('scenario', id) || '';
    const scenario = assigned ? settings.getScenario(assigned) : null;
    if (!scenario) return { assigned, scenario: null, state: null, corrupt: false, timezone };
    const { corrupt, state } = ledger.get(id);
    const current = state && state.scenario.toLowerCase() === scenario.name.toLowerCase() ? state : null;
    return { assigned, scenario, state: current, corrupt, timezone };
};

/**
 * The input the scheduler's scenario boundary needs, or null when nothing can
 * run for this challenge (no known scenario, or unreadable state).
 *
 * @param {{scenario: object|null, state: object|null, corrupt: boolean, timezone: string}} status
 */
const scenarioWakeInput = ({ scenario, state, corrupt, timezone }) =>
    scenario && !corrupt ? { scenario, state, timezone } : null;

module.exports = { getScenarioStatus, scenarioWakeInput, ledgerForMode };
