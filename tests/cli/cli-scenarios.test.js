/**
 * CLI scenario commands over the scenario IPC handlers (mocked): output,
 * the import preview + --yes gate, file reads/writes and exit codes.
 */

jest.mock('../../src/js/logger', () => {
    const calls = [];
    const rec = (level) => (msg) => calls.push({ level, msg: String(msg) });
    const cat = { info: rec('info'), error: rec('error'), success: rec('success'), warning: rec('warning') };
    return { __calls: calls, withCategory: jest.fn(() => cat) };
});
jest.mock('../../src/js/ipc/scenarios.handlers', () => {
    const handlers = Object.fromEntries(
        [
            'get-scenarios',
            'preview-scenario-import',
            'import-scenario',
            'export-scenario',
            'rename-scenario',
            'delete-scenario',
            'get-scenario-status',
            'reset-scenario-state',
            'dry-run-scenario',
        ].map((channel) => [channel, jest.fn()]),
    );
    return { __handlers: handlers, buildHandlers: () => handlers };
});
jest.mock('node:fs', () => ({ readFileSync: jest.fn(), writeFileSync: jest.fn() }));

const fs = require('node:fs');
const logger = require('../../src/js/logger');
const { __handlers: h } = require('../../src/js/ipc/scenarios.handlers');
const cmd = require('../../src/js/cli/commands/scenarios');

const lines = (level) => logger.__calls.filter((c) => !level || c.level === level).map((c) => c.msg);
const text = (level) => lines(level).join('\n');

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
});

const failure = {
    success: false,
    error: 'bad',
    issues: [
        { path: 'start', message: 'No phase' },
        { path: '', message: 'Root' },
    ],
};

describe('list-scenarios', () => {
    test('lists scenarios with their phases and the templates', async () => {
        h['get-scenarios'].mockResolvedValue({
            success: true,
            scenarios: {
                Plan: { start: 'main', description: 'Mine', phases: { main: {}, done: {} } },
                Bare: { start: 'a', phases: { a: {} } },
            },
        });
        await expect(cmd.listScenarios()).resolves.toBe(0);
        expect(text()).toContain('Plan — 2 phase(s), starts in "main"');
        expect(text()).toContain('Mine');
        expect(text()).toContain('Templates: exhibitionDoubleDip');
    });

    test('an empty list and a failure', async () => {
        h['get-scenarios'].mockResolvedValueOnce({ success: true, scenarios: {} });
        await cmd.listScenarios();
        expect(text()).toContain('No scenarios yet.');
        h['get-scenarios'].mockResolvedValueOnce(failure);
        await expect(cmd.listScenarios()).resolves.toBe(1);
        expect(text('error')).toContain('start: No phase');
        expect(text('error')).toContain('(document): Root');
    });
});

describe('scenario-template', () => {
    test('prints or writes a template; an unknown id fails', async () => {
        await expect(cmd.scenarioTemplate('eveningBoost')).resolves.toBe(0);
        expect(text()).toContain('"name": "Evening boost before the last day"');
        await expect(cmd.scenarioTemplate('eveningBoost', 'out.json')).resolves.toBe(0);
        expect(fs.writeFileSync).toHaveBeenCalledWith('out.json', expect.stringContaining('Evening boost'), 'utf8');
        await expect(cmd.scenarioTemplate('nope')).resolves.toBe(1);
    });

    test('a write error fails', async () => {
        fs.writeFileSync.mockImplementationOnce(() => {
            throw new Error('EACCES');
        });
        await expect(cmd.scenarioTemplate('eveningBoost', '/root/x.json')).resolves.toBe(1);
        expect(text('error')).toContain('Could not write /root/x.json: EACCES');
    });
});

describe('import-scenario', () => {
    const preview = (overrides = {}) => ({
        success: true,
        exists: false,
        preview: {
            name: 'Plan',
            start: 'main',
            description: 'Mine',
            phases: [
                { name: 'main', rules: 2, settings: ['exposure', 'exposureTarget'] },
                { name: 'done', rules: 0, settings: [] },
            ],
            spending: [{ action: 'swap', phase: 'main', rule: 'Hold it' }],
            limits: { swaps: 3 },
            ...overrides,
        },
    });

    beforeEach(() => fs.readFileSync.mockReturnValue('{"name":"Plan"}'));

    test('without --yes it only shows what the scenario does', async () => {
        h['preview-scenario-import'].mockResolvedValue(preview());
        await expect(cmd.importScenarioCmd('plan.json')).resolves.toBe(0);
        expect(text()).toContain('phase main: 2 rule(s), settings: exposure, exposureTarget');
        expect(text()).toContain('swap (main → Hold it)');
        expect(text()).toContain('Limits: 3 swaps');
        expect(text()).toContain('re-run: import-scenario plan.json --yes');
        expect(h['import-scenario']).not.toHaveBeenCalled();
    });

    test('a scenario that spends nothing and replaces an existing one', async () => {
        h['preview-scenario-import'].mockResolvedValue({
            ...preview({ spending: [], limits: {}, description: '' }),
            exists: true,
        });
        await cmd.importScenarioCmd('plan.json', { overwrite: true });
        expect(text()).toContain('Spends nothing.');
        expect(text()).toContain('No spending limits.');
        expect(text('warning')).toContain('already exists');
        expect(text()).toContain('import-scenario plan.json --overwrite --yes');
    });

    test('with --yes it imports', async () => {
        h['preview-scenario-import'].mockResolvedValue(preview());
        h['import-scenario'].mockResolvedValue({ success: true, name: 'Plan' });
        await expect(cmd.importScenarioCmd('plan.json', { yes: true, overwrite: true })).resolves.toBe(0);
        expect(h['import-scenario']).toHaveBeenCalledWith(null, '{"name":"Plan"}', { overwrite: true });
        expect(text('success')).toContain('Imported scenario "Plan"');
    });

    test('an unreadable file, an invalid scenario and a failed import', async () => {
        fs.readFileSync.mockImplementationOnce(() => {
            throw new Error('ENOENT');
        });
        await expect(cmd.importScenarioCmd('missing.json')).resolves.toBe(1);
        h['preview-scenario-import'].mockResolvedValueOnce(failure);
        await expect(cmd.importScenarioCmd('plan.json')).resolves.toBe(1);
        expect(text('error')).toContain('plan.json is not a valid scenario: bad');
        h['preview-scenario-import'].mockResolvedValueOnce(preview());
        h['import-scenario'].mockResolvedValueOnce(failure);
        await expect(cmd.importScenarioCmd('plan.json', { yes: true })).resolves.toBe(1);
    });
});

describe('export / rename / delete', () => {
    test('success paths', async () => {
        h['export-scenario'].mockResolvedValue({ success: true, json: '{}\n' });
        await expect(cmd.exportScenarioCmd('Plan', 'plan.json')).resolves.toBe(0);
        expect(fs.writeFileSync).toHaveBeenCalledWith('plan.json', '{}\n', 'utf8');
        h['rename-scenario'].mockResolvedValue({ success: true, name: 'New' });
        await expect(cmd.renameScenarioCmd('Old', 'New')).resolves.toBe(0);
        h['delete-scenario'].mockResolvedValue({ success: true });
        await expect(cmd.deleteScenarioCmd('Plan')).resolves.toBe(0);
        expect(text('success')).toContain('Deleted "Plan"');
    });

    test('failures exit 1', async () => {
        for (const [channel, run] of [
            ['export-scenario', () => cmd.exportScenarioCmd('Plan')],
            ['rename-scenario', () => cmd.renameScenarioCmd('Old', 'New')],
            ['delete-scenario', () => cmd.deleteScenarioCmd('Plan')],
        ]) {
            h[channel].mockResolvedValueOnce({ success: false, error: 'not-found' });
            await expect(run()).resolves.toBe(1);
        }
    });
});

describe('scenario-status', () => {
    const status = (overrides) => ({
        success: true,
        assigned: 'Plan',
        scenario: { name: 'Plan', start: 'main' },
        corrupt: false,
        state: null,
        ...overrides,
    });

    test('no scenario, an unknown one, unreadable state, not started', async () => {
        h['get-scenario-status'].mockResolvedValueOnce(status({ assigned: '' }));
        await expect(cmd.scenarioStatusCmd('7')).resolves.toBe(0);
        expect(text()).toContain('has no scenario');
        h['get-scenario-status'].mockResolvedValueOnce(status({ assigned: 'Gone', scenario: null }));
        await cmd.scenarioStatusCmd('7');
        expect(text('warning')).toContain('"Gone", which does not exist');
        h['get-scenario-status'].mockResolvedValueOnce(status({ corrupt: true }));
        await expect(cmd.scenarioStatusCmd('7')).resolves.toBe(1);
        h['get-scenario-status'].mockResolvedValueOnce(status());
        await cmd.scenarioStatusCmd('7');
        expect(text()).toContain('Not started yet');
        h['get-scenario-status'].mockResolvedValueOnce({ success: false, error: 'invalid-args' });
        await expect(cmd.scenarioStatusCmd('')).resolves.toBe(1);
    });

    test('a running plan: phase, memory, spends, interruption, last action and problem', async () => {
        h['get-scenario-status'].mockResolvedValue(
            status({
                state: {
                    phase: 'holding',
                    phaseEnteredAt: 1_800_000_000,
                    memory: { held: 'p1' },
                    spent: { swaps: 1 },
                    inFlight: { ruleId: 'r1', actionIndex: 1 },
                    lastAction: { action: 'swap', ruleId: 'r1', at: 1_800_000_100 },
                    lastError: { message: 'boost not available', at: 1_800_000_200 },
                },
            }),
        );
        await cmd.scenarioStatusCmd('7');
        expect(text()).toContain('Phase: holding');
        expect(text()).toContain('Remembered: held=p1');
        expect(text()).toContain('Spent: 1 swaps, 0 keys, 0 fills');
        expect(text()).toContain('resumes at action 2');
        expect(text()).toContain('Last action: swap (r1)');
        expect(text('warning')).toContain('Last problem: boost not available');
    });

    test('a quiet plan prints only its phase', async () => {
        h['get-scenario-status'].mockResolvedValue(
            status({
                state: {
                    phase: 'main',
                    phaseEnteredAt: 1,
                    memory: {},
                    spent: {},
                    inFlight: null,
                    lastAction: null,
                    lastError: null,
                },
            }),
        );
        await cmd.scenarioStatusCmd('7');
        expect(text()).not.toContain('Remembered');
    });
});

describe('scenario-reset / dry-run / vocabulary', () => {
    test('reset', async () => {
        h['reset-scenario-state'].mockResolvedValueOnce({ success: true }).mockResolvedValueOnce(failure);
        await expect(cmd.scenarioResetCmd('7')).resolves.toBe(0);
        await expect(cmd.scenarioResetCmd('7')).resolves.toBe(1);
    });

    test('dry run explains every rule and what would run', async () => {
        h['dry-run-scenario'].mockResolvedValueOnce({
            success: true,
            scenario: 'Plan',
            phase: 'main',
            started: false,
            halted: null,
            explain: [{ status: 'waiting', label: 'Morning entry', reason: 'condition 1 (dailyWindow) does not hold' }],
            fire: { ruleId: 'r2', startIndex: 1, actions: ['swap', 'boost', 'goto'] },
            nextWakeAt: 1_800_000_000,
        });
        await expect(cmd.scenarioDryRunCmd('7')).resolves.toBe(0);
        expect(text()).toContain('phase main (not started yet)');
        expect(text()).toContain('[waiting] Morning entry');
        expect(text()).toContain('Would run now: r2 → boost, goto');
    });

    test('dry run: nothing ready, halted, or failed', async () => {
        h['dry-run-scenario'].mockResolvedValueOnce({
            success: true,
            scenario: 'Plan',
            phase: 'main',
            started: true,
            halted: null,
            explain: [],
            fire: null,
            nextWakeAt: null,
        });
        await cmd.scenarioDryRunCmd('7');
        expect(text()).toContain('Nothing would run now.');
        expect(text()).toContain('nothing time-based pending');
        h['dry-run-scenario'].mockResolvedValueOnce({
            success: true,
            scenario: 'Plan',
            phase: 'x',
            started: true,
            halted: 'Phase gone',
        });
        await expect(cmd.scenarioDryRunCmd('7')).resolves.toBe(1);
        h['dry-run-scenario'].mockResolvedValueOnce({ success: false, error: 'no-scenario' });
        await expect(cmd.scenarioDryRunCmd('7')).resolves.toBe(1);
    });

    test('vocabulary lists every piece', async () => {
        await expect(cmd.scenarioVocabulary()).resolves.toBe(0);
        expect(text()).toContain('dailyWindow');
        expect(text()).toContain('enterPhoto');
    });
});
