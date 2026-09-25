/**
 * CLI scenario commands — list, template, import (with the same preview and
 * --yes confirmation the GUI's import dialog has), export, rename, delete,
 * plus per-challenge status, reset and dry run. Each reuses the scenario IPC
 * handlers called with a null event (the Capacitor bridge shape), so the CLI
 * and the GUI cannot drift. Every command returns its exit code.
 */

const fs = require('node:fs');
const logger = require('../../logger');
const { formatDateTime } = require('../../dateFormat');
const { SCENARIO_TEMPLATES } = require('../../scenarios/templates');
const { VOCABULARY_REFERENCE } = require('../../scenarios/vocabulary');

// Built lazily so requiring this module (e.g. for `help`) does not construct
// the handler set or pull in its transitive dependencies.
let _handlers;
const handlers = () => (_handlers ??= require('../../ipc/scenarios.handlers').buildHandlers());

const ui = () => logger.withCategory('ui');

const at = (sec) => (Number.isFinite(sec) ? formatDateTime(new Date(sec * 1000)) : 'nothing time-based pending');

/** Print a failed result — its issues when validation failed — and yield exit code 1. */
const reportFailure = (result, what) => {
    ui().error(`${what}: ${result.error}`);
    for (const issue of result.issues ?? []) ui().error(`  ${issue.path || '(document)'}: ${issue.message}`);
    return 1;
};

/** Write `text` to `file`, or print it when no file is given. */
const output = (text, file) => {
    if (!file) {
        ui().info(text);
        return 0;
    }
    try {
        fs.writeFileSync(file, text, 'utf8');
        ui().success(`Written to ${file}`);
        return 0;
    } catch (error) {
        ui().error(`Could not write ${file}: ${error.message}`);
        return 1;
    }
};

const listScenarios = async () => {
    const result = await handlers()['get-scenarios']();
    if (!result.success) return reportFailure(result, 'Could not list scenarios');
    const names = Object.keys(result.scenarios);
    ui().info(names.length ? `Scenarios (${names.length}):` : 'No scenarios yet.');
    for (const name of names) {
        const scenario = result.scenarios[name];
        ui().info(`  • ${name} — ${Object.keys(scenario.phases).length} phase(s), starts in "${scenario.start}"`);
        if (scenario.description) ui().info(`      ${scenario.description}`);
    }
    ui().info(`Templates: ${SCENARIO_TEMPLATES.map((t) => t.id).join(', ')} (scenario-template <id> [file])`);
    return 0;
};

const scenarioTemplate = async (id, file) => {
    const template = SCENARIO_TEMPLATES.find((t) => t.id === id);
    if (!template) {
        ui().error(`Unknown template "${id}". Templates: ${SCENARIO_TEMPLATES.map((t) => t.id).join(', ')}`);
        return 1;
    }
    return output(`${JSON.stringify(template.scenario, null, 2)}\n`, file);
};

const printPreview = ({ preview, exists }) => {
    ui().info(`Scenario "${preview.name}" — starts in phase "${preview.start}"`);
    if (preview.description) ui().info(`  ${preview.description}`);
    for (const phase of preview.phases) {
        const overlay = phase.settings.length ? `, settings: ${phase.settings.join(', ')}` : '';
        ui().info(`  • phase ${phase.name}: ${phase.rules} rule(s)${overlay}`);
    }
    if (preview.spending.length) {
        ui().info('  Spends:');
        for (const spend of preview.spending) ui().info(`    - ${spend.action} (${spend.phase} → ${spend.rule})`);
    } else {
        ui().info('  Spends nothing.');
    }
    const limits = Object.entries(preview.limits);
    ui().info(limits.length ? `  Limits: ${limits.map(([k, v]) => `${v} ${k}`).join(', ')}` : '  No spending limits.');
    if (exists) ui().warning(`  A scenario named "${preview.name}" already exists — importing needs --overwrite.`);
};

const importScenarioCmd = async (file, { overwrite = false, yes = false } = {}) => {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        ui().error(`Could not read ${file}: ${error.message}`);
        return 1;
    }
    const preview = await handlers()['preview-scenario-import'](null, text);
    if (!preview.success) return reportFailure(preview, `${file} is not a valid scenario`);
    printPreview(preview);
    if (!yes) {
        ui().info(
            `Nothing imported yet. To import, re-run: import-scenario ${file}${overwrite ? ' --overwrite' : ''} --yes`,
        );
        return 0;
    }
    const result = await handlers()['import-scenario'](null, text, { overwrite });
    if (!result.success) return reportFailure(result, 'Import failed');
    ui().success(`Imported scenario "${result.name}".`);
    return 0;
};

const exportScenarioCmd = async (name, file) => {
    const result = await handlers()['export-scenario'](null, name);
    if (!result.success) return reportFailure(result, `Could not export "${name}"`);
    return output(result.json, file);
};

const renameScenarioCmd = async (oldName, newName) => {
    const result = await handlers()['rename-scenario'](null, oldName, newName);
    if (!result.success) return reportFailure(result, `Could not rename "${oldName}"`);
    ui().success(`Renamed "${oldName}" to "${result.name}" — its assignments moved with it.`);
    return 0;
};

const deleteScenarioCmd = async (name) => {
    const result = await handlers()['delete-scenario'](null, name);
    if (!result.success) return reportFailure(result, `Could not delete "${name}"`);
    ui().success(`Deleted "${name}" and cleared its assignments.`);
    return 0;
};

const scenarioStatusCmd = async (challengeId) => {
    const status = await handlers()['get-scenario-status'](null, challengeId);
    if (!status.success) return reportFailure(status, 'Could not read the scenario status');
    if (!status.assigned) {
        ui().info(`Challenge ${challengeId} has no scenario.`);
        return 0;
    }
    if (!status.scenario) {
        ui().warning(`Challenge ${challengeId} is assigned "${status.assigned}", which does not exist — nothing runs.`);
        return 0;
    }
    if (status.corrupt) {
        ui().error('Its scenario state is unreadable. Reset it (scenario-reset) to start the plan again.');
        return 1;
    }
    const { state } = status;
    ui().info(`Scenario "${status.scenario.name}" on challenge ${challengeId}`);
    if (!state) {
        ui().info(`  Not started yet — it starts in phase "${status.scenario.start}" on the next voting pass.`);
        return 0;
    }
    ui().info(`  Phase: ${state.phase} (since ${at(state.phaseEnteredAt)})`);
    const memory = Object.entries(state.memory);
    if (memory.length) ui().info(`  Remembered: ${memory.map(([slot, id]) => `${slot}=${id}`).join(', ')}`);
    ui().info(
        `  Spent: ${state.spent.swaps ?? 0} swaps, ${state.spent.keys ?? 0} keys, ${state.spent.fills ?? 0} fills`,
    );
    if (state.inFlight)
        ui().info(`  Interrupted rule "${state.inFlight.ruleId}" resumes at action ${state.inFlight.actionIndex + 1}`);
    if (state.lastAction)
        ui().info(
            `  Last action: ${state.lastAction.action} (${state.lastAction.ruleId}) at ${at(state.lastAction.at)}`,
        );
    if (state.lastError) ui().warning(`  Last problem: ${state.lastError.message} (${at(state.lastError.at)})`);
    return 0;
};

const scenarioResetCmd = async (challengeId) => {
    const result = await handlers()['reset-scenario-state'](null, challengeId);
    if (!result.success) return reportFailure(result, 'Could not reset the scenario');
    ui().success(
        `Scenario progress reset for challenge ${challengeId} — the plan starts again on the next voting pass.`,
    );
    return 0;
};

const scenarioDryRunCmd = async (challengeId) => {
    const result = await handlers()['dry-run-scenario'](null, challengeId);
    if (!result.success) return reportFailure(result, 'Dry run failed');
    ui().info(`Scenario "${result.scenario}" — phase ${result.phase}${result.started ? '' : ' (not started yet)'}`);
    if (result.halted) {
        ui().error(`  Halted: ${result.halted}`);
        return 1;
    }
    for (const rule of result.explain) ui().info(`  [${rule.status}] ${rule.label}: ${rule.reason}`);
    ui().info(
        result.fire
            ? `  Would run now: ${result.fire.ruleId} → ${result.fire.actions.slice(result.fire.startIndex).join(', ')}`
            : '  Nothing would run now.',
    );
    ui().info(`  Next time-based check: ${at(result.nextWakeAt)}`);
    return 0;
};

const STOP_REASONS = {
    closed: 'the challenge closes',
    idle: 'nothing more is time-based — the plan now waits on live data (votes, rank, boost) the simulation holds still',
    halted: 'the scenario halts',
    limit: 'the timeline is long — only the first steps are shown',
};

const scenarioSimulateCmd = async (challengeId) => {
    const result = await handlers()['simulate-scenario'](null, challengeId);
    if (!result.success) return reportFailure(result, 'Simulation failed');
    ui().info(`Scenario "${result.scenario}" from phase ${result.startPhase}, assuming every step succeeds:`);
    if (result.events.length === 0) ui().info('  Nothing would run.');
    for (const event of result.events) {
        const move = event.toPhase ? ` → phase ${event.toPhase}` : '';
        ui().info(`  ${at(event.at)}  [${event.phase}] ${event.label}: ${event.actions.join(', ')}${move}`);
    }
    ui().info(`  Stops at ${at(result.stoppedAt)}: ${STOP_REASONS[result.stoppedBecause]}.`);
    if (result.halted) ui().warning(`  ${result.halted}`);
    return 0;
};

const scenarioVocabulary = async () => {
    for (const [kind, type, fields] of VOCABULARY_REFERENCE)
        ui().info(`  ${kind.padEnd(9)} ${type.padEnd(16)} ${fields}`);
    return 0;
};

module.exports = {
    listScenarios,
    scenarioTemplate,
    importScenarioCmd,
    exportScenarioCmd,
    renameScenarioCmd,
    deleteScenarioCmd,
    scenarioStatusCmd,
    scenarioResetCmd,
    scenarioDryRunCmd,
    scenarioSimulateCmd,
    scenarioVocabulary,
};
