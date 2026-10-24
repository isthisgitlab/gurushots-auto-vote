/**
 * A tile's read stats behind Show stats: the small visible line under the labels, and the fragment
 * the tile button's composed aria-label gains. The visible line is aria-hidden — the button's label
 * carries the same facts for a screen reader — and its numbers take the UI language's formatting.
 */

import { interp } from '@/utils/interp';
import { dateLocale } from '@/utils/formatters';

import type { TileStats } from '@/hooks/usePhotoStatsLoader';

// Number formats per locale and fraction digits: one stats answer re-renders many tiles at once.
const formats = new Map<string, Intl.NumberFormat>();
const numberFormat = (locale: string, fractionDigits = 0): Intl.NumberFormat => {
    const key = `${locale}:${fractionDigits}`;
    let format = formats.get(key);
    if (!format) {
        format = new Intl.NumberFormat(locale, {
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
        });
        formats.set(key, format);
    }
    return format;
};

/**
 * The ratio as the tile shows and names it: votes per view at two decimals, or a dash when the
 * photo has no views to divide by.
 */
export const ratioText = (stats: TileStats): string =>
    stats.views > 0 ? numberFormat(dateLocale(), 2).format(stats.votes / stats.views) : '—';

/** The visible `2.42 · ♥ 1 386 · ★ 14` line, dimmed with the labels while the tile is unavailable. */
export function TileStatsLine({ stats, dim }: { stats: TileStats; dim: string }) {
    const locale = dateLocale();
    return (
        <span aria-hidden="true" className={`text-base-content/70 text-xs ${dim}`}>
            {`${ratioText(stats)} · ♥ ${numberFormat(locale).format(stats.likes)} · ★ ${numberFormat(locale).format(stats.guruPicks)}`}
        </span>
    );
}

/** A tile's name with the read stats added after it, the way withPosition and withRank add theirs. */
export const withStatsLabel = (label: string, t: (key: string) => string, stats: TileStats): string => {
    const count = numberFormat(dateLocale());
    const tail =
        stats.views > 0
            ? interp(t('app.photoChooserTileStats'), {
                  ratio: ratioText(stats),
                  likes: count.format(stats.likes),
                  guruPicks: count.format(stats.guruPicks),
              })
            : // No views to divide by: the visible line keeps its dash, but the name says so in words.
              interp(t('app.photoChooserTileStatsNoViews'), {
                  likes: count.format(stats.likes),
                  guruPicks: count.format(stats.guruPicks),
              });
    return `${label.replace(/[.!?]*$/, '.')} ${tail}`;
};
