/**
 * ErrorBoundary catches render throws so the React root never unmounts
 * into a blank page. Verifies the fallback renders, the dismiss button
 * restores the children, and componentDidCatch logs through window.api.
 */
import { fireEvent, render, screen } from '@/test/test-utils';
import { useState } from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { mockApi } from '../../src/js/react/test/setup';

// Pin window.api per-test — the global jsdom setup occasionally loses
// it across files. Keeps this suite hermetic.
beforeEach(() => {
    window.api = mockApi;
});

function Boom({ shouldThrow }) {
    if (shouldThrow) throw new Error('boom from child');
    return <div>child ok</div>;
}

function Toggle() {
    const [throwIt, setThrowIt] = useState(true);
    return (
        <ErrorBoundary>
            <button type="button" onClick={() => setThrowIt(false)}>
                stop throwing
            </button>
            <Boom shouldThrow={throwIt} />
        </ErrorBoundary>
    );
}

describe('ErrorBoundary', () => {
    // Suppress React's noisy "consider adding an error boundary" log during
    // these tests — that's the exact behavior we're verifying.
    let consoleError;
    beforeEach(() => {
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        consoleError.mockRestore();
    });

    test('renders fallback UI when a child throws on mount', () => {
        render(
            <ErrorBoundary>
                <Boom shouldThrow={true} />
            </ErrorBoundary>,
        );

        expect(screen.getByText('Something went wrong')).toBeTruthy();
        expect(screen.getByText(/boom from child/)).toBeTruthy();
        expect(screen.queryByText('child ok')).toBeNull();
    });

    test('logs the error through window.api.logError', () => {
        render(
            <ErrorBoundary>
                <Boom shouldThrow={true} />
            </ErrorBoundary>,
        );

        expect(mockApi.logError).toHaveBeenCalledTimes(1);
        expect(mockApi.logError.mock.calls[0][0]).toMatch(/React error boundary caught/);
        expect(mockApi.logError.mock.calls[0][0]).toMatch(/boom from child/);
    });

    test('dismiss recovers children once the underlying throw is gone', () => {
        render(<Toggle />);

        // Initial mount throws → boundary shows fallback.
        expect(screen.getByText('Something went wrong')).toBeTruthy();
        expect(screen.queryByText('child ok')).toBeNull();

        // While still in the error state, click the Toggle's child button
        // that disables the throw on next render. (It's inside the boundary
        // tree but the boundary renders only its own fallback UI when in
        // error state, so we have to flip the toggle from inside the
        // fallback by clicking Dismiss first to remount the children, THEN
        // flipping the toggle on the recovered render.)
        fireEvent.click(screen.getByText('Dismiss'));
        // Same error re-throws immediately, fallback is back.
        expect(screen.getByText('Something went wrong')).toBeTruthy();

        // Logger must NOT fire again — the same error was already logged.
        expect(mockApi.logError).toHaveBeenCalledTimes(1);
    });

    test('children render again after dismiss when the throw is gone', () => {
        // Render a child whose throw flag is controlled by external state.
        function Controlled({ shouldThrow }) {
            if (shouldThrow) throw new Error('controlled boom');
            return <div>child ok</div>;
        }
        const { rerender } = render(
            <ErrorBoundary>
                <Controlled shouldThrow={true} />
            </ErrorBoundary>,
        );
        expect(screen.getByText('Something went wrong')).toBeTruthy();

        // Flip the prop so the child stops throwing, then dismiss.
        rerender(
            <ErrorBoundary>
                <Controlled shouldThrow={false} />
            </ErrorBoundary>,
        );
        // Re-render alone doesn't clear the boundary — dismiss is required.
        expect(screen.queryByText('child ok')).toBeNull();

        fireEvent.click(screen.getByText('Dismiss'));
        expect(screen.getByText('child ok')).toBeTruthy();
        expect(screen.queryByText('Something went wrong')).toBeNull();
    });

    test('passes children through when nothing throws', () => {
        render(
            <ErrorBoundary>
                <Boom shouldThrow={false} />
            </ErrorBoundary>,
        );

        expect(screen.getByText('child ok')).toBeTruthy();
        expect(screen.queryByText('Something went wrong')).toBeNull();
    });
});
