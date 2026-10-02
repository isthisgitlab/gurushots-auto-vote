/**
 * src/ts/react/api/ipc.ts — the renderer's wrappers over the shell bridge:
 * pass-throughs keep the bridge's arguments, results and rejections; the
 * optional subscription tolerates a host without the event; the logRenderer*
 * helpers are best-effort and never throw.
 */
import * as ipc from '@/api/ipc';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

/** The wrappers looked up by name, for the table-driven cases. */
type IpcByName = Record<string, (...args: unknown[]) => unknown>;
/** The bridge mocks looked up by name, for the same table-driven cases. */
const mockByName = invalid<Record<string, jest.Mock<Promise<unknown>, unknown[]>>>(mockApi);

beforeEach(() => {
    window.api = invalid(mockApi);
    jest.clearAllMocks();
});

afterEach(() => {
    window.api = invalid(mockApi);
});

describe('pass-through wrappers', () => {
    test('forward every argument and return the bridge result unchanged', async () => {
        mockApi.replaceChallengeOverrides.mockResolvedValueOnce(false);
        await expect(ipc.replaceChallengeOverrides('7', { a: 1 }, ['b'])).resolves.toBe(false);
        expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('7', { a: 1 }, ['b']);
    });

    test('propagate a rejection to the caller', async () => {
        mockApi.setTitleRules.mockRejectedValueOnce(new Error('ipc down'));
        await expect(ipc.setTitleRules([])).rejects.toThrow('ipc down');
    });

    test('resolve the bridge at call time, not import time', async () => {
        const getSettings = jest.fn().mockResolvedValue({ token: 'late' });
        window.api = invalid({ getSettings });
        await expect(ipc.getSettings()).resolves.toEqual({ token: 'late' });
        expect(getSettings).toHaveBeenCalledTimes(1);
    });

    test('return a subscription unsubscribe handle as-is', () => {
        const off = jest.fn();
        mockApi.onLogMessage.mockReturnValueOnce(off);
        const listener = jest.fn();
        expect(ipc.onLogMessage(listener)).toBe(off);
        expect(mockApi.onLogMessage).toHaveBeenCalledWith(listener);
    });
});

describe('scenario wrappers', () => {
    test.each([
        ['getScenarios', []],
        ['checkScenario', [{ name: 'Draft' }]],
        ['saveScenario', [{ name: 'Plan' }, { overwrite: false }]],
        ['renameScenario', ['Old', 'New']],
        ['deleteScenario', ['Plan']],
        ['previewScenarioImport', ['{}']],
        ['importScenario', ['{}', { overwrite: true }]],
        ['exportScenario', ['Plan']],
        ['getScenarioStatus', ['7']],
        ['resetScenarioState', ['7']],
        ['dryRunScenario', ['7']],
        ['simulateScenario', ['7', { name: 'Draft' }]],
    ])('%s forwards its arguments', async (method, args) => {
        mockByName[method].mockResolvedValueOnce({ success: true });
        await expect(invalid<IpcByName>(ipc)[method](...args)).resolves.toEqual({ success: true });
        expect(mockByName[method]).toHaveBeenCalledWith(...args);
    });
});

describe('onSettingsChanged', () => {
    test('subscribes and returns the unsubscribe handle', () => {
        const off = jest.fn();
        mockApi.onSettingsChanged.mockReturnValueOnce(off);
        const listener = jest.fn();
        expect(ipc.onSettingsChanged(listener)).toBe(off);
        expect(mockApi.onSettingsChanged).toHaveBeenCalledWith(listener);
    });

    test('returns undefined on a host without the event or without a bridge', () => {
        window.api = invalid({});
        expect(ipc.onSettingsChanged(jest.fn())).toBeUndefined();
        window.api = invalid(undefined);
        expect(ipc.onSettingsChanged(jest.fn())).toBeUndefined();
    });
});

describe('callOrNull', () => {
    test('resolves with the call result', async () => {
        await expect(ipc.callOrNull(() => Promise.resolve({ success: true }))).resolves.toEqual({ success: true });
    });

    test('turns a rejection or a missing bridge into null', async () => {
        await expect(ipc.callOrNull(() => Promise.reject(new Error('ipc down')))).resolves.toBeNull();
        window.api = invalid(undefined);
        await expect(ipc.callOrNull(() => ipc.getSettings())).resolves.toBeNull();
    });
});

describe('refreshMenu', () => {
    test('forwards to the host menu, or returns undefined without one', async () => {
        await ipc.refreshMenu();
        expect(mockApi.refreshMenu).toHaveBeenCalledTimes(1);
        window.api = invalid({});
        expect(ipc.refreshMenu()).toBeUndefined();
    });
});

describe.each([
    ['logRendererError', 'logError'],
    ['logRendererWarning', 'logWarning'],
    ['logRendererDebug', 'logDebug'],
])('%s', (helper, method) => {
    test(`hands the message to ${method} synchronously and resolves`, async () => {
        const pending = invalid<IpcByName>(ipc)[helper]('hello');
        expect(mockByName[method]).toHaveBeenCalledWith('hello');
        await expect(pending).resolves.toBeUndefined();
    });

    test('swallows a rejecting sink', async () => {
        mockByName[method].mockRejectedValueOnce(new Error('sink down'));
        await expect(invalid<IpcByName>(ipc)[helper]('x')).resolves.toBeUndefined();
    });

    test('swallows a sink that throws synchronously', async () => {
        window.api = invalid({
            [method]: () => {
                throw new Error('sync throw');
            },
        });
        await expect(invalid<IpcByName>(ipc)[helper]('x')).resolves.toBeUndefined();
    });

    test('tolerates a missing method or a missing bridge', async () => {
        window.api = invalid({});
        await expect(invalid<IpcByName>(ipc)[helper]('x')).resolves.toBeUndefined();
        window.api = invalid(undefined);
        await expect(invalid<IpcByName>(ipc)[helper]('x')).resolves.toBeUndefined();
    });
});
