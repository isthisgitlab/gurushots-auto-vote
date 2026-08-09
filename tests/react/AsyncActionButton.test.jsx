/**
 * Tests for the shared AsyncActionButton (components/ui/AsyncActionButton)
 * — the loading/success/logError envelope extracted from VoteButton,
 * RunButton, and the Vote All / Run buttons.
 */

import { render, fireEvent, waitFor, screen } from './helpers/test-utils';
import { AsyncActionButton } from '@/components/ui/AsyncActionButton';

const renderButton = (over = {}) => {
    const props = {
        className: 'btn btn-latvian btn-sm',
        action: jest.fn().mockResolvedValue({ success: true }),
        onSuccess: jest.fn(),
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
        const button = container.querySelector('button');
        expect(button.className).toBe('btn btn-latvian btn-sm');
        expect(button.getAttribute('title')).toBe('tip');
        expect(button.textContent).toBe('go');
        expect(button.disabled).toBe(false);
    });

    test('shows the loading label and disables while the action is pending, then calls onSuccess', async () => {
        let resolve;
        const action = jest.fn(() => new Promise((r) => (resolve = r)));
        const { props, container } = renderButton({ action });

        const button = container.querySelector('button');
        fireEvent.click(button);

        await waitFor(() => expect(button.disabled).toBe(true));
        expect(button.textContent).toContain('busy…');
        expect(button.querySelector('.loading.loading-spinner')).not.toBeNull();

        resolve({ success: true });
        await waitFor(() => expect(button.disabled).toBe(false));
        expect(props.onSuccess).toHaveBeenCalledTimes(1);
        expect(window.api.logError).not.toHaveBeenCalled();
    });

    test('logs an unsuccessful result with the failure prefix and skips onSuccess', async () => {
        const { props, container } = renderButton({
            action: jest.fn().mockResolvedValue({ success: false, error: 'nope' }),
        });

        fireEvent.click(container.querySelector('button'));

        await waitFor(() => expect(window.api.logError).toHaveBeenCalledWith('Voting failed: nope'));
        expect(props.onSuccess).not.toHaveBeenCalled();
    });

    test('logs a thrown error with the error prefix', async () => {
        const { container } = renderButton({ action: jest.fn().mockRejectedValue(new Error('boom')) });

        fireEvent.click(container.querySelector('button'));

        await waitFor(() => expect(window.api.logError).toHaveBeenCalledWith('Error voting on challenge: boom'));
        expect(screen.getByText('go')).toBeTruthy(); // back to idle
    });

    test('external disabled keeps the button inert', () => {
        const { props, container } = renderButton({ disabled: true });
        const button = container.querySelector('button');
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
        expect(props.action).not.toHaveBeenCalled();
    });
});
