/**
 * useTitleRules — the rule editor's dirty tracking against the saved rules.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useTitleRules } from '@/hooks/useTitleRules';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

describe('isDirty', () => {
    const loaded = async (rules: unknown[] = [{ title: 'A', mustIncludeTags: ['x'] }]) => {
        mockApi.getTitleRules.mockResolvedValue(invalid(rules));
        const hook = renderHook(() => useTitleRules(true));
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        return hook;
    };

    test('is false while loading and when the load failed', async () => {
        mockApi.getTitleRules.mockReturnValue(new Promise(() => {}));
        const pending = renderHook(() => useTitleRules(true));
        expect(pending.result.current.isDirty()).toBe(false);
        pending.unmount();

        mockApi.getTitleRules.mockRejectedValue(new Error('disk'));
        const failed = renderHook(() => useTitleRules(true));
        await waitFor(() => expect(failed.result.current.loadFailed).toBe(true));
        act(() => failed.result.current.change([{ title: 'typed anyway' }]));
        expect(failed.result.current.isDirty()).toBe(false);
    });

    test('an edit is dirty and putting it back is not', async () => {
        const { result } = await loaded();
        expect(result.current.isDirty()).toBe(false);

        act(() => result.current.change([{ title: 'A', mustIncludeTags: ['x', 'y'] }]));
        expect(result.current.isDirty()).toBe(true);
        act(() => result.current.change([{ title: 'A', mustIncludeTags: ['x'] }]));
        expect(result.current.isDirty()).toBe(false);
    });

    test('the same rule with its keys in another order is not an edit', async () => {
        const { result } = await loaded();
        act(() => result.current.change([{ mustIncludeTags: ['x'], title: 'A' }]));
        expect(result.current.isDirty()).toBe(false);
        act(() => result.current.change([{ mustIncludeTags: ['y', 'x'], title: 'A' }]));
        expect(result.current.isDirty()).toBe(true);
    });

    test('a persist that landed moves the baseline; a rejected one does not', async () => {
        const { result } = await loaded();
        act(() => result.current.change([{ title: 'B' }]));

        mockApi.setTitleRules.mockResolvedValueOnce(false);
        await act(async () => {
            await result.current.persist();
        });
        expect(result.current.isDirty()).toBe(true);

        mockApi.setTitleRules.mockResolvedValueOnce(true);
        await act(async () => {
            await result.current.persist();
        });
        expect(result.current.isDirty()).toBe(false);
    });
});
