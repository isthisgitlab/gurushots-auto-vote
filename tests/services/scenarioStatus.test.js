/**
 * Scenario status reads (services/scenarioStatus.js) and the Node-side
 * scheduler resolver built on them.
 */

jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(),
    getEffectiveSetting: jest.fn(),
    getScenario: jest.fn(),
}));
jest.mock('../../src/js/logger', () => ({ withCategory: jest.fn(() => ({ error: jest.fn() })) }));

const settings = require('../../src/js/settings');
const { getScenarioStatus, scenarioWakeInput, ledgerForMode } = require('../../src/js/services/scenarioStatus');
const { resolveScenarioWake } = require('../../src/js/scheduling/nodeResolvers');
const {
    createMemoryStateLedger,
    initialState,
    scenarioStateLedger,
    mockScenarioStateLedger,
} = require('../../src/js/scenarioStateStore');

const scenario = { name: 'Plan', version: 1, start: 'main', phases: { main: {} } };
let topLevel;

beforeEach(() => {
    topLevel = { timezone: 'Europe/Riga', mock: false };
    settings.getSetting.mockImplementation((key) => topLevel[key]);
    settings.getEffectiveSetting.mockReturnValue('Plan');
    settings.getScenario.mockReturnValue(scenario);
});

describe('getScenarioStatus', () => {
    test('no assignment, or an unknown scenario', () => {
        settings.getEffectiveSetting.mockReturnValue('');
        expect(getScenarioStatus(7)).toEqual({
            assigned: '',
            scenario: null,
            state: null,
            corrupt: false,
            timezone: 'Europe/Riga',
        });
        settings.getEffectiveSetting.mockReturnValue(undefined);
        expect(getScenarioStatus(7).assigned).toBe('');
        settings.getEffectiveSetting.mockReturnValue('Gone');
        settings.getScenario.mockReturnValue(null);
        expect(getScenarioStatus(7)).toEqual(expect.objectContaining({ assigned: 'Gone', scenario: null }));
    });

    test('state of the assigned scenario (any casing), none for another scenario, and corruption', () => {
        const ledger = createMemoryStateLedger();
        expect(getScenarioStatus(7, ledger)).toEqual(
            expect.objectContaining({ scenario, state: null, corrupt: false }),
        );
        ledger.set(7, initialState('PLAN', 'main', 5));
        expect(getScenarioStatus('7', ledger).state.phase).toBe('main');
        ledger.set(7, initialState('Other', 'main', 5));
        expect(getScenarioStatus(7, ledger).state).toBeNull();
        const broken = { get: () => ({ corrupt: true, state: null }) };
        expect(getScenarioStatus(7, broken).corrupt).toBe(true);
    });

    test('falls back to the default timezone', () => {
        topLevel.timezone = '';
        expect(getScenarioStatus(7, createMemoryStateLedger()).timezone).toBe('Europe/Riga');
    });
});

test('ledgerForMode follows the mock setting', () => {
    expect(ledgerForMode()).toBe(scenarioStateLedger);
    topLevel.mock = true;
    expect(ledgerForMode()).toBe(mockScenarioStateLedger);
});

describe('scenarioWakeInput / resolveScenarioWake', () => {
    test('only a known scenario with readable state yields an input', () => {
        expect(scenarioWakeInput({ scenario, state: null, corrupt: false, timezone: 'UTC' })).toEqual({
            scenario,
            state: null,
            timezone: 'UTC',
        });
        expect(scenarioWakeInput({ scenario, state: null, corrupt: true, timezone: 'UTC' })).toBeNull();
        expect(scenarioWakeInput({ scenario: null, state: null, corrupt: false, timezone: 'UTC' })).toBeNull();
    });

    test('the Node resolver reads the status of the challenge', () => {
        topLevel.mock = true;
        mockScenarioStateLedger.set(9, initialState('Plan', 'main', 1));
        expect(resolveScenarioWake('9')).toEqual({
            scenario,
            state: expect.objectContaining({ phase: 'main' }),
            timezone: 'Europe/Riga',
        });
        mockScenarioStateLedger.remove(9);
    });
});
