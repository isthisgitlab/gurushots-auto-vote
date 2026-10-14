/**
 * A library listing shown as a preview: the photos as last loaded, with the marks of whichever challenge
 * they were read for withheld, because they are that challenge's rules and say nothing about another's.
 * Dependency-free, so the main process (the cached answer) and the renderer (a cached answer shown as a
 * preview) hold the same shape.
 */

/** What a library photo says about whether a challenge accepts it. */
type Marked = { allowed: boolean; message: string | null };

/** `allowedKnown` is false, and no photo carries a mark or a reason: both mean nothing until a read says otherwise. */
const asPreview = <P extends Marked, L extends { photos: P[]; allowedKnown: boolean }>(listing: L): L => ({
    ...listing,
    allowedKnown: false,
    photos: listing.photos.map((photo) => ({ ...photo, allowed: false, message: null })),
});

export { asPreview };
