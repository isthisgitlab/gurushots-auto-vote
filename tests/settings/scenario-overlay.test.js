/**
 * The scenario phase-settings overlay in getEffectiveSetting: while a
 * challenge is in a phase of its assigned scenario, that phase's settings win
 * over every other layer; otherwise nothing changes, and stored overrides are
 * never touched.
 */

const settings = require('../../src/js/settings');
const { scenarioStateLedger, mockScenarioStateLedger, initialState } = require('../../src/js/scenarioStateStore');

jest.mock('../../src/js/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => category),
    };
});

const plan = {
    name: 'Plan',
    version: 1,
    start: 'buildup',
    phases: {
        buildup: { settings: { exposure: 10, exposureTarget: 12, autoFill: false } },
        done: {},
    },
};

describe('scenario phase-settings overlay', () => {
    let store;

    beforeEach(() => {
        globalThis.__GS_HEADLESS__ = true;
        store = {
            value: null,
            keys: {},
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
            readKey: jest.fn((key) => store.keys[key] ?? null),
            writeKey: jest.fn((key, data) => {
                store.keys[key] = data;
            }),
        };
        globalThis.AndroidHeadlessStore = store;
        settings.rememberChallengeTitles([{ id: 7, title: 'Big show', type: 'exhibition' }]);
        settings.setGlobalDefault('exposure', 100);
        settings.setGlobalDefault('exposureTarget', 100);
    });

    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
        delete globalThis.AndroidHeadlessStore;
        settings.rememberChallengeTitles([]);
    });

    const assign = () => {
        settings.saveScenario(plan);
        settings.setChallengeOverride('scenario', '7', 'Plan');
    };

    test('no stored scenarios: settings are untouched', () => {
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test('in a phase, its settings win over the manual override and rules', () => {
        assign();
        settings.setChallengeOverride('autoFill', '7', true);
        settings.setTitleRules([{ type: 'exhibition', autoFill: true }]);
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1000));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
        expect(settings.getEffectiveSetting('exposureTarget', 7)).toBe(12);
        expect(settings.getEffectiveSetting('autoFill', '7')).toBe(false);
        // Keys the phase does not set, the global view and the stored overrides are unchanged.
        expect(settings.getEffectiveSetting('autoBoost', '7')).toBe(settings.getGlobalDefault('autoBoost'));
        expect(settings.getEffectiveSetting('exposure')).toBe(100);
        expect(settings.getChallengeOverrides('7')).toEqual({ scenario: 'Plan', autoFill: true });
    });

    test('the assignment itself is never overlaid', () => {
        assign();
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1000));
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Plan');
    });

    test('leaving to a phase without settings restores normal values', () => {
        assign();
        scenarioStateLedger.set(7, initialState('Plan', 'done', 1000));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test.each([
        ['no state yet', () => {}],
        ['state for another scenario', () => scenarioStateLedger.set(7, initialState('Other', 'buildup', 1))],
        ['a phase the scenario no longer has', () => scenarioStateLedger.set(7, initialState('Plan', 'gone', 1))],
        [
            'unreadable state',
            () => {
                store.keys.gs_scenario_state = '{broken';
            },
        ],
    ])('no overlay with %s', (label, arrange) => {
        assign();
        arrange();
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test('no overlay when the challenge has no scenario, or an unknown one', () => {
        settings.saveScenario(plan);
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
        settings.setChallengeOverride('scenario', '7', 'Missing');
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test('no overlay when the stored scenario no longer validates', () => {
        assign();
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1));
        const blob = JSON.parse(store.value);
        blob.challengeSettings.scenarios.Plan.version = 99;
        store.value = JSON.stringify(blob);
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
    });

    test('state name matching is case-insensitive', () => {
        assign();
        scenarioStateLedger.set(7, initialState('PLAN', 'buildup', 1));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
    });

    test('mock mode reads the in-memory ledger, never the persisted one', () => {
        assign();
        settings.setSetting('mock', true);
        scenarioStateLedger.set(7, initialState('Plan', 'buildup', 1));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(100);
        mockScenarioStateLedger.set(7, initialState('Plan', 'buildup', 1));
        expect(settings.getEffectiveSetting('exposure', '7')).toBe(10);
        mockScenarioStateLedger.remove(7);
    });
});
