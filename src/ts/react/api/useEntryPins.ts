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

/**
 * The photos pinned for a challenge's Boost and Turbo, and the writes that pin
 * or clear them. Reads again when `settingsVersion` changes (a pin write
 * broadcasts settings-changed), so every card shows what the settings hold.
 *
 * Called once per card: its detailed and compact layouts both read the result.
 *
 * @param settingsVersion - bumped when settings change
 * @returns `setPin` pins an entry (null clears) and `togglePin` clears the
 *   pin when the entry already holds it; `loading` is true from the write
 *   until the pins are read back; `error` is a failed write's code
 *   (word it with ipcErrorText)
 */
export function useEntryPins(challengeId: Challenge['id'], settingsVersion: number = 0) {
    // A new settingsVersion is a new queryFn, which is what makes useIpcQuery fetch again.
    const queryFn = useCallback(() => {
        void settingsVersion;
        return ipc.getEntryPins(challengeId);
    }, [challengeId, settingsVersion]);
    const { data: pins, refetch } = useIpcQuery(queryFn, { initialData: NO_PINS, apply: applyPins, latestOnly: true });
    const { run, error, clearError } = useAsyncIpcAction(ipc.setEntryPin);
    // Busy from the write until the pins are read back: the write's own loading flag ends when it returns, and
    // until the read lands `pins` still shows the old state, which a second tap would act on.
    const [busy, setBusy] = useState(false);

    const setPin = useCallback(
        async (kind: EntryPinKind, imageId: string | null) => {
            setBusy(true);
            try {
                const result = await run(kind, challengeId, imageId);
                if (result.success) await refetch();
            } finally {
                setBusy(false);
            }
        },
        [run, challengeId, refetch],
    );
    const togglePin = useCallback(
        (kind: EntryPinKind, imageId: string) => setPin(kind, pins[kind] === imageId ? null : imageId),
        [setPin, pins],
    );

    return { pins, setPin, togglePin, loading: busy, error, clearError };
}
