/**
 * Smoke test for the jsdom Jest project.
 *
 * Goal: prove the React testing pipeline is wired up end-to-end —
 * jest-environment-jsdom resolves, the @swc/jest JSX transform runs,
 * the @/ moduleNameMapper resolves, the customRender wrapper supplies
 * TranslationProvider, and a basic component renders without errors.
 *
 * Deeper component behavior (boost+turbo state, error timers, in-flight
 * disable) lives in EntryBadge.test.jsx — this file just validates the
 * pipeline.
 */

import { render, screen } from '@/test/test-utils';
import { EntryBadge } from '@/components/app/EntryBadge';

// useBoost and useTurbo each call window.api.applyBoost / applyTurbo /
// playAutoTurbo, but those names don't match the renderer-side mockApi
// (which uses applyBoostToEntry). Mock the hooks directly to keep this
// smoke test independent of that surface.
jest.mock('@/api/useBoost', () => ({
    useBoost: () => ({ applyBoost: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => ({ applyTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));

describe('EntryBadge — smoke', () => {
    test('renders rank and vote count from the entry', () => {
        render(
            <EntryBadge
                entry={{ id: 'e1', rank: 3, votes: 42, boosted: false, turbo: false }}
                challengeId={777}
                boostAvailable={false}
                turboAvailable={false}
            />,
        );
        // Translation keys come through as the keys themselves in tests
        // (mockTranslationManager.t returns the key), so we assert on the
        // rank and vote numbers which are stable values.
        expect(screen.getByText(/app\.rank/)).toBeTruthy();
        expect(screen.getByText(/3.*42.*app\.votes/)).toBeTruthy();
    });
});
