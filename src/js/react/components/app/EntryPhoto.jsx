import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { entryPhotoUrl } from '@/utils/formatters';
import { Modal } from '@/components/ui/Modal';

// Edge lengths requested from the photo CDN. The chip renders at 24px but asks
// for 56 so it stays sharp on a 2x display; the hover card and the modal ask
// for `fit`-style renders because judging an auto-filled photo means seeing the
// whole frame, not a centre crop of it.
const THUMB_PX = 56;
const HOVER_PX = 400;
const FULL_PX = 1200;

/**
 * The submitted photo for one challenge entry: a chip that peeks larger on
 * hover and opens full-size on click.
 *
 * WHY IT EXISTS: auto-fill picks the photo, and the pick is not always the one
 * you would have made. Without this the only way to see what was submitted is
 * to open gurushots.com. No API response carries an image URL, so the src is
 * built from the entry's own ids — see src/js/format/photoUrl.js.
 *
 * Lives apart from EntryBadge so the badge stays about rank/boost/turbo state;
 * folding this inline pushed that component past the repo's complexity gate.
 *
 * @param {object} props
 * @param {object} props.entry - Entry record from challenge.member.ranking.entries
 */
export function EntryPhoto({ entry }) {
    const { t } = useTranslation();
    // Hover drives the desktop peek; `fullOpen` drives the modal, which is the
    // path that also works on Android (no hover on touch) and from the keyboard.
    // The hover card is mounted only while hovered so a challenge list with a
    // dozen entries doesn't fetch a dozen 400px renders up front.
    const [hovered, setHovered] = useState(false);
    const [fullOpen, setFullOpen] = useState(false);

    // Null whenever the ids aren't CDN-shaped; the caller then renders nothing
    // and the badge looks exactly as it did before this feature.
    const thumbUrl = entryPhotoUrl(entry, { size: THUMB_PX });
    if (!thumbUrl) return null;

    const photoLabel = `${t('app.entryPhoto')} — ${t('app.rank')} ${entry.rank}`;

    return (
        <span className="relative inline-flex">
            {/* The peek is driven from the button, not a wrapper: a native
                control already handles mouse, touch and keyboard, so focus
                gets the same preview a pointer does. */}
            <button
                type="button"
                className="focus-visible:ring-primary block h-6 w-6 overflow-hidden rounded focus:outline-none focus-visible:ring-2"
                onClick={() => setFullOpen(true)}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onFocus={() => setHovered(true)}
                onBlur={() => setHovered(false)}
                aria-label={t('app.viewEntryPhoto')}
                title={photoLabel}
            >
                {/* Decorative: the button carries the accessible name, so an alt
                    here would make a screen reader announce the photo twice.
                    Empty alt also means a CDN failure degrades to a blank chip
                    instead of clipped alt text inside a 24px box. */}
                <img src={thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
            {hovered && (
                // pointer-events-none so the card never eats the click that
                // opens the full-size modal underneath it.
                <span className="rounded-box border-base-300 bg-base-100 pointer-events-none absolute bottom-full left-0 z-50 mb-1 block w-56 border p-1 shadow-xl">
                    <img src={entryPhotoUrl(entry, { size: HOVER_PX, fit: true })} alt="" className="w-full rounded" />
                </span>
            )}
            <Modal isOpen={fullOpen} onClose={() => setFullOpen(false)} title={photoLabel} size="xl">
                <img
                    src={entryPhotoUrl(entry, { size: FULL_PX, fit: true })}
                    alt={photoLabel}
                    className="max-h-[70vh] w-full rounded object-contain"
                />
                <div className="text-base-content/60 mt-2 text-xs">
                    {t('app.rank')} {entry.rank} · {entry.votes} {t('app.votes')}
                </div>
            </Modal>
        </span>
    );
}
