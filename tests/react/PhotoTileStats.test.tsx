/**
 * The per-photo stats on a full tile (Show stats): the visible `2.42 · ♥ 1 386 · ★ 14` line under
 * the labels, hidden from the accessibility tree, and the same facts in the button's composed
 * aria-label, in the UI language's number formatting. Translations are the real English strings;
 * the Latvian case exercises the locale through the mocked translator.
 */

import { render, screen } from './helpers/test-utils';
import { PhotoTile } from '@/components/app/PhotoTile';
import { mockTranslator } from './helpers/setup';
import { createTranslator } from '../../src/ts/translations/translator';

import type { TileStats } from '@/hooks/usePhotoStatsLoader';
import type { LibraryPhoto } from '@/hooks/useLibraryListing';
import type { Translate } from '../../src/ts/translations/translator';

const MEMBER = 'c'.repeat(32);
const photo: LibraryPhoto = {
    id: `${'a'.repeat(8)}${'b'.repeat(24)}`,
    labels: ['sunset'],
    allowed: true,
    message: null,
    uploadDate: 1,
};

const stats: TileStats = { id: photo.id, votes: 121, views: 50, likes: 1386, guruPicks: 14 };

const tile = (over: Partial<Parameters<typeof PhotoTile>[0]> = {}) =>
    render(
        <PhotoTile
            photo={photo}
            memberId={MEMBER}
            selected={false}
            position={null}
            blockedReason={null}
            atCap={false}
            fullKey="app.photoChooserListFull"
            allowedKnown={true}
            locked={false}
            lockedKey="app.photoChooserTileLocked"
            onToggle={jest.fn()}
            {...over}
        />,
    );

// The real English strings, placeholders filled like the real t fills them.
const translator = createTranslator();
const english: Translate = (key, vars) => translator.t(key, vars, 'en');

beforeEach(() => {
    mockTranslator.t.mockImplementation(english);
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

describe('the visible stats line', () => {
    test('shows the ratio at two decimals and the Intl-formatted counts', () => {
        tile({ stats, showStats: true });
        const button = screen.getByRole('button');
        expect(button.textContent).toContain('2.42 · ♥ 1,386 · ★ 14');
        expect(button.textContent).toContain('·');
    });

    test('a photo with no views shows a dash for the ratio, the counts as read', () => {
        tile({ stats: { ...stats, votes: 0, views: 0 }, showStats: true });
        expect(screen.getByRole('button').textContent).toContain('— · ♥ 1,386 · ★ 14');
    });

    test('is hidden while Show stats is off and while the stats are unread', () => {
        const first = tile({ stats, showStats: false });
        expect(screen.getByRole('button').textContent).not.toContain('♥');
        first.rerender(
            <PhotoTile
                photo={photo}
                memberId={MEMBER}
                selected={false}
                position={null}
                blockedReason={null}
                atCap={false}
                fullKey="app.photoChooserListFull"
                allowedKnown={true}
                locked={false}
                lockedKey="app.photoChooserTileLocked"
                onToggle={jest.fn()}
                showStats={true}
            />,
        );
        expect(screen.getByRole('button').textContent).not.toContain('♥');
    });

    test('is dimmed with the labels while the tile is unavailable', () => {
        tile({ stats, showStats: true, locked: true });
        expect(screen.getByText(/♥/).className).toContain('opacity-50');
    });

    test('is aria-hidden, so the accessibility tree carries the facts only through the button label', () => {
        tile({ stats, showStats: true });
        expect(screen.getByText(/♥/).getAttribute('aria-hidden')).toBe('true');
    });
});

describe('the composed aria-label', () => {
    test('gains the translated stats after the tile name, with the ratio and formatted counts', () => {
        tile({ stats: { ...stats, likes: 13860 }, showStats: true });
        const label = screen.getByRole('button').getAttribute('aria-label') ?? '';
        expect(label).toBe(
            'Photo aaaaaaaa: sunset. Can be entered. Ratio 2.42 votes per view, 13,860 likes, 14 Guru picks.',
        );
    });

    test('a photo with no views says so in words (the visible line keeps its dash)', () => {
        tile({ stats: { ...stats, votes: 0, views: 0 }, showStats: true });
        expect(screen.getByRole('button').getAttribute('aria-label')).toContain(
            'No views yet, 1,386 likes, 14 Guru picks.',
        );
    });

    test('is unchanged while Show stats is off or the stats are unread', () => {
        const first = tile({ stats, showStats: false });
        expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Photo aaaaaaaa: sunset. Can be entered');
        first.rerender(
            <PhotoTile
                photo={photo}
                memberId={MEMBER}
                selected={false}
                position={null}
                blockedReason={null}
                atCap={false}
                fullKey="app.photoChooserListFull"
                allowedKnown={true}
                locked={false}
                lockedKey="app.photoChooserTileLocked"
                onToggle={jest.fn()}
                showStats={true}
            />,
        );
        expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Photo aaaaaaaa: sunset. Can be entered');
    });

    test('the numbers take the active language’s formatting', () => {
        // Two one-shots, so the mocked language is back for the next test: the
        // label reads the locale once for the counts and once inside ratioText.
        mockTranslator.getCurrentLanguage.mockReturnValueOnce('lv').mockReturnValueOnce('lv');
        tile({ stats: { ...stats, likes: 13860 }, showStats: true });
        const format = new Intl.NumberFormat('lv-LV');
        const label = screen.getByRole('button').getAttribute('aria-label') ?? '';
        expect(label).toContain(
            `Ratio 2,42 votes per view, ${format.format(13860)} likes, ${format.format(14)} Guru picks.`,
        );
    });
});
