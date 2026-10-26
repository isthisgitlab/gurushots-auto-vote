/**
 * Tests for the shared AsyncActionButton (components/ui/AsyncActionButton)
 * — the loading/success/logError envelope used by VoteButton,
 * RunButton, and the Vote All / Run buttons.
 */

import { render, fireEvent, waitFor, screen } from './helpers/test-utils';
import { AsyncActionButton } from '@/components/ui/AsyncActionButton';

const renderButton = (over = {}) => {
    const props = {
        className: 'btn btn-latvian btn-sm',
        action: jest.fn().mockResolvedValue({ success: true }),
        onSuccess: jest.fn(),
        onError: jest.fn(),
        failureLogPrefix: 'Voting failed',
        errorLogPrefix: 'Error voting on challenge',
        loadingLabel: 'busy…',
        idleContent: 'go',
        ...over,
    };
    const utils = render(<AsyncActionButton {...props} />);
    return { props, ...utils };
};

describe('AsyncActionButton', () => {
    beforeEach(() => {
        window.api = { ...window.api, logError: jest.fn().mockResolvedValue(undefined) };
    });

    test('renders idle content with the given classes and title', () => {
        const { container } = renderButton({ title: 'tip' });
        const button = container.querySelector('button')!;
        expect(button.className).toBe('btn btn-latvian btn-sm');
        expect(button.getAttribute('title')).toBe('tip');
        expect(button.textContent).toBe('go');
        expect(button.disabled).toBe(false);
    });

    test('shows the loading label and disables while the action is pending, then calls onSuccess', async () => {
        let resolve: ((value: unknown) => void) | undefined;
        const action = jest.fn(() => new Promise((r) => (resolve = r)));
        const { props, container } = renderButton({ action });

        const button = container.querySelector('button')!;
        fireEvent.click(button);

        await waitFor(() => expect(button.disabled).toBe(true));
        expect(button.textContent).toContain('busy…');
        expect(button.querySelector('.loading.loading-spinner')).not.toBeNull();

        resolve!({ success: true });
        await waitFor(() => expect(button.disabled).toBe(false));
        expect(props.onSuccess).toHaveBeenCalledTimes(1);
        expect(window.api.logError).not.toHaveBeenCalled();
    });

    test('logs an unsuccessful result with the failure prefix and skips onSuccess', async () => {
        const { props, container } = renderButton({
            action: jest.fn().mockResolvedValue({ success: false, error: 'nope' }),
        });

        fireEvent.click(container.querySelector('button')!);

        await waitFor(() => expect(window.api.logError).toHaveBeenCalledWith('Voting failed: nope'));
        expect(props.onSuccess).not.toHaveBeenCalled();
    });

    test.each([
        [new Error('boom'), 'Error voting on challenge: boom'],
        [null, 'Error voting on challenge: null'],
    ])('logs a thrown %p with the error prefix', async (thrown, logged) => {
        const { container } = renderButton({ action: jest.fn().mockRejectedValue(thrown) });

        fireEvent.click(container.querySelector('button')!);

        await waitFor(() => expect(window.api.logError).toHaveBeenCalledWith(logged));
        expect(screen.getByText('go')).toBeTruthy(); // back to idle
    });

    test('tells the caller nothing on a press that succeeds, apart from clearing the last message', async () => {
        const { props, container } = renderButton();
        fireEvent.click(container.querySelector('button')!);
        await waitFor(() => expect(props.onSuccess).toHaveBeenCalled());
        expect(props.onError.mock.calls).toEqual([[null]]);
    });

    test('an unsuccessful result is reported as translated text, never the handler wording', async () => {
        const { props, container } = renderButton({
            action: jest.fn().mockResolvedValue({ success: false, error: 'Challenge no longer active' }),
        });
        fireEvent.click(container.querySelector('button')!);
        await waitFor(() => expect(props.onError).toHaveBeenLastCalledWith('errors.challengeNoLongerActive'));
        expect(props.onError.mock.calls[0]).toEqual([null]);
    });

    test.each([
        // The per-card Run refuses a marked challenge with the fixed code; the single-challenge
        // vote answers with manualVote's log wording. Both word as the same data-cannot-be-read text.
        ['challenge-data-incomplete'],
        ['challenge data cannot be read'],
    ])('a %s refusal is worded as the data-cannot-be-read text', async (error) => {
        const { props, container } = renderButton({
            action: jest.fn().mockResolvedValue({ success: false, error }),
        });
        fireEvent.click(container.querySelector('button')!);
        await waitFor(() => expect(props.onError).toHaveBeenLastCalledWith('errors.challengeDataIncomplete'));
    });

    test.each([
        ['an error the app has no wording for', { success: false, error: 'boom: ECONNRESET' }],
        ['a result without an error', { success: false }],
        ['no result at all', undefined],
    ])('%s is reported as the generic failure text', async (_label, result) => {
        const { props, container } = renderButton({ action: jest.fn().mockResolvedValue(result) });
        fireEvent.click(container.querySelector('button')!);
        await waitFor(() => expect(props.onError).toHaveBeenLastCalledWith('errors.actionFailed'));
    });

    test('a thrown action is reported as the generic failure text, with the raw reason only in the log', async () => {
        const { props, container } = renderButton({ action: jest.fn().mockRejectedValue(new Error('socket hang up')) });
        fireEvent.click(container.querySelector('button')!);
        await waitFor(() => expect(props.onError).toHaveBeenLastCalledWith('errors.actionFailed'));
        expect(window.api.logError).toHaveBeenCalledWith('Error voting on challenge: socket hang up');
        expect(props.onError).not.toHaveBeenCalledWith(expect.stringContaining('socket'));
    });

    test('an onSuccess that throws after the action landed is logged, not reported as a failure', async () => {
        const { props, container } = renderButton({
            onSuccess: jest.fn().mockRejectedValue(new Error('refetch failed')),
        });
        const button = container.querySelector('button')!;
        fireEvent.click(button);

        await waitFor(() =>
            expect(window.api.logError).toHaveBeenCalledWith('Error voting on challenge: refetch failed'),
        );
        expect(props.onError.mock.calls).toEqual([[null]]);
        await waitFor(() => expect(button.disabled).toBe(false));
    });

    test('the next press clears the last message first', async () => {
        const action = jest
            .fn()
            .mockResolvedValueOnce({ success: false, error: 'nope' })
            .mockResolvedValueOnce({ success: true });
        const { props, container } = renderButton({ action });
        const button = container.querySelector('button')!;

        fireEvent.click(button);
        await waitFor(() => expect(props.onError).toHaveBeenLastCalledWith('errors.actionFailed'));
        await waitFor(() => expect(button.disabled).toBe(false));
        fireEvent.click(button);
        await waitFor(() => expect(props.onSuccess).toHaveBeenCalled());

        expect(props.onError.mock.calls).toEqual([[null], ['errors.actionFailed'], [null]]);
    });

    test('external disabled keeps the button inert', () => {
        const { props, container } = renderButton({ disabled: true });
        const button = container.querySelector('button')!;
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
        expect(props.action).not.toHaveBeenCalled();
    });
});
