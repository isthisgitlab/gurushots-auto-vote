/**
 * Pinning a photo for Boost or Turbo from the challenge card, through the real hooks and the real EntryBadge:
 * the toggles per boost/turbo state, the write and its failure text, the note for a pin that no longer
 * applies, and the compact tile's pin glyph. `t(key)` returns the key (see tests/react setup).
 */

import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { buildChallenge } from '../helpers/challengeFixtures';
import type { Challenge } from '../../src/ts/types/gurushots';

const mockChallengeSettings = {
    hasCustomSettings: false,
    autoFillEnabled: false,
    isCompact: false,
    hasCompactOverride: false,
    toggleCompact: jest.fn(),
};
jest.mock('@/hooks/useChallengeSettings', () => ({ useChallengeSettings: () => mockChallengeSettings }));

const nowSec = () => Math.floor(Date.now() / 1000);

const makeChallenge = (member: Record<string, unknown> = {}, entries: Array<Record<string, unknown>> = []) =>
    buildChallenge({
        id: 101,
        title: 'Sunset',
        url: 'sunset',
        type: 'default',
        max_photo_submits: 3,
        start_time: nowSec() - 3600,
        close_time: nowSec() + 3600,
        entries: 1200,
        players: 50,
        votes: 2000,
        prizes_worth: '$100',
        tags: [],
        welcome_message: '',
        member: {
            boost: { state: 'AVAILABLE_KEY', timeout: 0 },
            turbo: { state: 'WON', time_to_open: null },
            ranking: {
                entries: entries.length
                    ? entries
                    : [
                          { id: 'e1', member_id: 'm', rank: 3, votes: 40 },
                          { id: 'e2', member_id: 'm', rank: 5, votes: 20 },
                      ],
                exposure: { exposure_factor: 80 },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
            ...member,
        },
    });

const renderCard = (challenge: Challenge) =>
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining="2h"
            timezone="local"
            autovoteRunning={false}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
            onCurrencySpent={jest.fn()}
        />,
    );

const pinButtons = (kind: 'Boost' | 'Turbo') =>
    screen.queryAllByRole('button', { name: new RegExp(`app\\.pinFor${kind}`) });

beforeEach(() => {
    mockChallengeSettings.isCompact = false;
    window.api.getSettingsSchema = jest.fn().mockResolvedValue({ schema: {}, defaults: {} });
    window.api.getEffectiveSetting = jest.fn().mockResolvedValue(null);
    window.api.getChallengeOverride = jest.fn().mockResolvedValue(null);
    window.api.getDeadlineActions = jest.fn().mockResolvedValue({ success: true, actions: [], boostBlocked: false });
    window.api.getSwapBacks = jest.fn().mockResolvedValue({ success: true, items: [] });
    window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: null, turbo: null });
    window.api.setEntryPin = jest.fn().mockResolvedValue({ success: true });
});

describe('pin toggles by boost / turbo state', () => {
    test.each([
        ['AVAILABLE', true],
        ['AVAILABLE_KEY', true],
        ['LOCKED', true],
        ['MISSED', true],
        ['USED', false],
        ['UNAVAILABLE', false],
    ])('Boost %s: toggles shown = %p', async (state, shown) => {
        renderCard(makeChallenge({ boost: { state, timeout: 0 } }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Boost')).toHaveLength(shown ? 2 : 0);
    });

    test.each([
        ['WON', true],
        ['FREE', true],
        ['TIMER', true],
        ['LOCKED', true],
        ['USED', false],
        ['UNAVAILABLE', false],
    ])('Turbo %s: toggles shown = %p', async (state, shown) => {
        renderCard(makeChallenge({ turbo: { state, time_to_open: null } }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Turbo')).toHaveLength(shown ? 2 : 0);
    });

    test('a feature already on an entry is spent: its toggles go, and the other feature’s stay off that photo', async () => {
        renderCard(
            makeChallenge({}, [
                { id: 'e1', member_id: 'm', rank: 3, votes: 40, boosted: true },
                { id: 'e2', member_id: 'm', rank: 5, votes: 20 },
            ]),
        );
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Boost')).toHaveLength(0);
        // Turbo can still fire, but not on the boosted photo.
        expect(pinButtons('Turbo')).toHaveLength(1);
    });
});

describe('pinning from the card', () => {
    test('pressing a toggle writes the pin for that entry, then shows it pressed', async () => {
        renderCard(makeChallenge());
        const [first] = pinButtons('Boost');
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalledTimes(1));
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'e1', turbo: null });
        fireEvent.click(first);
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledWith('boost', 101, 'e1'));
        await waitFor(() => expect(pinButtons('Boost')[0].getAttribute('aria-pressed')).toBe('true'));
        expect(pinButtons('Boost')[1].getAttribute('aria-pressed')).toBe('false');
    });

    test('pressing a pressed toggle clears the pin', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: null, turbo: 'e2' });
        renderCard(makeChallenge());
        await waitFor(() => expect(pinButtons('Turbo')[1].getAttribute('aria-pressed')).toBe('true'));
        fireEvent.click(pinButtons('Turbo')[1]);
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledWith('turbo', 101, null));
    });

    test('a failed write says so with fixed translated text, until dismissed', async () => {
        window.api.setEntryPin = jest.fn().mockResolvedValue({ success: false, error: 'The pin could not be saved' });
        renderCard(makeChallenge());
        fireEvent.click(pinButtons('Boost')[0]);
        expect(await screen.findByText('errors.pinFailed')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByText('errors.pinFailed')).toBeNull();
    });
});

describe('a stored pin that no longer applies', () => {
    test('a photo that left the challenge gets a note with a clear button', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'gone', turbo: null });
        renderCard(makeChallenge());
        expect(await screen.findByText('app.pinGoneNote')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'app.pinClear' }));
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledWith('boost', 101, null));
    });

    test('a photo that carries the other feature gets the conflict note', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: null, turbo: 'e1' });
        renderCard(
            makeChallenge({}, [
                { id: 'e1', member_id: 'm', rank: 3, votes: 40, boosted: true },
                { id: 'e2', member_id: 'm', rank: 5, votes: 20 },
            ]),
        );
        expect(await screen.findByText('app.pinConflictNote')).not.toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'app.pinClear' }));
        await waitFor(() => expect(window.api.setEntryPin).toHaveBeenCalledWith('turbo', 101, null));
    });

    test('no note once the feature is spent, or while the pin is usable', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'gone', turbo: 'e2' });
        renderCard(makeChallenge({ boost: { state: 'USED', timeout: 0 } }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinGoneNote')).toBeNull();
        expect(screen.queryByText('app.pinConflictNote')).toBeNull();
    });
});

describe('the compact tile', () => {
    beforeEach(() => {
        mockChallengeSettings.isCompact = true;
    });

    test.each([
        ['boost', '🚀📌', 'app.pinnedForBoost'],
        ['turbo', '⚡📌', 'app.pinnedForTurbo'],
    ] as const)('marks the entry pinned for %s with a glyph and screen-reader text', async (kind, glyph, text) => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: null, turbo: null, [kind]: 'e2' });
        renderCard(makeChallenge());
        expect(await screen.findByText(text)).not.toBeNull();
        expect(screen.getByText(glyph)).not.toBeNull();
        expect(screen.getByText(text).className).toContain('sr-only');
    });

    test('shows no pin mark without a pin, or once the pinned feature is spent', async () => {
        renderCard(makeChallenge());
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinnedForBoost')).toBeNull();
    });

    test('a spent feature’s pin shows nothing', async () => {
        window.api.getEntryPins = jest.fn().mockResolvedValue({ boost: 'e1', turbo: null });
        renderCard(makeChallenge({ boost: { state: 'USED', timeout: 0 } }));
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(screen.queryByText('app.pinnedForBoost')).toBeNull();
    });

    test('has no toggles: pinning stays in the detailed card', async () => {
        renderCard(makeChallenge());
        await waitFor(() => expect(window.api.getEntryPins).toHaveBeenCalled());
        expect(pinButtons('Boost')).toHaveLength(0);
    });
});
