/**
 * IPC handlers for user-defined scenarios (settings/scenarios.js,
 * services/scenarioRunner.js). Every handler returns `{success, error}` and
 * never throws to the renderer.
 *
 *   get-scenario-status - where a challenge is in its assigned scenario (the
 *                         GUI scheduler's scenario boundary and the card's
 *                         status line read it)
 */

const logger = require('../logger');
const { registerHandlers } = require('./registerHandlers');
const { errorResult } = require('./errorResult');
const { getScenarioStatus } = require('../services/scenarioStatus');

const isIdArg = (value) => (typeof value === 'string' && value.trim() !== '') || Number.isFinite(value);

const buildHandlers = () => ({
    'get-scenario-status': async (event, challengeId) => {
        if (!isIdArg(challengeId)) return { success: false, error: 'invalid-args' };
        try {
            return { success: true, ...getScenarioStatus(challengeId) };
        } catch (error) {
            logger.withCategory('scenario').error('Error handling get-scenario-status request:', error);
            return errorResult(error, 'Could not read the scenario status');
        }
    },
});

const register = (ipcMain) => registerHandlers(ipcMain, buildHandlers());

module.exports = { register, buildHandlers };
