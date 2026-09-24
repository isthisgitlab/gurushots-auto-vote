/**
 * src/js/react/api/ipc.js — the renderer's wrappers over the shell bridge:
 * pass-throughs keep the bridge's arguments, results and rejections; the
 * optional subscription tolerates a host without the event; the logRenderer*
 * helpers are best-effort and never throw.
 */
import * as ipc from '@/api/ipc';
import { mockApi } from './helpers/setup';

beforeEach(() => {
    window.api = mockApi;
    jest.clearAllMocks();
});

afterEach(() => {
    window.api = mockApi;
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
        window.api = { getSettings };
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

describe('onSettingsChanged', () => {
    test('subscribes and returns the unsubscribe handle', () => {
        const off = jest.fn();
        mockApi.onSettingsChanged.mockReturnValueOnce(off);
        const listener = jest.fn();
        expect(ipc.onSettingsChanged(listener)).toBe(off);
        expect(mockApi.onSettingsChanged).toHaveBeenCalledWith(listener);
    });

    test('returns undefined on a host without the event or without a bridge', () => {
        window.api = {};
        expect(ipc.onSettingsChanged(jest.fn())).toBeUndefined();
        window.api = undefined;
        expect(ipc.onSettingsChanged(jest.fn())).toBeUndefined();
    });
});

describe('refreshMenu', () => {
    test('forwards to the host menu, or returns undefined without one', async () => {
        await ipc.refreshMenu();
        expect(mockApi.refreshMenu).toHaveBeenCalledTimes(1);
        window.api = {};
        expect(ipc.refreshMenu()).toBeUndefined();
    });
});

describe.each([
    ['logRendererError', 'logError'],
    ['logRendererWarning', 'logWarning'],
    ['logRendererDebug', 'logDebug'],
])('%s', (helper, method) => {
    test(`hands the message to ${method} synchronously and resolves`, async () => {
        const pending = ipc[helper]('hello');
        expect(mockApi[method]).toHaveBeenCalledWith('hello');
        await expect(pending).resolves.toBeUndefined();
    });

    test('swallows a rejecting sink', async () => {
        mockApi[method].mockRejectedValueOnce(new Error('sink down'));
        await expect(ipc[helper]('x')).resolves.toBeUndefined();
    });

    test('swallows a sink that throws synchronously', async () => {
        window.api = {
            [method]: () => {
                throw new Error('sync throw');
            },
        };
        await expect(ipc[helper]('x')).resolves.toBeUndefined();
    });

    test('tolerates a missing method or a missing bridge', async () => {
        window.api = {};
        await expect(ipc[helper]('x')).resolves.toBeUndefined();
        window.api = undefined;
        await expect(ipc[helper]('x')).resolves.toBeUndefined();
    });
});
