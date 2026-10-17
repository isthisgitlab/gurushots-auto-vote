import { render, screen, fireEvent, act } from './helpers/test-utils';
import { AutoVoteControls } from '@/components/app/AutoVoteControls';
import { mockTranslator } from './helpers/setup';

const BASE_MS = 1_700_000_000_000;

describe('AutoVoteControls', () => {
    it('offers Start while stopped and shows placeholders for an unrun session', () => {
        const onToggle = jest.fn();
        render(
            <AutoVoteControls
                running={false}
                status="Stopped"
                statusClass="badge-neutral"
                lastRun={null}
                cycles={0}
                onToggle={onToggle}
                autoJoinActive={false}
                pendingStartAt={null}
                onStartNow={jest.fn()}
                onCancelResume={jest.fn()}
            />,
        );

        const button = screen.getByText('app.startAutoVote').closest('button')!;
        expect(button.className).toContain('btn-neutral');
        expect(screen.getByText('common.stopped').className).toContain('badge-neutral');
        expect(screen.getByText('-')).toBeTruthy();
        expect(screen.getByText('0')).toBeTruthy();

        fireEvent.click(button);
        expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('offers Stop while running and shows the last run and cycle count', () => {
        render(
            <AutoVoteControls
                running
                status="Running"
                statusClass="badge-success"
                lastRun="12:34:56"
                cycles={7}
                onToggle={jest.fn()}
                autoJoinActive={false}
                pendingStartAt={null}
                onStartNow={jest.fn()}
                onCancelResume={jest.fn()}
            />,
        );

        expect(screen.getByText('app.stopAutoVote').closest('button')!.className).toContain('btn-error');
        expect(screen.queryByText('app.startAutoVote')).toBeNull();
        expect(screen.getByText('common.running').className).toContain('badge-success');
        expect(screen.getByText('12:34:56')).toBeTruthy();
        expect(screen.getByText('7')).toBeTruthy();
    });

    it('shows the auto-join badge next to the status when armed AND running', () => {
        render(
            <AutoVoteControls
                running
                status="Running"
                statusClass="badge-success"
                lastRun={null}
                cycles={0}
                onToggle={jest.fn()}
                autoJoinActive
                pendingStartAt={null}
                onStartNow={jest.fn()}
                onCancelResume={jest.fn()}
            />,
        );

        const badge = screen.getByText('app.autoJoinBadge');
        expect(badge.className).toContain('badge-success');
        // It lives in the same group as the running status, not the bankroll row.
        const statusGroup = screen.getByText('app.status').parentElement!;
        expect(statusGroup.contains(badge)).toBe(true);
        expect(badge.closest('[role="status"]')).toBe(badge);
    });

    it('hides the auto-join badge when armed but NOT running (avoids implying it runs)', () => {
        render(
            <AutoVoteControls
                running={false}
                status="Stopped"
                statusClass="badge-neutral"
                lastRun={null}
                cycles={0}
                onToggle={jest.fn()}
                autoJoinActive
                pendingStartAt={null}
                onStartNow={jest.fn()}
                onCancelResume={jest.fn()}
            />,
        );

        expect(screen.queryByText('app.autoJoinBadge')).toBeNull();
    });

    it('shows no auto-join badge when inactive even while running', () => {
        render(
            <AutoVoteControls
                running
                status="Running"
                statusClass="badge-success"
                lastRun={null}
                cycles={0}
                onToggle={jest.fn()}
                autoJoinActive={false}
                pendingStartAt={null}
                onStartNow={jest.fn()}
                onCancelResume={jest.fn()}
            />,
        );

        expect(screen.queryByText('app.autoJoinBadge')).toBeNull();
    });

    describe('the Error status', () => {
        const withError = (props: { status?: string; error?: string | null; pendingStartAt?: number | null } = {}) =>
            render(
                <AutoVoteControls
                    running
                    status={props.status ?? 'Error'}
                    statusClass="badge-error"
                    error={props.error}
                    lastRun={null}
                    cycles={0}
                    onToggle={jest.fn()}
                    autoJoinActive={false}
                    pendingStartAt={props.pendingStartAt ?? null}
                    onStartNow={jest.fn()}
                    onCancelResume={jest.fn()}
                />,
            );

        it('is worded in the UI language, with the reason as an announced, translated line', () => {
            withError({ error: 'not-logged-in' });
            expect(screen.getByText('app.statusError').className).toContain('badge-error');
            expect(screen.queryByText('Error')).toBeNull();
            expect(screen.getByRole('alert').textContent).toBe('errors.notLoggedIn');
        });

        it('an unknown reason reads as the generic voting failure, never the raw text', () => {
            withError({ error: 'ECONNRESET' });
            expect(screen.getByRole('alert').textContent).toBe('errors.votingFailed');
        });

        it('shows no reason line without an error, or while a held resume is pending, or in another status', () => {
            const first = withError({ error: null });
            expect(screen.queryByRole('alert')).toBeNull();
            first.unmount();
            const second = withError({ error: 'voting-failed', pendingStartAt: BASE_MS + 1000 });
            expect(screen.queryByRole('alert')).toBeNull();
            second.unmount();
            withError({ status: 'Running', error: 'voting-failed' });
            expect(screen.queryByRole('alert')).toBeNull();
        });

        it('a status this build has no label for reads as the error label', () => {
            withError({ status: 'idle' });
            expect(screen.getByText('app.statusError')).toBeTruthy();
        });
    });

    describe('while an auto-resume is held at launch', () => {
        const controls = (
            pendingStartAt: number | null,
            over: { onStartNow?: () => void; onCancelResume?: () => void } = {},
        ) => (
            <AutoVoteControls
                running={false}
                status="Stopped"
                statusClass="badge-neutral"
                lastRun={null}
                cycles={0}
                onToggle={jest.fn()}
                autoJoinActive={false}
                pendingStartAt={pendingStartAt}
                onStartNow={over.onStartNow ?? jest.fn()}
                onCancelResume={over.onCancelResume ?? jest.fn()}
            />
        );
        const renderPending = (over: { onStartNow?: () => void; onCancelResume?: () => void } = {}) =>
            render(controls(BASE_MS + 45_000, over));

        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(BASE_MS);
            mockTranslator.t.mockImplementation((key: string) =>
                key === 'app.resumeHold' ? 'Resumes in {time}.' : key,
            );
        });
        afterEach(() => {
            mockTranslator.t.mockImplementation((key: string) => key);
            jest.useRealTimers();
        });

        it('shows the translated Starting badge, hides the toggle, and counts down', () => {
            renderPending();

            expect(screen.getByText('app.statusWaiting').className).toContain('badge-warning');
            expect(screen.queryByText('Stopped')).toBeNull();
            expect(screen.queryByText('app.startAutoVote')).toBeNull();
            expect(screen.getByText('Resumes in 45s.')).toBeTruthy();

            act(() => jest.advanceTimersByTime(5000));
            expect(screen.getByText('Resumes in 40s.')).toBeTruthy();
        });

        it('clamps a late timer at zero', () => {
            renderPending();
            act(() => jest.advanceTimersByTime(90_000));
            expect(screen.getByText('Resumes in 0s.')).toBeTruthy();
        });

        it("has Start now and Don't resume buttons that call their handlers", () => {
            const onStartNow = jest.fn();
            const onCancelResume = jest.fn();
            renderPending({ onStartNow, onCancelResume });

            fireEvent.click(screen.getByText('app.resumeStartNow'));
            expect(onStartNow).toHaveBeenCalledTimes(1);
            expect(onCancelResume).not.toHaveBeenCalled();
            fireEvent.click(screen.getByText('app.resumeCancel'));
            expect(onCancelResume).toHaveBeenCalledTimes(1);
        });

        it('is not a live region, so the ticking countdown is not re-announced', () => {
            const { container } = renderPending();
            const alert = container.querySelector('.alert.alert-info')!;
            expect(alert).toBeTruthy();
            expect(alert.getAttribute('role')).toBeNull();
            expect(alert.getAttribute('aria-live')).toBeNull();
            expect(alert.querySelector('[role], [aria-live]')).toBeNull();
        });

        it('is one column on narrow screens and a text-plus-buttons grid from sm up', () => {
            const { container } = renderPending();
            const alert = container.querySelector('.alert.alert-info')!;
            expect(alert.classList.contains('grid-flow-row')).toBe(true);
            expect(alert.classList.contains('grid-cols-1')).toBe(true);
            expect(alert.classList.contains('sm:grid-cols-[minmax(0,1fr)_auto]')).toBe(true);
            expect(alert.classList.contains('alert-vertical')).toBe(false);
            expect(alert.classList.contains('sm:alert-horizontal')).toBe(false);
            expect(screen.getByText('app.resumeStartNow').parentElement!.classList.contains('flex-wrap')).toBe(true);
        });

        it('keeps the countdown out of the static sentence both buttons are described by', () => {
            renderPending();
            const note = screen.getByText('app.resumeHoldNote');
            expect(note.id).toBeTruthy();
            expect(note.closest('[id]')).toBe(note);
            for (const label of ['app.resumeStartNow', 'app.resumeCancel']) {
                expect(screen.getByText(label).getAttribute('aria-describedby')).toBe(note.id);
            }
            expect(note.textContent).not.toContain('45');
        });

        describe('focus', () => {
            // After Start now the controls show the Stop toggle; after Don't resume, Start.
            const vanish = (view: ReturnType<typeof renderPending>) => view.rerender(controls(null));

            it('moves to the toggle when the notice goes away with focus inside it', () => {
                const view = renderPending();
                fireEvent.focus(screen.getByText('app.resumeStartNow'));
                vanish(view);
                expect(document.activeElement).toBe(screen.getByText('app.startAutoVote').closest('button'));
            });

            it('is left alone when focus was not in the notice', () => {
                const view = renderPending();
                vanish(view);
                expect(document.activeElement).not.toBe(screen.getByText('app.startAutoVote').closest('button'));
            });

            it('is left alone when focus had already left the notice', () => {
                const view = renderPending();
                const startNow = screen.getByText('app.resumeStartNow');
                fireEvent.focus(startNow);
                fireEvent.blur(startNow);
                vanish(view);
                expect(document.activeElement).not.toBe(screen.getByText('app.startAutoVote').closest('button'));
            });
        });
    });
});
