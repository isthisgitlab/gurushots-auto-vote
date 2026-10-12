/**
 * In the Android app WebView the native background service advances
 * scenarios in its own JS context, so the in-app pass re-reads the shared
 * scenario state first — its phase-settings overlay must be current.
 */

import type * as votingOrchestratorModule from '../../src/ts/services/votingOrchestrator';
import type * as scenarioRunnerModule from '../../src/ts/services/scenarioRunner';
import type * as scenarioStateStoreModule from '../../src/ts/scenarioStateStore';
import type * as realModule from '../../src/ts/strategies/real';

jest.mock('../../src/ts/services/votingOrchestrator', () => ({
    runVotingPass: jest.fn(async () => ({ success: true })),
}));
jest.mock('../../src/ts/services/scenarioRunner', () => ({ backgroundServiceOwnsScenarios: jest.fn() }));
jest.mock('../../src/ts/scenarioStateStore', () => ({
    scenarioStateLedger: {},
    scenarioStateLoaded: jest.fn(() => true),
    refreshScenarioStateAsync: jest.fn(async () => {}),
}));
jest.mock('../../src/ts/services/joinChallenges', () => ({ runJoinPass: jest.fn(), joinChallengeSingle: jest.fn() }));
jest.mock('../../src/ts/services/autoClaim', () => ({ runClaimPass: jest.fn() }));
jest.mock('../../src/ts/settings', () => {
    const actual = jest.requireActual<typeof import('../../src/ts/settings')>('../../src/ts/settings');
    return { __esModule: true, ...actual };
});

const { runVotingPass } = jest.mocked(
    require('../../src/ts/services/votingOrchestrator') as typeof votingOrchestratorModule,
);
const { backgroundServiceOwnsScenarios } = jest.mocked(
    require('../../src/ts/services/scenarioRunner') as typeof scenarioRunnerModule,
);
const { refreshScenarioStateAsync, scenarioStateLoaded } = jest.mocked(
    require('../../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule,
);
import joinChallengesModule = require('../../src/ts/services/joinChallenges');
import autoClaimModule = require('../../src/ts/services/autoClaim');
const { runJoinPass } = jest.mocked(joinChallengesModule);
const { runClaimPass } = jest.mocked(autoClaimModule);
import settings = require('../../src/ts/settings');
import logger = require('../../src/ts/logger');
import { invalid } from '../helpers/invalid';
const { fetchChallengesAndVote } = require('../../src/ts/strategies/real') as typeof realModule;

beforeEach(() => jest.clearAllMocks());

test('re-reads the scenario state before the pass when the background service owns scenarios', async () => {
    backgroundServiceOwnsScenarios.mockReturnValue(true);
    await fetchChallengesAndVote('tok', '7');
    expect(refreshScenarioStateAsync).toHaveBeenCalledTimes(1);
    expect(refreshScenarioStateAsync.mock.invocationCallOrder[0]).toBeLessThan(
        runVotingPass.mock.invocationCallOrder[0],
    );
    expect(runVotingPass.mock.calls[0][2].scenarios!.enabled!()).toBe(false);
});

test('elsewhere the pass starts straight away and owns scenarios', async () => {
    backgroundServiceOwnsScenarios.mockReturnValue(false);
    await fetchChallengesAndVote('tok', '7');
    expect(refreshScenarioStateAsync).not.toHaveBeenCalled();
    expect(runVotingPass.mock.calls[0][2].scenarios!.enabled!()).toBe(true);
});

test('with the background service the window leaves the fills, the exposure rule’s and a mission’s, to it: one loop counts them', async () => {
    backgroundServiceOwnsScenarios.mockReturnValue(true);
    await fetchChallengesAndVote('tok', '7');
    expect(runVotingPass.mock.calls[0][2].currency?.fillsLeftToService).toBe(true);
    backgroundServiceOwnsScenarios.mockReturnValue(false);
    await fetchChallengesAndVote('tok', '7');
    expect(runVotingPass.mock.calls[1][2].currency).toEqual(
        expect.objectContaining({ fillsLeftToService: false, spendLedger: expect.anything() }),
    );
});

test('a cache of the scenario state that was never filled is read again before the pass, whoever owns scenarios', async () => {
    backgroundServiceOwnsScenarios.mockReturnValue(false);
    scenarioStateLoaded.mockReturnValueOnce(false);
    await fetchChallengesAndVote('tok', '7');
    expect(refreshScenarioStateAsync).toHaveBeenCalledTimes(1);
    expect(refreshScenarioStateAsync.mock.invocationCallOrder[0]).toBeLessThan(
        runVotingPass.mock.invocationCallOrder[0],
    );
    expect(runVotingPass.mock.calls[0][2].scenarios!.enabled!()).toBe(true);
});

test('with the background service the window leaves the automatic joins to it, and still claims prizes', async () => {
    backgroundServiceOwnsScenarios.mockReturnValue(true);
    await fetchChallengesAndVote('tok', null);
    expect(runJoinPass).not.toHaveBeenCalled();
    expect(runClaimPass).toHaveBeenCalledTimes(1);
});

test('without it the pass joins as before, over claims it reads again before it spends on them', async () => {
    backgroundServiceOwnsScenarios.mockReturnValue(false);
    await fetchChallengesAndVote('tok', null);
    expect(runJoinPass).toHaveBeenCalledTimes(1);
    expect(runJoinPass.mock.calls[0][2]).toEqual(expect.objectContaining({ refreshJoinState: expect.any(Function) }));
    expect(runClaimPass).toHaveBeenCalledTimes(1);
});

describe('saying why the window did not join or fill', () => {
    const said =
        'auto-join and automatic fills are left to the background service on Android; they run while auto-vote is on';
    const setOn = (keys: string[]) =>
        jest
            .spyOn(settings, 'getSetting')
            .mockImplementation(((key: string) => keys.includes(key)) as typeof settings.getSetting);
    // A process of its own: it is said once for each.
    const freshProcess = () => {
        let fresh!: typeof fetchChallengesAndVote;
        jest.isolateModules(() => {
            fresh = (require('../../src/ts/strategies/real') as typeof realModule).fetchChallengesAndVote;
        });
        return fresh;
    };
    const logged = () => {
        const info = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValue(invalid({ info, warning: jest.fn(), error: jest.fn() }));
        return () => info.mock.calls.filter(([text]) => text === said).length;
    };
    afterEach(() => jest.restoreAllMocks());

    test.each(['autoJoin', 'autoExposureFill', 'missionUseFills'])('says so when %s is on', async (key) => {
        backgroundServiceOwnsScenarios.mockReturnValue(true);
        setOn([key]);
        const count = logged();
        await freshProcess()('tok', null);
        expect(count()).toBe(1);
    });

    test('says so once for a process, not on every run, whether or not auto-vote is on', async () => {
        backgroundServiceOwnsScenarios.mockReturnValue(true);
        setOn(['autoJoin']);
        const count = logged();
        const run = freshProcess();
        await run('tok', null);
        await run('tok', '7');
        await run('tok', null);
        expect(count()).toBe(1);
    });

    test('is silent when none of them is on, and where the window does the joining and filling itself', async () => {
        const count = logged();
        backgroundServiceOwnsScenarios.mockReturnValue(true);
        setOn([]);
        await freshProcess()('tok', null);
        backgroundServiceOwnsScenarios.mockReturnValue(false);
        setOn(['autoJoin', 'autoExposureFill', 'missionUseFills']);
        await freshProcess()('tok', null);
        expect(count()).toBe(0);
    });
});
