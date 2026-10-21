/**
 * The chooser's save: the selection goes to onSave, a success closes the modal,
 * and a refused or rejected save leaves it open on its error.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';

import { useChooserSave } from '../../src/ts/react/hooks/usePhotoChooser';

test('save hands the selection to onSave and closes on success', async () => {
    const onSave = jest.fn(async (ids: string[]) => {
        expect(ids).toEqual(['a', 'b']);
        return true;
    });
    const onClose = jest.fn();
    const { result } = renderHook(() => useChooserSave(['a', 'b'], onSave, onClose));

    act(() => result.current.save());

    expect(result.current.saving).toBe(true);
    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.saveFailed).toBe(false);
});

test('a refused save (false) leaves the modal open on its error', async () => {
    const onSave = jest.fn(async () => false);
    const onClose = jest.fn();
    const { result } = renderHook(() => useChooserSave(['a'], onSave, onClose));

    act(() => result.current.save());
    await waitFor(() => expect(result.current.saving).toBe(false));

    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.saveFailed).toBe(true);
});

test('a rejected save leaves the modal open on its error, like a refused one', async () => {
    const onSave = jest.fn(async () => {
        throw new Error('write failed');
    });
    const onClose = jest.fn();
    const { result } = renderHook(() => useChooserSave(['a'], onSave, onClose));

    act(() => result.current.save());
    await waitFor(() => expect(result.current.saving).toBe(false));

    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.saveFailed).toBe(true);
});

test('a failed save can be saved again, and the error clears while the retry runs', async () => {
    const onSave = jest
        .fn<Promise<boolean>, [string[]]>()
        .mockRejectedValueOnce(new Error('x'))
        .mockResolvedValue(true);
    const onClose = jest.fn();
    const { result } = renderHook(() => useChooserSave(['a'], onSave, onClose));

    act(() => result.current.save());
    await waitFor(() => expect(result.current.saveFailed).toBe(true));

    act(() => result.current.save());
    expect(result.current.saveFailed).toBe(false);
    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(onClose).toHaveBeenCalledTimes(1);
});
