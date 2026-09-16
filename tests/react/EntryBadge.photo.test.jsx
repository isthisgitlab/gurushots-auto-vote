/**
 * Component tests for the entry thumbnail added to EntryBadge.jsx.
 *
 * The photo is built client-side from the entry's own ids (no API field
 * carries a URL — see src/js/format/photoUrl.js), so the two behaviours worth
 * pinning are:
 *   - a well-formed entry renders a chip pointing at the CDN, and escalating
 *     to hover / click asks for progressively larger renders of the SAME photo;
 *   - an entry whose ids aren't CDN-shaped renders exactly the badge that
 *     existed before this feature, with no broken image in it.
 */

import { fireEvent, render, screen } from './helpers/test-utils';
import { EntryBadge } from '@/components/app/EntryBadge';

const mockBoostState = { applyBoost: jest.fn(), loading: false, error: null, clearError: jest.fn() };
const mockTurboState = { applyTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() };

jest.mock('@/api/useBoost', () => ({ useBoost: () => mockBoostState }));
jest.mock('@/api/useTurbo', () => ({ useTurbo: () => mockTurboState }));

// Real ids, shaped the way the API returns them.
const MEMBER = 'c1d1f7733b10b21459a3a86c5162efa9';
const IMAGE = 'ee794fe28b178f7201ee9c8b7efde408';

const photoEntry = (overrides = {}) => ({
    id: IMAGE,
    member_id: MEMBER,
    rank: 3,
    votes: 42,
    boosted: false,
    turbo: false,
    ...overrides,
});

const renderBadge = (entry) =>
    render(<EntryBadge entry={entry} challengeId={777} boostAvailable={false} turboAvailable={false} />);

// The chip is the only <img> until a preview opens; it is decorative (alt="")
// because the enclosing button carries the accessible name.
const thumb = () => document.querySelector('button[aria-label] img');
const images = () => Array.from(document.querySelectorAll('img')).map((el) => el.getAttribute('src'));

describe('EntryBadge — entry thumbnail', () => {
    test('renders a CDN thumbnail for a well-formed entry', () => {
        renderBadge(photoEntry());
        expect(thumb()?.getAttribute('src')).toBe(`https://photos.gurushots.com/unsafe/56x56/${MEMBER}/3_${IMAGE}.jpg`);
    });

    test('the thumbnail is reachable as a labelled button', () => {
        renderBadge(photoEntry());
        expect(screen.getByRole('button', { name: /photo/i })).toBeTruthy();
    });

    // A challenge card renders one of these per entry, so a fixed label would
    // repeat identically down a screen reader's control list.
    test('the accessible name carries the rank so entries are distinguishable', () => {
        renderBadge(photoEntry({ rank: 748 }));
        expect(screen.getByRole('button', { name: /748/ })).toBeTruthy();
    });

    // A well-formed URL can still 404 (deleted photo, missing rendition) or
    // fail offline. That must hide the chip, not leave a broken-image glyph.
    test('a failed image load hides the chip entirely', async () => {
        const RealImage = window.Image;
        // Stand-in that reports failure as soon as a src is assigned.
        window.Image = class {
            set src(_value) {
                queueMicrotask(() => this.onerror?.());
            }
        };
        try {
            renderBadge(photoEntry());
            // Let the probe's microtask and the resulting re-render settle.
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(document.querySelector('img')).toBeNull();
            // The rest of the badge survives.
            expect(screen.getByText(/42/)).toBeTruthy();
        } finally {
            window.Image = RealImage;
        }
    });

    test('hovering asks the CDN for a larger, uncropped render of the same photo', () => {
        renderBadge(photoEntry());
        expect(images()).toHaveLength(1);

        fireEvent.mouseEnter(screen.getByRole('button', { name: /photo/i }));

        expect(images()).toContain(`https://photos.gurushots.com/unsafe/fit-in/400x400/${MEMBER}/3_${IMAGE}.jpg`);
    });

    // The peek is pointer-only by design: driving it from onFocus meant Modal's
    // focus restoration re-opened it every time the full-size view was closed.
    // Keyboard access is via the chip itself — Tab to it, Enter for the modal.
    test('focus alone does not open the peek', () => {
        renderBadge(photoEntry());
        screen.getByRole('button', { name: /photo/i }).focus();
        expect(images()).toHaveLength(1);
    });

    test('the photo is reachable without a pointer', () => {
        renderBadge(photoEntry());
        const button = screen.getByRole('button', { name: /photo/i });

        expect(button.tagName).toBe('BUTTON');
        expect(button.getAttribute('tabindex')).not.toBe('-1');
        expect(button.hasAttribute('disabled')).toBe(false);

        // What Enter/Space on a focused native button dispatches.
        fireEvent.click(button);
        expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });

    test('leaving the thumbnail tears the preview back down', () => {
        renderBadge(photoEntry());
        const button = screen.getByRole('button', { name: /photo/i });
        fireEvent.mouseEnter(button);
        expect(images()).toHaveLength(2);
        fireEvent.mouseLeave(button);
        expect(images()).toHaveLength(1);
    });

    test('clicking opens a dialog holding the full-size render', () => {
        renderBadge(photoEntry());
        expect(document.querySelector('[role="dialog"]')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /photo/i }));

        expect(document.querySelector('[role="dialog"]')).toBeTruthy();
        expect(images()).toContain(`https://photos.gurushots.com/unsafe/fit-in/1200x1200/${MEMBER}/3_${IMAGE}.jpg`);
    });

    // Degradation matters more than the happy path here: a malformed id must
    // not put a broken image into every row of the challenge list.
    describe('degrades to the pre-feature badge when no URL can be built', () => {
        test.each([
            ['a non-hex id', { id: 'e1', member_id: MEMBER }],
            ['a missing member_id', { id: IMAGE, member_id: undefined }],
            ['a path-traversal member_id', { id: IMAGE, member_id: '../../evil' }],
        ])('%s renders no image at all', (_label, overrides) => {
            renderBadge(photoEntry(overrides));
            expect(document.querySelector('img')).toBeNull();
        });

        test('the rank and vote text still renders without a photo', () => {
            renderBadge(photoEntry({ id: 'e1', member_id: 'nope' }));
            expect(screen.getByText(/42/)).toBeTruthy();
        });
    });
});
