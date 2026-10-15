/**
 * What a challenge listing (the Discover rows and the CLI `discover`) says about a challenge besides its title:
 * its type (its badge when it has none), how many photos it takes, and its tags. Every field is read from a
 * server payload, so each one is checked and a malformed one shows nothing.
 */

type Listed = { type?: unknown; badge?: unknown; tags?: unknown; max_photo_submits?: unknown };

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The challenge's type, else its badge, as the listing shows it; null when it has neither. */
const challengeKind = (c: Listed | null | undefined): { label: string; isType: boolean } | null => {
    const type = text(c?.type);
    if (type) return { label: type, isType: true };
    const badge = text(c?.badge);
    return badge ? { label: badge, isType: false } : null;
};

/** How many photos the challenge takes, when that is more than one. */
const challengePhotoCount = (c: Listed | null | undefined): number | null => {
    const count = Number(c?.max_photo_submits);
    return Number.isInteger(count) && count > 1 ? count : null;
};

// The listing says "N photos" itself, from `max_photo_submits`: a tag that says the same would repeat it.
const PHOTO_COUNT_TAG = /^\d+ photos?$/i;

/** The challenge's tags that are text and not blank, trimmed; a value that is not a list gives none. */
const stringTags = (c: Listed | null | undefined): string[] => {
    const tags: unknown[] = Array.isArray(c?.tags) ? c.tags : [];
    return tags.map(text).filter((tag) => tag !== '');
};

/**
 * The challenge's tags worth listing in a row: its text tags without those that repeat the kind or the photo
 * count the row already shows.
 */
const listedTags = (c: Listed | null | undefined): string[] => {
    const kind = challengeKind(c)?.label.toLowerCase();
    return stringTags(c).filter((tag) => tag.toLowerCase() !== kind && !PHOTO_COUNT_TAG.test(tag));
};

export { challengeKind, challengePhotoCount, stringTags, listedTags };
