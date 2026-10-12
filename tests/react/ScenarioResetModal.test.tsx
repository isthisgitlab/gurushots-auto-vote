/**
 * The dialog that resets a challenge's scenario progress: what it says, the call it makes (one challenge's, or
 * every challenge's when the saved progress cannot be read), and what it answers when the reset cannot be made.
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { ScenarioResetModal } from '@/components/app/ScenarioResetModal';
import { invalid } from '../helpers/invalid';

type ResetAnswer = { success: true } | { success: false; error: string };

const challenge = { id: 101, title: 'Sunset' };

const open = (props: { everyChallenge?: boolean; challenge?: typeof challenge | null } = {}) => {
    const handlers = { onClose: jest.fn(), onReset: jest.fn() };
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
        const { onClose, onReset } = open();
        expect(screen.getByText('app.scenarioResetBody')).toBeTruthy();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
        expect(window.api.resetScenarioState).toHaveBeenCalledWith(101);
        expect(window.api.resetAllScenarioState).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('an unreadable file is reset for every challenge, and the dialog says that first', async () => {
        answers({ success: true });
        const { onReset } = open({ everyChallenge: true });
        expect(screen.getByText('app.scenarioResetAllBody')).toBeTruthy();
        expect(screen.queryByText('app.scenarioResetBody')).toBeNull();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
        expect(window.api.resetAllScenarioState).toHaveBeenCalledTimes(1);
        expect(window.api.resetScenarioState).not.toHaveBeenCalled();
    });

    test.each([
        [{ success: false, error: 'busy' } as const, 'app.scenarioResetBusy'],
        [{ success: false, error: 'state-unreadable' } as const, 'app.scenarioResetUnreadable'],
        [{ success: false, error: 'something else' } as const, 'app.scenarioResetFailed'],
        [null, 'app.scenarioResetFailed'],
    ])('an answer of %p keeps the dialog open and says why, changing nothing', async (answer, key) => {
        answers(answer);
        const { onClose, onReset } = open();
        fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
        const problem = await screen.findByText(key);
        expect(problem.getAttribute('role')).toBe('alert');
        expect(onReset).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
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
