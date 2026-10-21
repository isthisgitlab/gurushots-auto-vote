/**
 * State behind the Chosen Photos chooser: saving the selection.
 */

import { useState } from 'react';

/**
 * Saving the selection: `save` hands it to `onSave` and closes on success; a refused or rejected
 * save leaves the chooser open on its error (`saveFailed`).
 */
export function useChooserSave(
    selected: string[],
    onSave: (ids: string[]) => boolean | Promise<boolean>,
    onClose: () => void,
) {
    const [saving, setSaving] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);
    const save = () => {
        void (async () => {
            setSaving(true);
            setSaveFailed(false);
            let ok = false;
            try {
                ok = (await onSave(selected)) !== false;
            } catch {
                // A rejected save leaves the modal open on its error, like a refused one.
            }
            setSaving(false);
            if (ok) onClose();
            else setSaveFailed(true);
        })();
    };
    return { save, saving, saveFailed };
}
