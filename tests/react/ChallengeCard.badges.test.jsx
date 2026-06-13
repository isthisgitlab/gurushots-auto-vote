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
 * can drive hasCustomSettings / autoFillEnabled directly; the child buttons
 * and EntryBadge are mocked to null so `span.badge` resolves to the top row
 * only. `t(key)` returns the key (see tests/react setup), so labels assert as
 * 'app.*' strings. Mock state object names start with "mock" for jest hoisting.
 */

import { render } from '@/test/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';

const mockChallengeSettings = {
    hasCustomSettings: false,
    autoFillEnabled: false,
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

const makeChallenge = ({ type = 'flash', badge, maxPhotos = 4, entriesCount = 0 } = {}) => ({
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

const renderCard = (challenge) =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining="2h 30m"
            timezone="local"
            autovoteRunning={false}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
        />,
    );

// Find a top-row badge by its exact (icon + text) content.
const badgeByText = (container, text) =>
    [...container.querySelectorAll('span.badge')].find((el) => el.textContent === text);

beforeEach(() => {
    Object.assign(mockChallengeSettings, {
        hasCustomSettings: false,
        autoFillEnabled: false,
        isCompact: false,
        hasCompactOverride: false,
        toggleCompact: jest.fn(),
    });
});

describe('ChallengeCard badge row — logical/state badges', () => {
    test('type, photo-count and auto-fill all render icon + text with solid colors', () => {
        mockChallengeSettings.autoFillEnabled = true;
        const { container } = renderCard(makeChallenge());

        const type = badgeByText(container, '🏁 FLASH');
        expect(type).toBeTruthy();
        expect(type.className).toMatch(/badge-warning/);

        const photos = badgeByText(container, '🖼 4 app.photos');
        expect(photos).toBeTruthy();
        expect(photos.className).toMatch(/badge-warning/);

        const autoFill = badgeByText(container, '📥 app.autoFillBadge');
        expect(autoFill).toBeTruthy();
        expect(autoFill.className).toMatch(/badge-success/);
    });

    test('badge fallback (no type) also gets the icon and the info variant', () => {
        const { container } = renderCard(makeChallenge({ type: null, badge: 'Special' }));
        const fallback = badgeByText(container, '🏁 Special');
        expect(fallback).toBeTruthy();
        expect(fallback.className).toMatch(/badge-info/);
    });

    test('auto-fill badge is hidden once all slots are filled', () => {
        mockChallengeSettings.autoFillEnabled = true;
        const { container } = renderCard(makeChallenge({ maxPhotos: 4, entriesCount: 4 }));
        expect(badgeByText(container, '📥 app.autoFillBadge')).toBeFalsy();
    });

    test('photo-count badge is hidden for single-submission challenges', () => {
        const { container } = renderCard(makeChallenge({ maxPhotos: 1 }));
        expect(badgeByText(container, '🖼 1 app.photos')).toBeFalsy();
    });
});

describe('ChallengeCard badge row — override/config badge', () => {
    test('renders icon + translated label in the muted ghost style, distinct from state badges', () => {
        mockChallengeSettings.hasCustomSettings = true;
        mockChallengeSettings.autoFillEnabled = true;
        const { container } = renderCard(makeChallenge());

        const custom = badgeByText(container, '⚙️ app.customBadge');
        expect(custom).toBeTruthy();
        expect(custom.className).toMatch(/badge-ghost/);
        // The "out of logic" confusion was the override badge looking like a
        // state badge — it must not share the auto-fill (success) styling.
        expect(custom.className).not.toMatch(/badge-success/);

        const autoFill = badgeByText(container, '📥 app.autoFillBadge');
        expect(autoFill.className).not.toMatch(/badge-ghost/);
    });

    test('the override badge meaning is visible text, not hidden in a tooltip', () => {
        mockChallengeSettings.hasCustomSettings = true;
        const { container } = renderCard(makeChallenge());
        const custom = badgeByText(container, '⚙️ app.customBadge');
        // The label is on-screen; no info is hidden behind a hover tooltip.
        expect(custom.hasAttribute('title')).toBe(false);
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
