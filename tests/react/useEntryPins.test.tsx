/**
 * useEntryPins: the photos pinned for a challenge's Boost and Turbo, read over IPC and re-read when the
 * settings version changes, and the writes that pin or clear them.
 */

import { renderHook, waitFor, act } from './helpers/test-utils';
import { useEntryPins } from '@/api/useEntryPins';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

beforeEach(() => {
    window.api = invalid(mockApi);
    jest.clearAllMocks();
    mockApi.getEntryPins.mockResolvedValue({ boost: null, turbo: null });
    mockApi.setEntryPin.mockResolvedValue({ success: true });
});

describe('useEntryPins', () => {
    test('reads the challenge’s pins on mount', async () => {
        mockApi.getEntryPins.mockResolvedValue({ boost: 'imgA', turbo: null });
        const { result } = renderHook(() => useEntryPins(7, 0));
        expect(result.current.pins).toEqual({ boost: null, turbo: null });
        await waitFor(() => expect(result.current.pins).toEqual({ boost: 'imgA', turbo: null }));
        expect(mockApi.getEntryPins).toHaveBeenCalledWith(7);
    });

    test('reads again when the settings version changes, and not otherwise', async () => {
        const { result, rerender } = renderHook(({ version }) => useEntryPins(7, version), {
            initialProps: { version: 0 },
        });
        await waitFor(() => expect(mockApi.getEntryPins).toHaveBeenCalledTimes(1));
        rerender({ version: 0 });
        expect(mockApi.getEntryPins).toHaveBeenCalledTimes(1);

        mockApi.getEntryPins.mockResolvedValue({ boost: null, turbo: 'imgB' });
        rerender({ version: 1 });
        await waitFor(() => expect(result.current.pins).toEqual({ boost: null, turbo: 'imgB' }));
        expect(mockApi.getEntryPins).toHaveBeenCalledTimes(2);
    });

    test('a failed read, or no answer, is no pins', async () => {
        mockApi.getEntryPins.mockResolvedValue(null);
        const { result } = renderHook(() => useEntryPins(7));
        await waitFor(() => expect(mockApi.getEntryPins).toHaveBeenCalled());
        expect(result.current.pins).toEqual({ boost: null, turbo: null });

        mockApi.getEntryPins.mockRejectedValue(new Error('ipc'));
        const rejected = renderHook(() => useEntryPins(8));
        await waitFor(() => expect(mockApi.getEntryPins).toHaveBeenCalledWith(8));
        expect(rejected.result.current.pins).toEqual({ boost: null, turbo: null });
    });

    test('setPin writes through the handler and reads the pins back', async () => {
        const { result } = renderHook(() => useEntryPins(7));
        await waitFor(() => expect(mockApi.getEntryPins).toHaveBeenCalledTimes(1));
        mockApi.getEntryPins.mockResolvedValue({ boost: 'imgA', turbo: null });
        await act(async () => {
            await result.current.setPin('boost', 'imgA');
        });
        expect(mockApi.setEntryPin).toHaveBeenCalledWith('boost', 7, 'imgA');
        await waitFor(() => expect(result.current.pins.boost).toBe('imgA'));
        expect(result.current.error).toBeNull();
    });

    test('togglePin pins an entry, and clears the pin when it already holds it', async () => {
        mockApi.getEntryPins.mockResolvedValue({ boost: 'imgA', turbo: null });
        const { result } = renderHook(() => useEntryPins(7));
        await waitFor(() => expect(result.current.pins.boost).toBe('imgA'));

        await act(async () => {
            await result.current.togglePin('boost', 'imgB');
        });
        expect(mockApi.setEntryPin).toHaveBeenLastCalledWith('boost', 7, 'imgB');

        await act(async () => {
            await result.current.togglePin('boost', 'imgA');
        });
        expect(mockApi.setEntryPin).toHaveBeenLastCalledWith('boost', 7, null);
    });

    test('loading stays true from the write until the pins are read back', async () => {
        const { result } = renderHook(() => useEntryPins(7));
        await waitFor(() => expect(mockApi.getEntryPins).toHaveBeenCalledTimes(1));
        expect(result.current.loading).toBe(false);

        let release: (pins: { boost: string | null; turbo: string | null }) => void = () => {};
        mockApi.getEntryPins.mockImplementation(() => new Promise((resolve) => (release = resolve)));
        let pending!: Promise<void>;
        act(() => {
            pending = result.current.setPin('boost', 'imgA');
        });
        // The save has returned; the read-back is held open.
        await waitFor(() => expect(mockApi.getEntryPins).toHaveBeenCalledTimes(2));
        expect(mockApi.setEntryPin).toHaveBeenCalledTimes(1);
        expect(result.current.loading).toBe(true);

        await act(async () => {
            release({ boost: 'imgA', turbo: null });
            await pending;
        });
        expect(result.current.loading).toBe(false);
        expect(result.current.pins.boost).toBe('imgA');
    });

    test('loading ends after a failed write too', async () => {
        mockApi.setEntryPin.mockResolvedValue({ success: false, error: 'pin-write-failed' });
        const { result } = renderHook(() => useEntryPins(7));
        await waitFor(() => expect(mockApi.getEntryPins).toHaveBeenCalledTimes(1));
        await act(async () => {
            await result.current.setPin('boost', 'imgA');
        });
        expect(result.current.loading).toBe(false);
    });

    test('a failed write keeps its error, does not read again, and clears on request', async () => {
        mockApi.setEntryPin.mockResolvedValue({ success: false, error: 'The pin could not be saved' });
        const { result } = renderHook(() => useEntryPins(7));
        await waitFor(() => expect(mockApi.getEntryPins).toHaveBeenCalledTimes(1));
        await act(async () => {
            await result.current.setPin('turbo', 'imgA');
        });
        expect(result.current.error).toBe('The pin could not be saved');
        expect(mockApi.getEntryPins).toHaveBeenCalledTimes(1);

        act(() => result.current.clearError());
        expect(result.current.error).toBeNull();
    });
});
