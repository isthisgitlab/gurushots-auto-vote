/**
 * "Once a Snap, always a Snap": from the active-challenge read to the game that is played. A challenge recorded as Snap
 * that GuruShots now reports as a classic FREE turbo must go through the Snap runner (which stops when GuruShots no
 * longer offers Snap) and never through the classic game. The real read, decision, pass step and strategy binder run;
 * only the transport, the Snap runner and the record's store are replaced.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn(() => ({})),
}));
jest.mock('../../src/ts/api/turbo', () => ({
    getChallengeTurbo: jest.fn(),
    submitTurboSelection: jest.fn(),
    applyTurbo: jest.fn(),
    TURBO_SELECTION_DELAY_MS: 0,
}));
jest.mock('../../src/ts/strategies/real/snapGame', () => ({ runSnapGame: jest.fn() }));
jest.mock('../../src/ts/services/challengeTitlePin', () => ({ pinChallengeTitles: jest.fn() }));
jest.mock('../../src/ts/snapChallengeStore', () => ({
    snapLedger: { read: jest.fn(), record: jest.fn() },
}));
// Keeps the storage layer (and its electron require) out of this test.
jest.mock('../../src/ts/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/x.json',
        initializeAsync: async () => {},
    }),
}));

import type * as apiClientModule from '../../src/ts/api/api-client';
import type * as turboApiModule from '../../src/ts/api/turbo';
import type * as snapGameModule from '../../src/ts/strategies/real/snapGame';
import type * as snapChallengeStoreModule from '../../src/ts/snapChallengeStore';
import type * as realModule from '../../src/ts/strategies/real';
import type * as mockModule from '../../src/ts/mock';
import type * as turboPassModule from '../../src/ts/services/votingOrchestrator/turbo';
import type * as turboRunLockModule from '../../src/ts/services/turboRunLock';
import type * as settingsModule from '../../src/ts/settings';
import type { PassContext } from '../../src/ts/services/votingOrchestrator/context';
import { invalid } from '../helpers/invalid';

const { makePostRequest } = jest.mocked(require('../../src/ts/api/api-client') as typeof apiClientModule);
const { getChallengeTurbo } = jest.mocked(require('../../src/ts/api/turbo') as typeof turboApiModule);
const { runSnapGame } = jest.mocked(require('../../src/ts/strategies/real/snapGame') as typeof snapGameModule);
const { snapLedger } = jest.mocked(require('../../src/ts/snapChallengeStore') as typeof snapChallengeStoreModule);
const strategy = require('../../src/ts/strategies/real') as typeof realModule;
const { playAutoTurbo } = require('../../src/ts/services/votingOrchestrator/turbo') as typeof turboPassModule;
const { __resetSnapUnavailableForTests, markSnapUnavailable } =
    require('../../src/ts/services/turboRunLock') as typeof turboRunLockModule;
const settings = jest.mocked(require('../../src/ts/settings') as typeof settingsModule);

const NOW = Math.floor(Date.now() / 1000);

/** One challenge, read as the app reads it: the mobile list has no turbo mode, the web read carries the game. */
const read = async (id: number, webTurbo: { state: string; mode: string }) => {
    makePostRequest.mockResolvedValueOnce({
        challenges: [{ id, title: 'T', close_time: NOW + 7200, member: { turbo: { state: 'WON' } } }],
    });
    makePostRequest.mockResolvedValueOnce({ challenges: [{ id, member: { turbo: webTurbo } }] });
    const { challenges } = await strategy.getActiveChallenges('tok');
    return challenges[0];
};

const play = (challenge: Awaited<ReturnType<typeof read>>) =>
    playAutoTurbo(
        challenge,
        NOW,
        invalid<PassContext>({
            api: { runTurboGame: strategy.runTurboGame },
            token: 'tok',
            missions: null,
            refreshMissionNeeds: null,
            turboSnapshot: 0,
            snapGames: { played: 0 },
        }),
    );

beforeEach(() => {
    jest.clearAllMocks();
    __resetSnapUnavailableForTests();
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => key === 'autoTurbo'));
    snapLedger.read.mockResolvedValue(new Set(['43']));
    snapLedger.record.mockResolvedValue(undefined);
    getChallengeTurbo.mockResolvedValue({ battles: [] });
    runSnapGame.mockResolvedValue({ answered: 0, total: 0, meanAgreement: 0, won: false, stopReason: 'withdrawn' });
});

describe('a challenge recorded as Snap', () => {
    test('reported as a classic FREE turbo it is played by the Snap runner, never as the classic game', async () => {
        const challenge = await read(43, { state: 'FREE', mode: 'classic' });
        expect(challenge.member?.turbo?.mode).toBe('snap');

        await play(challenge);

        expect(runSnapGame).toHaveBeenCalledTimes(1);
        expect(runSnapGame.mock.calls[0][0]).toBe(challenge);
        expect(getChallengeTurbo).not.toHaveBeenCalled();
    });

    test('once the Snap runner finds Snap withdrawn, nothing is played on it again', async () => {
        const challenge = await read(43, { state: 'FREE', mode: 'classic' });
        // What the real runner does when GuruShots answers the Snap session with the classic game.
        runSnapGame.mockImplementationOnce(async (played) => {
            markSnapUnavailable(played.id);
            return { answered: 0, total: 0, meanAgreement: 0, won: false, stopReason: 'withdrawn' };
        });
        await play(challenge);
        await play(await read(43, { state: 'FREE', mode: 'classic' }));

        expect(runSnapGame).toHaveBeenCalledTimes(1);
        expect(getChallengeTurbo).not.toHaveBeenCalled();
    });

    test('a Snap the web read still reports as Snap is recorded and played as before', async () => {
        snapLedger.read.mockResolvedValue(new Set());

        await play(await read(43, { state: 'FREE', mode: 'snap' }));

        expect(snapLedger.record).toHaveBeenCalledWith(['43'], ['43']);
        expect(runSnapGame).toHaveBeenCalledTimes(1);
        expect(getChallengeTurbo).not.toHaveBeenCalled();
    });
});

test('a challenge never seen as Snap is still earned as classic', async () => {
    await play(await read(44, { state: 'FREE', mode: 'classic' }));

    expect(getChallengeTurbo).toHaveBeenCalledWith(44, 'tok');
    expect(runSnapGame).not.toHaveBeenCalled();
});

test('mock mode never reads or writes the record', async () => {
    const { mockApiClient } = require('../../src/ts/mock') as typeof mockModule;

    await mockApiClient.getActiveChallenges('tok');
    await mockApiClient.fetchChallengesAndVote('tok');

    expect(snapLedger.read).not.toHaveBeenCalled();
    expect(snapLedger.record).not.toHaveBeenCalled();
});
