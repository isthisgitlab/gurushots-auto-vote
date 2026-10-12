/**
 * The dialog that resets a challenge's scenario progress: what it says, the call it makes (one challenge's, or
 * every challenge's when the saved progress cannot be read), and what it answers when the reset cannot be made.
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { ScenarioResetModal } from '@/components/app/ScenarioResetModal';
import { invalid } from '../helpers/invalid';
import { mockTranslator } from './helpers/setup';

type ResetAnswer = { success: true } | { success: false; error: string };

const challenge = { id: 101, title: 'Sunset', url: 'sunset' };

const open = (props: { everyChallenge?: boolean; challenge?: typeof challenge | null } = {}) => {
    const handlers = { onClose: jest.fn(), onChanged: jest.fn() };
    const utils = render(
        <ScenarioResetModal
            challenge={'challenge' in props ? (props.challenge ?? null) : challenge}
            everyChallenge={props.everyChallenge ?? false}
            {...handlers}
        />,
    );
    return { ...utils, ...handlers };
};

const answers = (answer: ResetAnswer | null) => {
    window.api.resetScenarioState = jest.fn().mockResolvedValue(invalid(answer));
    window.api.resetAllScenarioState = jest.fn().mockResolvedValue(invalid(answer));
};

describe('ScenarioResetModal', () => {
    test('stays closed without a challenge', () => {
        open({ challenge: null });
        expect(screen.queryByText('app.scenarioResetTitle')).toBeNull();
    });

    test('resets the one challenge, then says so and closes', async () => {
        answers({ success: true });
        const { onClose, onChanged } = open();
        expect(screen.getByText('app.scenarioResetBody')).toBeTruthy();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
        expect(window.api.resetScenarioState).toHaveBeenCalledWith(101);
        expect(window.api.resetAllScenarioState).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('an unreadable file is reset for every challenge, and the dialog says that first', async () => {
        answers({ success: true });
        const { onChanged } = open({ everyChallenge: true });
        expect(screen.getByText('app.scenarioResetAllBody')).toBeTruthy();
        expect(screen.queryByText('app.scenarioResetBody')).toBeNull();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
        // Asked for only while the progress cannot be read: one that reads again is not wiped.
        expect(window.api.resetAllScenarioState).toHaveBeenCalledWith(true);
        expect(window.api.resetScenarioState).not.toHaveBeenCalled();
    });

    test.each([
        [{ success: false, error: 'busy' } as const, false, 'app.scenarioResetBusy'],
        [{ success: false, error: 'busy' } as const, true, 'app.scenarioResetAllBusy'],
        [{ success: false, error: 'locks-unavailable' } as const, false, 'app.locksUnavailable'],
        [{ success: false, error: 'locks-unavailable' } as const, true, 'app.locksUnavailable'],
        [{ success: false, error: 'not-saved' } as const, false, 'app.scenarioResetNotSaved'],
        [{ success: false, error: 'not-saved' } as const, true, 'app.scenarioResetAllNotSaved'],
        [{ success: false, error: 'something else' } as const, false, 'app.scenarioResetFailed'],
        [{ success: false, error: 'something else' } as const, true, 'app.scenarioResetAllFailed'],
        [null, false, 'app.scenarioResetFailed'],
    ])(
        'an answer of %p (every challenge: %s) keeps the dialog open and says why, changing nothing',
        async (answer, all, key) => {
            answers(answer);
            const { onClose, onChanged } = open({ everyChallenge: all });
            fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
            const problem = await screen.findByText(key);
            expect(problem.getAttribute('role')).toBe('alert');
            expect(onChanged).not.toHaveBeenCalled();
            expect(onClose).not.toHaveBeenCalled();
        },
    );

    test('progress that turned out unreadable: the dialog says so, and the card is told to read its status again', async () => {
        answers({ success: false, error: 'state-unreadable' });
        const { onClose, onChanged } = open();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        expect((await screen.findByText('app.scenarioResetUnreadable')).getAttribute('role')).toBe('alert');
        expect(onChanged).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    test.each([
        ['state-readable', 'app.scenarioResetReadable', true],
        ['state-unloaded', 'app.scenarioResetUnloaded', false],
    ])('%s: the dialog says nothing was reset, and the card reads its status again', async (error, key, all) => {
        answers({ success: false, error });
        const { onClose, onChanged } = open({ everyChallenge: all });
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        expect((await screen.findByText(key)).getAttribute('role')).toBe('alert');
        expect(onChanged).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    test('a challenge with no title is named by its address', () => {
        mockTranslator.t.mockImplementation((key) => (key === 'app.scenarioResetBody' ? 'Resets “{title}”' : key));
        try {
            open({ challenge: { ...challenge, title: '' } });
            expect(screen.getByText('Resets “sunset”')).toBeTruthy();
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('a call that fails outright reads as the general problem, and the next attempt clears it while it is out', async () => {
        window.api.resetScenarioState = jest.fn().mockRejectedValueOnce(new Error('ipc down'));
        open();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await screen.findByText('app.scenarioResetFailed');
        let answer!: (value: ResetAnswer) => void;
        window.api.resetScenarioState = jest.fn().mockImplementationOnce(() => new Promise((r) => (answer = r)));
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await screen.findByText('app.scenarioResetWorking');
        expect(screen.queryByText('app.scenarioResetFailed')).toBeNull();
        // Still focusable while it is out, and a second press does nothing; nor can it be cancelled or dismissed.
        const working = screen.getByText<HTMLButtonElement>('app.scenarioResetWorking');
        expect(working.disabled).toBe(false);
        expect(working.getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(working);
        expect(window.api.resetScenarioState).toHaveBeenCalledTimes(1);
        expect(screen.getByText<HTMLButtonElement>('app.cancel').disabled).toBe(true);
        await act(async () => answer({ success: true }));
    });
});
