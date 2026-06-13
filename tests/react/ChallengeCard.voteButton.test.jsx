/**
 * Tests for ChallengeCard's manual "Vote" button visibility.
 *
 * The manual vote button drives a vote-to-100% override (voteOnChallengeManual),
 * and must stay available even while the scheduled autovote loop is running so a
 * single challenge can be pushed to 100% without stopping the bot first. It is
 * gated only on "challenge started" and "exposure < 100%".
 *
 * VoteButton is mocked to a recognizable element so visibility can be asserted
 * without exercising its IPC; the other child buttons/hooks are stubbed the same
 * way the badges test does. Mock state object names start with "mock" for jest
 * hoisting.
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
jest.mock('@/components/app/VoteButton', () => ({
    VoteButton: () => <button data-testid="vote-button">vote</button>,
}));
jest.mock('@/components/app/RunButton', () => ({ RunButton: () => null }));
jest.mock('@/components/app/EntryBadge', () => ({ EntryBadge: () => null }));

const makeChallenge = ({ exposure = 50, started = true } = {}) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
        id: 101,
        title: 'Sunset',
        url: 'sunset',
        type: undefined,
        max_photo_submits: 1,
        start_time: started ? nowSec - 3600 : nowSec + 3600,
        close_time: nowSec + 3600,
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
                entries: [],
                exposure: { exposure_factor: exposure },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
        },
    };
};

const renderCard = (challenge, autovoteRunning) =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining="2h 30m"
            timezone="local"
            autovoteRunning={autovoteRunning}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
        />,
    );

beforeEach(() => {
    Object.assign(mockChallengeSettings, {
        hasCustomSettings: false,
        autoFillEnabled: false,
        isCompact: false,
        hasCompactOverride: false,
        toggleCompact: jest.fn(),
    });
});

describe('ChallengeCard manual vote button visibility', () => {
    test('shows while autovote is running (started, exposure < 100%)', () => {
        const { queryByTestId } = renderCard(makeChallenge({ exposure: 50 }), true);
        expect(queryByTestId('vote-button')).toBeTruthy();
    });

    test('shows while autovote is stopped (started, exposure < 100%)', () => {
        const { queryByTestId } = renderCard(makeChallenge({ exposure: 50 }), false);
        expect(queryByTestId('vote-button')).toBeTruthy();
    });

    test('shows at 99% exposure (boundary — still below 100%)', () => {
        const { queryByTestId } = renderCard(makeChallenge({ exposure: 99 }), true);
        expect(queryByTestId('vote-button')).toBeTruthy();
    });

    test('hidden at 100% exposure even while autovote is running', () => {
        const { queryByTestId } = renderCard(makeChallenge({ exposure: 100 }), true);
        expect(queryByTestId('vote-button')).toBeNull();
    });

    test('hidden before the challenge starts even while autovote is running', () => {
        const { queryByTestId } = renderCard(makeChallenge({ exposure: 50, started: false }), true);
        expect(queryByTestId('vote-button')).toBeNull();
    });
});
