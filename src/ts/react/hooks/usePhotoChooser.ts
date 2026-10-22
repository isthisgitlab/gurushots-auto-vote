/**
 * State behind the Chosen Photos chooser: saving the selection.
 */

import { useState } from 'react';

/**
 * Saving the selection: `save` hands it to `onSave`, runs `commit` (the chooser's pin writes) when that
 * succeeded, and closes on success; a refused or rejected save — or a failed commit — leaves the chooser
 * open on its error (`saveFailed`; the caller words a commit failure itself).
 */
export function useChooserSave(
    selected: string[],
    onSave: (ids: string[]) => boolean | Promise<boolean>,
    onClose: () => void,
    /** Extra writes after a successful `onSave`; a false answer keeps the chooser open. */
    commit?: () => Promise<boolean>,
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
            if (ok && commit) ok = await commit();
            setSaving(false);
            if (ok) onClose();
            else setSaveFailed(true);
        })();
    };
    return { save, saving, saveFailed };
}
