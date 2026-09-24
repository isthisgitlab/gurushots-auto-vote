import { useState } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { entryPhotoUrl } from '@/utils/formatters';
import { useImageLoads } from '@/hooks/useImageLoads';
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
 * The click-to-modal path is the load-bearing one: it is the only path that
 * works on Android (no hover on touch) and from the keyboard, and it is what
 * actually renders the photo at recognisable size. The hover peek is a
 * desktop-only convenience layered on top.
 *
 * @param {object} props
 * @param {object} props.entry - Entry record from challenge.member.ranking.entries
 */
export function EntryPhoto({ entry }) {
    const { t } = useTranslation();
    // Pointer-only ON PURPOSE: driving this from onFocus too would make Modal's
    // focus restoration re-open the peek every time the modal closed. Keyboard
    // reaches the photo via Enter on the chip, which opens the larger modal.
    const [hovered, setHovered] = useState(false);
    const [fullOpen, setFullOpen] = useState(false);

    // Null whenever the ids aren't CDN-shaped; the badge then shows no photo
    // chip at all.
    const thumbUrl = entryPhotoUrl(entry, { size: THUMB_PX });
    // A well-formed URL can still fail — a since-deleted photo, an absent `3_`
    // rendition, an offline session. Same outcome as a malformed id: show
    // nothing rather than a broken-image glyph.
    const showPhoto = useImageLoads(thumbUrl);

    if (!showPhoto) return null;

    // Both carry the rank so a screen reader can tell several entries in the
    // same challenge apart — every EntryBadge in a card renders one of these,
    // and a fixed string would repeat identically down the rotor. Split in two
    // because the roles differ: the dialog wants a noun heading, the button
    // wants the action.
    const rankSuffix = `${t('app.rank')} ${entry.rank}`;
    const photoLabel = `${t('app.entryPhoto')} — ${rankSuffix}`;
    const actionLabel = `${t('app.viewEntryPhoto')} — ${rankSuffix}`;

    return (
        <span className="relative inline-flex">
            {/* ring: the chip is 24px and sits next to an emoji, so it needs a
                visible edge to read as a control rather than decoration. */}
            <button
                type="button"
                className="ring-base-300 hover:ring-primary focus-visible:ring-primary block h-6 w-6 overflow-hidden rounded ring-1 focus:outline-none focus-visible:ring-2"
                onClick={() => setFullOpen(true)}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                aria-label={actionLabel}
            >
                {/* Decorative: the button carries the accessible name, so an alt
                    here would make a screen reader announce the photo twice. */}
                <img
                    src={thumbUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                />
            </button>
            {hovered && (
                // Opens DOWNWARD deliberately: anchored above, a badge in the top
                // row would push the card past y=0, which no amount of scrolling
                // reaches. Residual limit — no collision/flip logic, so a chip at
                // the far right of a narrow window can still overflow sideways;
                // fixing that needs measured positioning (an inline style, which
                // this renderer has none of) or a popover library.
                // pointer-events-none keeps it from eating the click underneath.
                <span className="rounded-box border-base-300 bg-base-100 pointer-events-none absolute top-full left-0 z-50 mt-1 block w-56 border p-1 shadow-xl">
                    {/* aspect-square + object-contain: the fit-in render's real
                        dimensions vary with the photo, so a fixed box keeps the
                        card from resizing under the cursor as the image lands. */}
                    <img
                        src={entryPhotoUrl(entry, { size: HOVER_PX, fit: true })}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="aspect-square w-full rounded object-contain"
                    />
                </span>
            )}
            <Modal isOpen={fullOpen} onClose={() => setFullOpen(false)} title={photoLabel} size="xl">
                <img
                    src={entryPhotoUrl(entry, { size: FULL_PX, fit: true })}
                    alt={photoLabel}
                    referrerPolicy="no-referrer"
                    className="max-h-[70vh] w-full rounded object-contain"
                />
                <div className="text-base-content/60 mt-2 text-xs">
                    {t('app.rank')} {entry.rank} · {entry.votes} {t('app.votes')}
                </div>
            </Modal>
        </span>
    );
}
