/**
 * Fallback / default paths of the shared UI primitives in components/ui that
 * the per-component suites don't reach: unknown size/variant props, the
 * focus-trap edges of Modal, and ErrorBoundary's odd-error handling.
 */
import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { LoadingSpinner, PageLoader, InlineLoader, BusyContent } from '@/components/ui/LoadingSpinner';
import { LEVEL_BADGE_CLASS } from '@/utils/levelBadge';
import { PulseDot } from '@/components/ui/PulseDot';
import { StatusBadge, ConnectionBadge } from '@/components/ui/StatusBadge';
import { Modal, ModalActions } from '@/components/ui/Modal';
import { AsyncActionButton } from '@/components/ui/AsyncActionButton';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { StrokeIcon, ICON_PATHS } from '@/components/ui/StrokeIcon';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

type LogErrorMock = jest.MockedFunction<Window['api']['logError']>;

beforeEach(() => {
    window.api = invalid(mockApi);
    jest.clearAllMocks();
});

describe('LoadingSpinner', () => {
    test('defaults to a medium spinner', () => {
        const { container } = render(<LoadingSpinner />);
        expect(container.querySelector('span')!.className).toBe('loading loading-spinner loading-md ');
    });

    test('an unknown size falls back to md; className is appended', () => {
        const { container } = render(<LoadingSpinner size={invalid('huge')} className="ml-2" />);
        const span = container.querySelector('span')!;
        expect(span.className).toBe('loading loading-spinner loading-md ml-2');
        expect(span.getAttribute('role')).toBe('status');
        expect(span.getAttribute('aria-label')).toBe('common.loading');
    });

    test('a decorative spinner is hidden from assistive tech and has no role', () => {
        const { container } = render(<LoadingSpinner size="xs" decorative />);
        const span = container.querySelector('span')!;
        expect(span.getAttribute('aria-hidden')).toBe('true');
        expect(span.hasAttribute('role')).toBe(false);
        expect(span.hasAttribute('aria-label')).toBe(false);
    });

    test('PageLoader with text hides its spinner so the caption is announced once', () => {
        const { container } = render(<PageLoader text="Loading app" />);
        expect(container.querySelector('.loading')!.getAttribute('aria-hidden')).toBe('true');
        expect(screen.getByRole('status').textContent).toBe('Loading app');
    });

    test('PageLoader renders a large spinner with optional text', () => {
        const { container, rerender } = render(<PageLoader text="Loading app" />);
        expect(container.querySelector('.loading-lg')).not.toBeNull();
        expect(screen.getByText('Loading app')).toBeTruthy();
        rerender(<PageLoader />);
        expect(container.querySelector('.mt-4')).toBeNull();
    });

    test('InlineLoader renders a small spinner with optional text', () => {
        const { container } = render(<InlineLoader text="Fetching" />);
        expect(container.querySelector('.loading-sm')).not.toBeNull();
        expect(screen.getByText('Fetching')).toBeTruthy();
    });
});

describe('BusyContent', () => {
    test('idle shows the children, or the label when there are none', () => {
        const { container, rerender } = render(<BusyContent busy={false} label="Boost" />);
        expect(container.textContent).toBe('Boost');
        rerender(
            <BusyContent busy={false} label="Boost">
                🚀 Boost
            </BusyContent>,
        );
        expect(container.textContent).toBe('🚀 Boost');
    });

    test('busy keeps the label for assistive tech behind a decorative spinner', () => {
        const { container } = render(<BusyContent busy label="Boost" />);
        expect(container.querySelector('.loading')!.getAttribute('aria-hidden')).toBe('true');
        expect(container.querySelector('.sr-only')!.textContent).toBe('Boost');
    });
});

describe('PulseDot', () => {
    test('defaults to a pinging info dot of medium size', () => {
        const { container } = render(<PulseDot />);
        expect(container.querySelector('[data-testid="pulse-dot-info"]')).not.toBeNull();
        const dots = container.querySelectorAll('.status');
        expect(dots).toHaveLength(2);
        expect(dots[0].className).toBe(
            'status status-md status-info motion-safe:animate-[ping_1s_cubic-bezier(0,0,0.2,1)_3]',
        );
    });

    test('an unknown variant falls back to the info colour; pulse=false drops the halo', () => {
        const { container } = render(<PulseDot variant={invalid('purple')} pulse={false} size="status-xs" />);
        const dots = container.querySelectorAll('.status');
        expect(dots).toHaveLength(1);
        expect(dots[0].className).toBe('status status-xs status-info');
    });

    describe('when the page comes back into view', () => {
        afterEach(() => jest.restoreAllMocks());

        const fireVisibilityChange = (state: DocumentVisibilityState) => {
            jest.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
            act(() => {
                document.dispatchEvent(new Event('visibilitychange'));
            });
        };

        test('a visible page restarts the halo as a fresh element', () => {
            const { container } = render(<PulseDot />);
            const halo = container.querySelectorAll('.status')[0];
            fireVisibilityChange('visible');
            const replayed = container.querySelectorAll('.status')[0];
            expect(replayed).not.toBe(halo);
            expect(replayed.className).toBe(halo.className);
            expect(container.querySelectorAll('.status')).toHaveLength(2);
        });

        test('a focused window restarts the halo as a fresh element', () => {
            const { container } = render(<PulseDot />);
            const halo = container.querySelectorAll('.status')[0];
            act(() => {
                window.dispatchEvent(new Event('focus'));
            });
            const replayed = container.querySelectorAll('.status')[0];
            expect(replayed).not.toBe(halo);
            expect(replayed.className).toBe(halo.className);
            expect(container.querySelectorAll('.status')).toHaveLength(2);
        });

        test('a hidden page leaves the halo alone', () => {
            const { container } = render(<PulseDot />);
            const halo = container.querySelectorAll('.status')[0];
            fireVisibilityChange('hidden');
            expect(container.querySelectorAll('.status')[0]).toBe(halo);
        });

        test('an unmounted dot removes the listeners it added', () => {
            const addedToDocument = jest.spyOn(document, 'addEventListener');
            const removedFromDocument = jest.spyOn(document, 'removeEventListener');
            const addedToWindow = jest.spyOn(window, 'addEventListener');
            const removedFromWindow = jest.spyOn(window, 'removeEventListener');
            const { unmount } = render(<PulseDot />);
            const lastListener = (
                spy: jest.SpyInstance<void, Parameters<Document['addEventListener']>>,
                type: string,
            ) => spy.mock.calls.filter(([calledType]) => calledType === type).at(-1)![1];
            const visibilityListener = lastListener(addedToDocument, 'visibilitychange');
            const focusListener = lastListener(addedToWindow, 'focus');
            act(() => {
                unmount();
            });
            expect(lastListener(removedFromDocument, 'visibilitychange')).toBe(visibilityListener);
            expect(lastListener(removedFromWindow, 'focus')).toBe(focusListener);
        });
    });
});

describe('StatusBadge', () => {
    test('defaults to a neutral small badge', () => {
        const { container } = render(<StatusBadge>n</StatusBadge>);
        expect(container.querySelector('span')!.className).toBe('badge badge-neutral badge-sm');
    });

    test('an unknown size falls back to the shared small size', () => {
        const { container } = render(
            <StatusBadge variant="elite" size={invalid('giant')}>
                e
            </StatusBadge>,
        );
        expect(container.querySelector('span')!.className).toBe(`badge ${LEVEL_BADGE_CLASS.elite} badge-sm`);
    });
});

describe('ConnectionBadge', () => {
    test('shows the translated connected / disconnected label with the matching colour', () => {
        const { container, rerender } = render(<ConnectionBadge connected />);
        expect(container.querySelector('.badge-success')!.textContent).toBe('logs.connected');
        rerender(<ConnectionBadge connected={false} />);
        expect(container.querySelector('.badge-error')!.textContent).toBe('logs.disconnected');
    });
});

describe('Modal edges', () => {
    test('ModalActions wraps its children in a modal-action row', () => {
        const { container } = render(
            <ModalActions>
                <button type="button">ok</button>
            </ModalActions>,
        );
        expect(container.querySelector('.modal-action')!.className).toBe('modal-action ');
        expect(screen.getByText('ok')).toBeTruthy();
    });

    test('keys other than Escape / Tab are ignored', () => {
        const onClose = jest.fn();
        render(<Modal isOpen onClose={onClose} title="T" />);
        expect(fireEvent.keyDown(document, { key: 'Enter' })).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
    });

    test('an unknown size uses the md width cap', () => {
        render(<Modal isOpen onClose={() => {}} size={invalid('tiny')} showCloseButton={false} />);
        expect(document.querySelector('.modal-box')!.className).toContain('max-w-lg');
    });

    test('Escape without an onClose handler is a no-op', () => {
        render(<Modal isOpen title="T" />);
        expect(() => fireEvent.keyDown(document, { key: 'Escape' })).not.toThrow();
        expect(screen.getByRole('dialog')).toBeTruthy();
    });

    test('Tab from outside the dialog pulls focus to the first element; Shift+Tab to the last', () => {
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        render(
            <Modal isOpen onClose={() => {}} title="T">
                <button type="button">a</button>
                <button type="button">b</button>
            </Modal>,
        );
        const closeBtn = screen.getByLabelText('common.closeModal');
        const last = screen.getByText('b');

        outside.focus();
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(closeBtn);

        outside.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(last);
        outside.remove();
    });

    test('Tab / Shift+Tab from a middle element leaves focus to the browser', () => {
        render(
            <Modal isOpen onClose={() => {}} title="T">
                <button type="button">a</button>
                <button type="button">b</button>
            </Modal>,
        );
        const middle = screen.getByText('a');
        middle.focus();
        const tab = fireEvent.keyDown(document, { key: 'Tab' });
        const shiftTab = fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        // fireEvent returns false only when preventDefault was called
        expect(tab).toBe(true);
        expect(shiftTab).toBe(true);
        expect(document.activeElement).toBe(middle);
    });

    test('closing when nothing was focused before opening skips focus restore', () => {
        const spy = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(null);
        const { rerender } = render(<Modal isOpen onClose={() => {}} title="T" />);
        spy.mockRestore();
        expect(() => rerender(<Modal isOpen={false} onClose={() => {}} title="T" />)).not.toThrow();
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('AsyncActionButton edges', () => {
    const base = {
        className: 'btn',
        onSuccess: jest.fn(),
        onError: jest.fn(),
        failureLogPrefix: 'Failed',
        errorLogPrefix: 'Errored',
        loadingLabel: 'busy',
        idleContent: 'go',
    };

    test('a failure without an error string logs "Unknown error"', async () => {
        render(<AsyncActionButton {...base} action={jest.fn().mockResolvedValue(undefined)} />);
        fireEvent.click(screen.getByText('go'));
        await waitFor(() => expect(mockApi.logError).toHaveBeenCalledWith('Failed: Unknown error'));
    });

    test('a thrown non-Error value is logged as-is', async () => {
        render(<AsyncActionButton {...base} action={jest.fn().mockRejectedValue('plain string')} />);
        fireEvent.click(screen.getByText('go'));
        await waitFor(() => expect(mockApi.logError).toHaveBeenCalledWith('Errored: plain string'));
    });
});

describe('StrokeIcon', () => {
    test('is an unfilled outline by default', () => {
        const { container } = render(<StrokeIcon d={ICON_PATHS.save} className="w-4 h-4" />);
        const svg = container.querySelector('svg')!;
        expect(svg.getAttribute('fill')).toBe('none');
        expect(svg.getAttribute('stroke')).toBe('currentColor');
    });

    test('filled fills the shape with currentColor and keeps the stroke', () => {
        const { container } = render(<StrokeIcon d={ICON_PATHS.expand} className="w-3 h-3" filled />);
        const svg = container.querySelector('svg')!;
        expect(svg.getAttribute('fill')).toBe('currentColor');
        expect(svg.getAttribute('stroke')).toBe('currentColor');
        expect(svg.querySelector('path')!.getAttribute('d')).toBe(ICON_PATHS.expand);
    });
});

describe('ErrorBoundary edges', () => {
    let consoleError: jest.SpiedFunction<typeof console.error>;
    beforeEach(() => {
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        consoleError.mockRestore();
    });

    function Thrower({ value }: { value: unknown }): null {
        throw value;
    }

    test('a thrown non-Error string is logged via String(error), not shown', () => {
        render(
            <ErrorBoundary>
                <Thrower value="raw failure" />
            </ErrorBoundary>,
        );
        expect(screen.queryByText('raw failure')).toBeNull();
        expect(screen.getByText('errors.boundaryBody')).toBeTruthy();
        expect((mockApi.logError as LogErrorMock).mock.calls[0][0]).toMatch(
            /^React error boundary caught: raw failure\nComponent stack:/,
        );
    });

    test('an error with a message but no stack logs the message', () => {
        const err = { message: 'no stack here' };
        render(
            <ErrorBoundary>
                <Thrower value={err} />
            </ErrorBoundary>,
        );
        expect((mockApi.logError as LogErrorMock).mock.calls[0][0]).toContain(
            'React error boundary caught: no stack here',
        );
    });

    test('without window.api.logError nothing is logged and the fallback still renders', () => {
        window.api = invalid({});
        render(
            <ErrorBoundary>
                <Thrower value={new Error('offline')} />
            </ErrorBoundary>,
        );
        expect(screen.getByText('errors.boundaryTitle')).toBeTruthy();
        expect(mockApi.logError).not.toHaveBeenCalled();
    });

    test('a rejecting logError is swallowed (no unhandled rejection)', async () => {
        mockApi.logError.mockRejectedValueOnce(new Error('log sink down'));
        render(
            <ErrorBoundary>
                <Thrower value={new Error('crash')} />
            </ErrorBoundary>,
        );
        await expect(
            ((mockApi.logError as LogErrorMock).mock.results[0].value as ReturnType<LogErrorMock>).catch(
                () => 'handled',
            ),
        ).resolves.toBe('handled');
        expect(screen.getByText('errors.boundaryBody')).toBeTruthy();
    });

    test('componentDidCatch without info still logs an empty component stack', () => {
        const boundary = new ErrorBoundary({});
        boundary.componentDidCatch(new Error('direct'), undefined);
        expect((mockApi.logError as LogErrorMock).mock.calls[0][0]).toMatch(/Component stack:$/);
    });

    test('Reload reloads the window', () => {
        const reload = jest.fn();
        const original = window.location;
        Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
        try {
            render(
                <ErrorBoundary>
                    <Thrower value={new Error('reload me')} />
                </ErrorBoundary>,
            );
            fireEvent.click(screen.getByText('errors.reload'));
            expect(reload).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(window, 'location', { configurable: true, value: original });
        }
    });
});
