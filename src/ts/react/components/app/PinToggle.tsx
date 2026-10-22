import { useTranslation } from '@/contexts/TranslationContext';
import { ActionButton } from '@/components/ui/ActionButton';

import type { EntryPinKind } from '../../../types/settings';

// A pressed pin is solid in its feature's colour. An unpressed one is a plain `btn-outline`, which daisyUI draws in
// `base-content` (border and label) in every theme; the label names the feature, so no colour cue is needed.
const PIN_PRESSED_VARIANTS = { boost: 'success', turbo: 'warning' } as const;

/**
 * One "Pin for Boost / Turbo" toggle: `aria-pressed` carries the state, and the visible text says it too ("Pinned
 * for Boost", as the compact tile does), which is also its accessible name. Shared by the card's entries
 * (EntryBadge) and the Chosen Photos chooser's tiles (PhotoChooserModal).
 */
export function PinToggle({
    kind,
    pressed,
    busy,
    describedBy,
    onToggle,
}: {
    kind: EntryPinKind;
    pressed: boolean;
    busy: boolean;
    /** The id of a line that says what the toggle does (the chooser's help line). */
    describedBy?: string;
    onToggle: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const name = t(kind === 'boost' ? 'app.pinForBoost' : 'app.pinForTurbo');
    const pinnedName = t(kind === 'boost' ? 'app.pinnedForBoost' : 'app.pinnedForTurbo');
    return (
        <ActionButton
            variant={pressed ? PIN_PRESSED_VARIANTS[kind] : 'plain'}
            className={[pressed ? '' : 'btn-outline', busy ? 'btn-disabled' : ''].filter(Boolean).join(' ')}
            aria-pressed={pressed}
            aria-describedby={describedBy}
            // aria-disabled, not disabled: a disabled button drops the keyboard focus to <body> mid-write.
            onClick={() => {
                if (!busy) void onToggle();
            }}
            aria-disabled={busy}
            aria-busy={busy}
        >
            <span aria-hidden="true">📌</span> {pressed ? pinnedName : name}
        </ActionButton>
    );
}
