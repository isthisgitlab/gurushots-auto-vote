import { memo } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { ToneNote } from '@/components/ui/ToneNote';
import { useImageLoads } from '@/hooks/useImageLoads';
import { buildPhotoUrl } from '@/utils/formatters';
import { interp } from '@/utils/interp';
import { TileStatsLine, withStatsLabel } from './TileStats';

import type { LibraryPhoto } from '@/hooks/useLibraryListing';
import type { TileStats } from '@/hooks/usePhotoStatsLoader';

// Edge length requested from the photo CDN for a tile (the grid shows them ~150px wide).
const TILE_PX = 240;

// Characters of a photo id shown on a tile — enough to tell tiles apart.
const SHORT_ID_LENGTH = 8;

const shortId = (id: string): string => id.slice(0, SHORT_ID_LENGTH);

/**
 * What a tile says about the photo: its tags, or the id's start when it has none.
 */
const labelsOf = (photo: LibraryPhoto, noTags: string): string => photo.labels.join(', ') || noTags;

// The focus outline is offset past the 2px ring of a selected tile, so keyboard focus shows on a selected one and
// an unselected focused tile does not look selected.
const TILE_BASE =
    'rounded-box border p-1 text-left flex flex-col gap-1 w-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-base-content';

/**
 * The short text under a tile saying whether the photo can be added: the
 * challenge's refusal, "list full", or "can be entered" when the listing knows.
 */
const tileReason = ({
    locked,
    lockedKey,
    blockedReason,
    full,
    fullKey,
    allowedKnown,
    t,
}: {
    locked: boolean;
    lockedKey: string;
    blockedReason: string | null;
    full: boolean;
    fullKey: string;
    allowedKnown: boolean;
    t: (key: string) => string;
}): string | null => {
    // Nothing can be added yet, so the tile must not say it can be.
    if (locked) return t(lockedKey);
    if (blockedReason !== null) return blockedReason;
    if (full) return t(fullKey);
    return allowedKnown ? t('app.photoChooserAllowed') : null;
};

/**
 * One photo as a toggle button: its thumbnail (or, with no URL or one that does
 * not load, its tags and short id as text), the tags, and — when the listing
 * knows — whether the challenge accepts it, with the reason as text.
 * Server strings (tags, reason) are React text children only.
 */
/** A tile's name, with "Number 3 in your list." added after it when it is a selected one. */
const withPosition = (label: string, t: (key: string) => string, position: number | null): string => {
    if (position === null) return label;
    return `${label.replace(/[.!?]*$/, '.')} ${interp(t('app.photoChooserPosition'), { n: position })}`;
};

/** The visible number on a selected tile: the order the photos are saved in (named in the tile's label too). */
function PositionBadge({ position }: { position: number | null }) {
    return position === null ? null : (
        <span aria-hidden="true" className="badge badge-neutral badge-sm self-start">
            {position}
        </span>
    );
}

/** A tile's name with "Suggestion #3." added after it when it stands in the suggestions. */
const withRank = (label: string, t: (key: string) => string, rank: number | null): string =>
    rank === null ? label : `${label.replace(/[.!?]*$/, '.')} ${interp(t('app.pickSuggestionRank'), { n: rank })}.`;

/** The visible "#3" on a suggestion's tile: its rank, fixed whatever is picked. */
function RankBadge({ rank }: { rank: number | null }) {
    const { t } = useTranslation();
    return rank === null ? null : (
        <span
            role="img"
            aria-label={interp(t('app.pickSuggestionRank'), { n: rank })}
            className="badge badge-outline badge-sm self-start"
        >
            #{rank}
        </span>
    );
}

/**
 * The square a tile is built on: the thumbnail once it loads, or the tile's fallback text while
 * there is no URL to build one from, or the image failed to load. Only the square is dimmed, and
 * the fallback carries it the same way.
 */
function TileImage({
    show,
    imageRef,
    url,
    dim,
    fallback,
}: {
    show: boolean;
    imageRef: (img: HTMLImageElement | null) => void;
    url: string | null;
    dim: string;
    fallback: string;
}) {
    return show ? (
        <img
            ref={imageRef}
            src={url as string}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className={`aspect-square w-full rounded object-cover ${dim}`}
        />
    ) : (
        <span
            className={`bg-base-200 flex aspect-square w-full items-center justify-center rounded p-1 text-center text-xs break-words ${dim}`}
        >
            {fallback}
        </span>
    );
}

function PhotoTileBase({
    photo,
    memberId,
    selected,
    position,
    rank = null,
    recommended = false,
    blockedReason,
    atCap,
    fullKey,
    allowedKnown,
    locked,
    lockedKey,
    onToggle,
    stats = null,
    showStats = false,
}: {
    photo: LibraryPhoto;
    memberId: string | null;
    selected: boolean;
    /** Where the photo stands in the list (1-based), for a selected tile; null otherwise. */
    position: number | null;
    /** Where the photo stands in the suggestions (1-based), for a suggestion's tile; null otherwise. */
    rank?: number | null;
    /** GuruShots suggests the photo for the challenge (a Discover row's chooser). */
    recommended?: boolean;
    blockedReason: string | null;
    atCap: boolean;
    /** The translation key of what a tile that cannot be added because the selection is full says. */
    fullKey: string;
    allowedKnown: boolean;
    locked: boolean;
    /** The translation key of what a locked tile says. */
    lockedKey: string;
    onToggle: (id: string) => void;
    /** The photo's read stats (the Show-stats loader's): shown while `showStats` is on. */
    stats?: TileStats | null;
    /** Show stats is on: the tile carries its ratio, likes and Guru picks. */
    showStats?: boolean;
}) {
    const { t } = useTranslation();
    const url = memberId ? buildPhotoUrl(memberId, photo.id, { size: TILE_PX }) : null;
    const [showImage, imageRef] = useImageLoads(url);
    const labels = labelsOf(photo, t('app.photoChooserNoTags'));
    // A photo that cannot be added (the challenge refuses it, or the list is full)
    // stays removable once selected. It is aria-disabled rather than disabled, so
    // Tab still reaches it and a screen reader can read why it cannot be added.
    const unavailable = locked || (!selected && (blockedReason !== null || atCap));
    const full = !selected && atCap;
    const reason = tileReason({ locked, lockedKey, blockedReason, full, fullKey, allowedKnown, t });
    // Only the picture and its tags are dimmed: the reason line stays at full contrast, since it is
    // what says why the tile cannot be added.
    const dim = unavailable ? 'opacity-50' : '';
    const tone = selected ? 'border-base-content ring-2 ring-base-content' : 'border-base-300';
    const composed = withRank(
        withPosition(
            interp(t('app.photoChooserTileLabel'), {
                id: shortId(photo.id),
                labels,
                reason: reason ?? '',
            }).trim(),
            t,
            position,
        ),
        t,
        rank,
    );
    return (
        <button
            type="button"
            aria-pressed={selected}
            aria-label={`${recommended ? `${t('app.photoRecommended')}. ` : ''}${
                showStats && stats ? withStatsLabel(composed, t, stats) : composed
            }`}
            aria-disabled={unavailable}
            className={`${TILE_BASE} ${tone}`}
            onClick={() => {
                if (!unavailable) onToggle(photo.id);
            }}
        >
            {recommended && (
                <span className="badge badge-outline badge-sm self-start">{t('app.photoRecommended')}</span>
            )}
            <PositionBadge position={position} />
            <RankBadge rank={rank} />
            <TileImage show={showImage} imageRef={imageRef} url={url} dim={dim} fallback={labels} />
            <span className={`truncate text-xs ${dim}`}>{showImage ? labels : shortId(photo.id)}</span>
            {showStats && stats && <TileStatsLine stats={stats} dim={dim} />}
            {reason &&
                (!locked && !full && blockedReason !== null ? (
                    <ToneNote tone="error" as="span" className="text-xs">
                        {reason}
                    </ToneNote>
                ) : (
                    <span className={`text-xs ${locked || full ? 'text-base-content/70' : 'text-success'}`}>
                        {reason}
                    </span>
                ))}
        </button>
    );
}

// Memoised: a toggle re-renders the grid, and with this only the tiles whose own props changed. Every prop
// is a primitive or stable between renders (the listing's photo records, and `toggle`, a useCallback).
export const PhotoTile = memo(PhotoTileBase);

/**
 * A saved pick while nothing has been read: its number, its thumbnail once the member check says
 * whose photo it is (else its short id as text), and no claim about the photo itself — its tags are
 * unread. A read that lands replaces it with the real tile or a missing one. The ready grid uses it
 * too, with its own note (`noteKey`), for a chosen pick no batch read so far has shown.
 */
export function SavedPickTile({
    id,
    memberId,
    selected,
    position,
    atCap,
    fullKey,
    locked,
    lockedKey,
    onToggle,
    noteKey = 'app.photoChooserSavedTileNote',
}: {
    id: string;
    memberId: string | null;
    selected: boolean;
    /** Where the photo stands in the list (1-based), for a selected tile; null otherwise. */
    position: number | null;
    atCap: boolean;
    /** The translation key of what a tile that cannot be added because the selection is full says. */
    fullKey: string;
    locked: boolean;
    /** The translation key of what a locked tile says. */
    lockedKey: string;
    onToggle: (id: string) => void;
    /** The translation key of the note on an unlocked, uncapped tile: why the photo itself is not shown yet. */
    noteKey?: string;
}) {
    const { t } = useTranslation();
    const url = memberId ? buildPhotoUrl(memberId, id, { size: TILE_PX }) : null;
    const [showImage, imageRef] = useImageLoads(url);
    // A pick stays removable, an unpicked one is blocked at the cap and a locked one is inert; the reason goes in the
    // label because it replaces the tile's visible text.
    const unavailable = locked || (!selected && atCap);
    const reason = locked ? t(lockedKey) : !selected && atCap ? t(fullKey) : t(noteKey);
    const dim = unavailable ? 'opacity-50' : '';
    const tone = selected ? 'border-base-content ring-2 ring-base-content' : 'border-base-300';
    return (
        <button
            type="button"
            aria-pressed={selected}
            aria-label={withPosition(
                interp(t('app.photoChooserSavedTileLabel'), { id: shortId(id), reason }),
                t,
                position,
            )}
            aria-disabled={unavailable}
            className={`${TILE_BASE} ${tone}`}
            onClick={() => {
                if (!unavailable) onToggle(id);
            }}
        >
            <PositionBadge position={position} />
            <TileImage show={showImage} imageRef={imageRef} url={url} dim={dim} fallback={shortId(id)} />
            <span className={`truncate text-xs ${dim}`}>{shortId(id)}</span>
            <span className="text-xs text-base-content/70">{reason}</span>
        </button>
    );
}

/**
 * What a chosen photo the listing does not return most likely is. With a
 * challenge the usual cause is another challenge holding it; without one every
 * library photo is listed, so it was deleted. A listing read as a search
 * claims only what a search can know: the photo does not match the term.
 * (A cut-off listing does not reach this tile: its unreached picks show as
 * saved-pick stubs, which point at Load more photos, and its won picks carry
 * the won reason.)
 */
const missingKey = (hasChallenge: boolean, search: boolean): string =>
    search
        ? 'app.photoChooserMissingSearch'
        : hasChallenge
          ? 'app.photoChooserMissing'
          : 'app.photoChooserMissingNoChallenge';

/**
 * A chosen photo the listing does not return: still selected (and removable),
 * with the likely reasons it is missing.
 */
export function MissingTile({
    id,
    position,
    count,
    hasChallenge,
    search,
    won,
    onToggle,
}: {
    id: string;
    position: number | null;
    count: number;
    hasChallenge: boolean;
    /** The listing came from a search: the tile says only that the photo is not in these results. */
    search: boolean;
    /** The listing left the photo out because it has won a challenge, which says why it is missing. */
    won: boolean;
    onToggle: (id: string) => void;
}) {
    const { t } = useTranslation();
    const text = won ? t('app.photoChooserWonInList') : interp(t(missingKey(hasChallenge, search)), { count });
    return (
        <button
            type="button"
            aria-pressed
            aria-label={withPosition(
                interp(t('app.photoChooserMissingTileLabel'), { id: shortId(id), reason: text }),
                t,
                position,
            )}
            className={`${TILE_BASE} border-warning bg-warning/10`}
            onClick={() => onToggle(id)}
        >
            <PositionBadge position={position} />
            <span className="text-xs font-medium">{shortId(id)}</span>
            <span className="text-xs">{text}</span>
        </button>
    );
}

/**
 * A chosen photo the preview does not list: the library is being read again, so whether it is really
 * missing is not known yet. It stays selected, and cannot be removed until that read has failed, when it can.
 */
export function PendingTile({
    id,
    position,
    recheckFailed,
    onToggle,
}: {
    id: string;
    position: number | null;
    recheckFailed: boolean;
    onToggle: (id: string) => void;
}) {
    const { t } = useTranslation();
    const text = t(recheckFailed ? 'app.photoChooserNotAsLoadedFailed' : 'app.photoChooserNotAsLoaded');
    return (
        <button
            type="button"
            aria-pressed
            aria-disabled={!recheckFailed}
            aria-label={withPosition(
                interp(t('app.photoChooserMissingTileLabel'), { id: shortId(id), reason: text }),
                t,
                position,
            )}
            className={`${TILE_BASE} border-base-300 bg-base-200`}
            onClick={() => {
                if (recheckFailed) onToggle(id);
            }}
        >
            <PositionBadge position={position} />
            <span className="text-xs font-medium">{shortId(id)}</span>
            <span className="text-xs">{text}</span>
        </button>
    );
}
