/**
 * Tests for the ChallengeCard badge row (the top-of-card chips).
 *
 * Two categories are rendered: "logical/state" badges (solid colors) that
 * reflect live challenge/automation state, and a separated "override/config"
 * badge (muted ghost) that marks per-challenge overrides. These tests assert
 * every badge shows icon + text, the override badge is visually distinct +
 * divided from the state badges, and the auto-fill badge hides once all slots
 * are filled.
 *
 * useChallengeSettings, useTurbo and useFillChallenge are stubbed so the test
 * can drive hasCustomSettings / autoSubmitEnabled directly; the child buttons
 * and EntryBadge are mocked to null so `span.badge` resolves to the top row
 * only. `t(key)` returns the key (see tests/react setup), so labels assert as
 * 'app.*' strings. Mock state object names start with "mock" for jest hoisting.
 */

import { render } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { ChallengeBadgeRow } from '@/components/app/ChallengeBadgeRow';
import { buildChallenge } from '../helpers/challengeFixtures';
import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/ts/types/gurushots';

const mockChallengeSettings = {
    hasCustomSettings: false,
    autoSubmitEnabled: false,
    manualPhotosOnly: false,
    isCompact: false,
    hasCompactOverride: false,
    toggleCompact: jest.fn(),
};

jest.mock('@/hooks/useChallengeSettings', () => ({
    useChallengeSettings: () => mockChallengeSettings,
}));
jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => ({ playAutoTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/api/useFillChallenge', () => ({
    useFillChallenge: () => ({ fillNow: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/components/app/VoteButton', () => ({ VoteButton: () => null }));
jest.mock('@/components/app/RunButton', () => ({ RunButton: () => null }));
jest.mock('@/components/app/EntryBadge', () => ({ EntryBadge: () => null }));

const makeChallenge = ({
    type = 'flash',
    badge,
    maxPhotos = 4,
    entriesCount = 0,
}: { type?: string | null; badge?: string | null; maxPhotos?: number; entriesCount?: number } = {}) =>
    buildChallenge({
        id: 101,
        title: 'Sunset',
        url: 'sunset',
        type,
        badge,
        max_photo_submits: maxPhotos,
        start_time: 0,
        close_time: Math.floor(Date.now() / 1000) + 3600,
        entries: 100,
        players: 50,
        votes: 2000,
        prizes_worth: '$100',
        tags: [],
        welcome_message: '',
        member: {
            boost: { state: 'UNAVAILABLE', timeout: null },
            turbo: { state: 'UNAVAILABLE', time_to_open: null },
            ranking: {
                entries: Array.from({ length: entriesCount }, (_, i) => ({ id: `e${i}`, rank: i + 1, votes: 0 })),
                exposure: { exposure_factor: 50 },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
        },
    });

const renderCard = (challenge: Challenge) =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining="2h 30m"
            timezone="local"
            autovoteRunning={false}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
            onCurrencySpent={() => {}}
        />,
    );

// Find a top-row badge by its exact (icon + text) content.
const badgeByText = (container: Element, text: string) =>
    [...container.querySelectorAll('span.badge')].find((el) => el.textContent === text);

beforeEach(() => {
    Object.assign(mockChallengeSettings, {
        hasCustomSettings: false,
        autoSubmitEnabled: false,
        manualPhotosOnly: false,
        isCompact: false,
        hasCompactOverride: false,
        toggleCompact: jest.fn(),
    });
});

describe('ChallengeCard badge row — logical/state badges', () => {
    test('type, photo-count and auto-fill all render icon + text with solid colors', () => {
        mockChallengeSettings.autoSubmitEnabled = true;
        const { container } = renderCard(makeChallenge());

        const type = badgeByText(container, '🏁 FLASH');
        expect(type).toBeTruthy();
        expect(type!.className).toMatch(/badge-warning/);

        const photos = badgeByText(container, '🖼 4 app.photos');
        expect(photos).toBeTruthy();
        expect(photos!.className).toMatch(/badge-warning/);

        const autoSubmit = badgeByText(container, '📥 app.autoSubmitBadge');
        expect(autoSubmit).toBeTruthy();
        expect(autoSubmit!.className).toMatch(/badge-success/);
    });

    test('alert, state and configuration badges share the same size', () => {
        const { container } = render(
            <ChallengeBadgeRow
                challenge={makeChallenge()}
                boostOpen
                boostTimeLeft="23m"
                lowExposure
                exposureFactor={0}
                showAutoSubmitBadge
                showManualPhotosBadge={false}
                hasCustomSettings
            />,
        );
        const badges = container.querySelectorAll('.badge');

        expect(badges).toHaveLength(6);
        expect([...badges].every((badge) => badge.classList.contains('badge-sm'))).toBe(true);
    });

    test('badge fallback (no type) also gets the icon and the info variant', () => {
        const { container } = renderCard(makeChallenge({ type: null, badge: 'Special' }));
        const fallback = badgeByText(container, '🏁 Special');
        expect(fallback).toBeTruthy();
        expect(fallback!.className).toMatch(/badge-info/);
    });

    test('auto-fill badge is hidden once all slots are filled', () => {
        mockChallengeSettings.autoSubmitEnabled = true;
        const { container } = renderCard(makeChallenge({ maxPhotos: 4, entriesCount: 4 }));
        expect(badgeByText(container, '📥 app.autoSubmitBadge')).toBeFalsy();
    });

    test('Manual Only shows its own badge in place of the auto-submit one', () => {
        mockChallengeSettings.autoSubmitEnabled = true;
        mockChallengeSettings.manualPhotosOnly = true;
        const { container } = renderCard(makeChallenge());
        const manual = badgeByText(container, '✋ app.manualPhotosBadge');
        expect(manual).toBeTruthy();
        expect(manual!.className).toMatch(/badge-info/);
        expect(badgeByText(container, '📥 app.autoSubmitBadge')).toBeFalsy();
    });

    test('the manual-only badge is absent while the switch is off', () => {
        const { container } = renderCard(makeChallenge());
        expect(badgeByText(container, '✋ app.manualPhotosBadge')).toBeFalsy();
    });

    test('photo-count badge is hidden for single-submission challenges', () => {
        const { container } = renderCard(makeChallenge({ maxPhotos: 1 }));
        expect(badgeByText(container, '🖼 1 app.photos')).toBeFalsy();
    });
});

describe('ChallengeCard badge row — shared with the Discover rows', () => {
    test('the detail card lists every tag as given, repeats of the type and photo-count tags included', () => {
        const challenge = { ...makeChallenge(), tags: ['FLASH', '4 photos', 'Comm'] };
        const { container } = renderCard(challenge);
        expect([...container.querySelectorAll('span.badge-ghost')].map((el) => el.textContent)).toEqual([
            'FLASH',
            '4 photos',
            'Comm',
        ]);
    });

    test('the compact tile leaves the photo count out, where the entries cell already reads N/max', () => {
        const { container } = render(
            <ChallengeBadgeRow
                challenge={makeChallenge()}
                boostOpen={false}
                boostTimeLeft={null}
                lowExposure={false}
                exposureFactor={0}
                showAutoSubmitBadge={false}
                showManualPhotosBadge={false}
                hasCustomSettings={false}
                showPhotoCount={false}
            />,
        );
        expect(badgeByText(container, '🏁 FLASH')).toBeTruthy();
        expect(badgeByText(container, '🖼 4 app.photos')).toBeFalsy();
    });

    test.each([
        ['a string', 'Exhibition', []],
        ['an object', { 0: 'Exhibition' }, []],
        [
            'a list with text, blanks and objects among it',
            ['Comm', '', '  ', { a: 1 }, 7, null, 'No comm'],
            ['Comm', 'No comm'],
        ],
    ])(
        'the detail card draws only the text tags of a tags value that is %s, and does not crash',
        (_name, tags, shown) => {
            const { container } = renderCard({ ...makeChallenge(), tags: invalid<string[]>(tags) });
            expect([...container.querySelectorAll('span.badge-ghost')].map((el) => el.textContent)).toEqual(shown);
        },
    );

    test.each([
        ['a blank type', '  '],
        ['a numeric type', invalid<string>(7)],
    ])('%s with custom settings draws neither an orphan divider nor an empty row', (_name, type) => {
        mockChallengeSettings.hasCustomSettings = true;
        const challenge = { ...makeChallenge({ maxPhotos: 1 }), type: invalid<string>(type), badge: undefined };
        const { container } = render(
            <ChallengeBadgeRow
                challenge={challenge}
                boostOpen={false}
                boostTimeLeft={null}
                lowExposure={false}
                exposureFactor={0}
                showAutoSubmitBadge={false}
                showManualPhotosBadge={false}
                hasCustomSettings
            />,
        );
        expect(container.querySelector('[data-testid="badge-divider"]')).toBeNull();
        // Only the custom-settings badge is there.
        expect([...container.querySelectorAll('span.badge')].map((el) => el.textContent)).toEqual([
            '⚙️ app.customBadge',
        ]);
    });

    test.each([
        ['a blank type, no badge, no custom settings', '  '],
        ['a numeric type, no badge, no custom settings', invalid<string>(7)],
    ])('%s draws no row at all', (_name, type) => {
        const challenge = { ...makeChallenge({ maxPhotos: 1 }), type: invalid<string>(type), badge: undefined };
        const { container } = render(
            <ChallengeBadgeRow
                challenge={challenge}
                boostOpen={false}
                boostTimeLeft={null}
                lowExposure={false}
                exposureFactor={0}
                showAutoSubmitBadge={false}
                showManualPhotosBadge={false}
                hasCustomSettings={false}
            />,
        );
        expect(container.innerHTML).toBe('');
    });

    test('a photo count that is not a whole number above one is not shown, nor counted for the divider', () => {
        mockChallengeSettings.hasCustomSettings = true;
        for (const count of [2.5, Infinity]) {
            const challenge = { ...makeChallenge({ type: null }), max_photo_submits: count };
            const { container, unmount } = render(
                <ChallengeBadgeRow
                    challenge={challenge}
                    boostOpen={false}
                    boostTimeLeft={null}
                    lowExposure={false}
                    exposureFactor={0}
                    showAutoSubmitBadge={false}
                    showManualPhotosBadge={false}
                    hasCustomSettings
                />,
            );
            expect(container.querySelector('[data-testid="badge-divider"]')).toBeNull();
            expect([...container.querySelectorAll('span.badge')].some((el) => el.textContent?.startsWith('🖼'))).toBe(
                false,
            );
            unmount();
        }
    });

    test('a type, badge or photo count of the wrong kind draws no kind badge and does not crash', () => {
        const odd = { ...makeChallenge(), type: invalid<string>(7), badge: invalid<string>({ a: 1 }) };
        const { container } = renderCard({ ...odd, max_photo_submits: invalid<number>('many') });
        expect(badgeByText(container, '🏁 FLASH')).toBeFalsy();
        expect([...container.querySelectorAll('span.badge')].some((el) => el.textContent?.startsWith('🏁'))).toBe(
            false,
        );
    });
});

describe('ChallengeCard badge row — override/config badge', () => {
    test('renders icon + translated label in the muted ghost style, distinct from state badges', () => {
        mockChallengeSettings.hasCustomSettings = true;
        mockChallengeSettings.autoSubmitEnabled = true;
        const { container } = renderCard(makeChallenge());

        const custom = badgeByText(container, '⚙️ app.customBadge');
        expect(custom).toBeTruthy();
        expect(custom!.className).toMatch(/badge-ghost/);
        // The override badge must not read as a state badge — it must not
        // share the auto-fill (success) styling.
        expect(custom!.className).not.toMatch(/badge-success/);

        const autoSubmit = badgeByText(container, '📥 app.autoSubmitBadge');
        expect(autoSubmit!.className).not.toMatch(/badge-ghost/);
    });

    test('the override badge meaning is visible text, not hidden in a tooltip', () => {
        mockChallengeSettings.hasCustomSettings = true;
        const { container } = renderCard(makeChallenge());
        const custom = badgeByText(container, '⚙️ app.customBadge');
        // The label is on-screen; no info is hidden behind a hover tooltip.
        expect(custom!.hasAttribute('title')).toBe(false);
    });

    test('a divider separates the override badge from the state badges when both are present', () => {
        mockChallengeSettings.hasCustomSettings = true;
        const { container } = renderCard(makeChallenge());
        expect(container.querySelector('[data-testid="badge-divider"]')).toBeTruthy();
    });

    test('no divider is rendered when the override badge is the only badge', () => {
        mockChallengeSettings.hasCustomSettings = true;
        // No type, no fallback badge, single-submission, auto-fill off → no logical badges.
        const { container } = renderCard(makeChallenge({ type: null, badge: null, maxPhotos: 1 }));
        expect(badgeByText(container, '⚙️ app.customBadge')).toBeTruthy();
        expect(container.querySelector('[data-testid="badge-divider"]')).toBeFalsy();
    });

    test('is not rendered when the challenge has no overrides', () => {
        const { container } = renderCard(makeChallenge());
        expect(badgeByText(container, '⚙️ app.customBadge')).toBeFalsy();
    });
});
