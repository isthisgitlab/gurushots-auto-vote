/**
 * The control inbox over a store that fails the way a webview store can: a read that throws, a write that rejects. The
 * inbox answers unreadable / not saved and nothing else; its hydration and flush are the store's own.
 */

type StoreMock = {
    readRaw: jest.Mock<string | null, []>;
    updateThrough: jest.Mock<Promise<'saved' | 'aborted' | 'failed'>, [unknown]>;
    initializeAsync: jest.Mock<Promise<void>, []>;
    flushPendingWrites: jest.Mock<Promise<void>, []>;
};

jest.mock('../../src/ts/core/settings/storage', () => {
    const store = {
        readRaw: jest.fn(() => null),
        updateThrough: jest.fn(),
        initializeAsync: jest.fn(async () => undefined),
        flushPendingWrites: jest.fn(async () => undefined),
    };
    return { __esModule: true, createJsonStore: () => store, mockStore: store };
});
jest.mock('../../src/ts/core/platform/port', () => ({
    __esModule: true,
    platform: () => ({ storage: { loaded: () => true } }),
}));

const { mockStore } = jest.requireMock<{ mockStore: StoreMock }>('../../src/ts/core/settings/storage');

import {
    beginControlRequest,
    finishControlRequest,
    flushScenarioControlsWrites,
    initializeScenarioControlsAsync,
    readControlStatus,
} from '../../src/ts/core/settings/scenarioControls';

const request = { requestId: 'r1', operation: 'pause-scenario', target: '7', args: '[]', stopEpoch: 0, at: 1 };

beforeEach(() => {
    mockStore.readRaw.mockReset();
    mockStore.readRaw.mockReturnValue(null);
    mockStore.updateThrough.mockReset();
});

describe('the control inbox over a failing store', () => {
    test('a read that throws is unknown to a status read', () => {
        mockStore.readRaw.mockImplementation(() => {
            throw new Error('preferences unavailable');
        });
        expect(readControlStatus({ requestId: 'r1' }, 0)).toEqual({ state: 'unknown' });
    });

    test('a write that rejects is not saved, for a request and for its result', async () => {
        mockStore.updateThrough.mockRejectedValue(new Error('preferences refused the write'));
        await expect(beginControlRequest(request)).resolves.toEqual({ ok: false, reason: 'not-saved' });
        await expect(
            finishControlRequest({ requestId: 'r1', target: '7', ok: true, error: null, at: 1 }),
        ).resolves.toEqual({
            ok: false,
            reason: 'not-saved',
        });
    });

    test("hydration and flush are the store's", async () => {
        await initializeScenarioControlsAsync();
        await flushScenarioControlsWrites();
        expect(mockStore.initializeAsync).toHaveBeenCalledTimes(1);
        expect(mockStore.flushPendingWrites).toHaveBeenCalledTimes(1);
    });
});
