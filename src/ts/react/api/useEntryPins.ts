import { useCallback, useState } from 'react';
import { useIpcQuery } from './useIpcQuery';
import { useAsyncIpcAction } from './useAsyncIpcAction';
import * as ipc from './ipc';

import type { Challenge } from '../../types/gurushots';
import type { EntryPinKind, EntryPins } from '../../types/settings';
import type { IpcQueryApply } from './useIpcQuery';

const NO_PINS: EntryPins = { boost: null, turbo: null };

// A failed read is no pins, like a failed swap-back read is no offers.
const applyPins: IpcQueryApply<EntryPins | null, EntryPins, Error, []> = (result, { setData }) =>
    setData(result ?? NO_PINS);

// A failed read is reported instead of becoming no pins: the chooser hides its pin controls when the pins
// cannot be read, so it never edits against a "no pins" guess.
const applyPinsOrReadError: IpcQueryApply<EntryPins | null, EntryPins, Error, []> = (result, { setData, setError }) => {
    if (result) {
        setData(result);
        return;
    }
    setData(NO_PINS);
    setError(new Error('entry-pins-read-failed'));
};

/**
 * What a caller asks of the read beyond the card's defaults.
 *
 * @property readFailureIsError - surface a failed read through `readError` instead of no pins
 * @property enabled - read at all; false keeps the read off (the chooser reads only when it was opened for a challenge)
 */
export type EntryPinsOptions = { readFailureIsError?: boolean; enabled?: boolean };

/**
 * The photos pinned for a challenge's Boost and Turbo, and the writes that pin
 * or clear them. Reads again when `settingsVersion` changes (a pin write
 * broadcasts settings-changed), so every card shows what the settings hold.
 *
 * Called once per card: its detailed and compact layouts both read the result.
 *
 * @param settingsVersion - bumped when settings change
 * @param options - see EntryPinsOptions
 * @returns `setPin` pins an entry (null clears) and `togglePin` clears the
 *   pin when the entry already holds it; `loading` is true from the write
 *   until the pins are read back; `error` is a failed write's code
 *   (word it with ipcErrorText); `readPending` is true while the read has
 *   not settled and `readError` the failure a `readFailureIsError` read
 *   reports
 */
export function useEntryPins(
    challengeId: Challenge['id'],
    settingsVersion: number = 0,
    options: EntryPinsOptions = {},
) {
    const { readFailureIsError = false, enabled = true } = options;
    // A new settingsVersion is a new queryFn, which is what makes useIpcQuery fetch again.
    const queryFn = useCallback(() => {
        void settingsVersion;
        return ipc.getEntryPins(challengeId);
    }, [challengeId, settingsVersion]);
    const {
        data: pins,
        refetch,
        loading: readPending,
        error: readError,
    } = useIpcQuery(queryFn, {
        initialData: NO_PINS,
        apply: readFailureIsError ? applyPinsOrReadError : applyPins,
        latestOnly: true,
        enabled,
    });
    const { run, error, clearError } = useAsyncIpcAction(ipc.setEntryPin);
    // Busy from the write until the pins are read back: the write's own loading flag ends when it returns, and
    // until the read lands `pins` still shows the old state, which a second tap would act on. Writes are
    // counted, so the first of two overlapping writes ending does not end the busy state of the second.
    const [writesInFlight, setWritesInFlight] = useState(0);

    const setPin = useCallback(
        async (kind: EntryPinKind, imageId: string | null) => {
            setWritesInFlight((count) => count + 1);
            try {
                const result = await run(kind, challengeId, imageId);
                if (result.success) await refetch();
            } finally {
                setWritesInFlight((count) => count - 1);
            }
        },
        [run, challengeId, refetch],
    );
    const togglePin = useCallback(
        (kind: EntryPinKind, imageId: string) => setPin(kind, pins[kind] === imageId ? null : imageId),
        [setPin, pins],
    );

    return { pins, setPin, togglePin, loading: writesInFlight > 0, error, clearError, readPending, readError };
}
