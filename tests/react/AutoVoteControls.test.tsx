import { render, screen, fireEvent, act } from './helpers/test-utils';
import { AutoVoteControls } from '@/components/app/AutoVoteControls';
import { mockTranslator, fillTemplate } from './helpers/setup';

const BASE_MS = 1_700_000_000_000;

type ControlsProps = Parameters<typeof AutoVoteControls>[0];

/** The controls as a stopped controller shows them; a test passes only what it changes. */
const props = (over: Partial<ControlsProps> = {}): ControlsProps => ({
    executionMode: 'stopped',
    lastStop: null,
    status: 'Stopped',
    statusClass: 'badge-neutral',
    lastRun: null,
    cycles: 0,
    onStart: jest.fn(),
    onStop: jest.fn(),
    autoJoinActive: false,
    pendingStartAt: null,
    onStartNow: jest.fn(),
    onCancelResume: jest.fn(),
    ...over,
});
const voting = (over: Partial<ControlsProps> = {}) =>
    props({ executionMode: 'voting', status: 'Running', statusClass: 'badge-success', ...over });

describe('AutoVoteControls', () => {
    it('offers Start while stopped and shows placeholders for an unrun session', () => {
        const onStart = jest.fn();
        render(<AutoVoteControls {...props({ onStart })} />);

        const button = screen.getByText('app.startAutoVote').closest('button')!;
        expect(button.className).toContain('btn-neutral');
        expect(screen.getByText('app.modeStopped')).toBeTruthy();
        expect(screen.getByText('common.stopped').className).toContain('badge-neutral');
        // A change of status is announced.
        expect(screen.getByText('common.stopped').getAttribute('role')).toBe('status');
        expect(screen.getByText('-')).toBeTruthy();
        expect(screen.getByText('0')).toBeTruthy();
        // Nothing is running that a Stop could end.
        expect(screen.queryByText('app.stopAllAutomation')).toBeNull();

        fireEvent.click(button);
        expect(onStart).toHaveBeenCalledTimes(1);
    });

    it('shows the mode in a polite status region, apart from the activity status', () => {
        render(<AutoVoteControls {...voting()} />);
        const mode = screen.getByText('app.modeVoting');
        expect(mode.getAttribute('role')).toBe('status');
        expect(mode.getAttribute('aria-live')).toBe('polite');
        expect(screen.getByText('app.modeLabel')).toBeTruthy();
        // The activity status is its own line.
        expect(screen.getByText('common.running')).not.toBe(mode);
    });

    it('offers Stop all automation while voting, which always asks for a full Stop', () => {
        const onStop = jest.fn();
        const onStart = jest.fn();
        render(<AutoVoteControls {...voting({ lastRun: '12:34:56', cycles: 7, onStop, onStart })} />);

        const stop = screen.getByText('app.stopAllAutomation').closest('button')!;
        expect(stop.className).toContain('btn-error');
        expect(stop.className).not.toContain('btn-outline');
        expect(screen.queryByText('app.startAutoVote')).toBeNull();
        expect(screen.queryByText('app.resumeVoting')).toBeNull();
        expect(screen.getByText('common.running').className).toContain('badge-success');
        expect(screen.getByText('12:34:56')).toBeTruthy();
        expect(screen.getByText('7')).toBeTruthy();
        fireEvent.click(stop);
        expect(onStop).toHaveBeenCalledTimes(1);
        expect(onStart).not.toHaveBeenCalled();
    });

    describe('while a scenario is active with voting paused (armed)', () => {
        const armed = (over: Partial<ControlsProps> = {}) => props({ executionMode: 'armed', ...over });

        it('says so, and that the scenario may still claim rewards or resume voting, in a polite live region', () => {
            render(<AutoVoteControls {...armed()} />);
            expect(screen.getByText('app.modeArmed')).toBeTruthy();
            const note = screen.getByText('app.modeArmedNote');
            expect(note.closest('[aria-live="polite"]')).toBeTruthy();
        });

        it('offers Resume voting (the same request as Start) and Stop all automation, and no plain Start', () => {
            const onStart = jest.fn();
            const onStop = jest.fn();
            render(<AutoVoteControls {...armed({ onStart, onStop })} />);

            expect(screen.queryByText('app.startAutoVote')).toBeNull();
            fireEvent.click(screen.getByText('app.resumeVoting'));
            expect(onStart).toHaveBeenCalledTimes(1);
            expect(onStop).not.toHaveBeenCalled();
            fireEvent.click(screen.getByText('app.stopAllAutomation'));
            expect(onStop).toHaveBeenCalledTimes(1);
        });

        it('the full Stop does not depend on a running flag: the armed controller is not voting and still has it', () => {
            render(<AutoVoteControls {...armed({ status: 'Stopped' })} />);
            expect(screen.getByText('app.stopAllAutomation')).toBeTruthy();
        });

        it('shows no auto-join badge: the voting stages that run the join are paused', () => {
            render(<AutoVoteControls {...armed({ autoJoinActive: true })} />);
            expect(screen.queryByText('app.autoJoinBadge')).toBeNull();
        });
    });

    describe('Stop all automation by keyboard', () => {
        it.each([
            ['voting', voting()],
            ['armed', props({ executionMode: 'armed' })],
        ])('is a focusable, enabled button in %s mode', (_mode, controls) => {
            render(<AutoVoteControls {...controls} />);
            const stop = screen.getByText('app.stopAllAutomation').closest('button')!;
            expect(stop.tagName).toBe('BUTTON');
            expect(stop.disabled).toBe(false);
            expect(stop.getAttribute('tabindex')).toBeNull();
            stop.focus();
            expect(document.activeElement).toBe(stop);
        });
    });

    describe('a Stop and a Run that are not settled', () => {
        it('shows nothing extra for a Stop that was saved', () => {
            render(
                <AutoVoteControls
                    {...props({
                        lastStop: { outcome: 'stopped', durable: true, epoch: 3, withdrawal: 'none' },
                    })}
                />,
            );
            expect(screen.queryByRole('alert')).toBeNull();
            expect(screen.queryByText('app.stopRequested')).toBeNull();
        });

        it('says a Stop that was not saved stopped on this device only, why, and what to do', () => {
            const onStop = jest.fn();
            render(
                <AutoVoteControls
                    {...props({
                        onStop,
                        lastStop: {
                            outcome: 'stopped-locally',
                            durable: false,
                            reason: 'not-saved',
                            withdrawal: 'none',
                        },
                    })}
                />,
            );
            const alert = screen.getByRole('alert');
            expect(alert.className).toContain('alert-warning');
            expect(alert.textContent).toContain('app.stopLocalTitle');
            expect(alert.textContent).toContain('app.stopLocalDetail');
            // A Stop can be tried again while stopped.
            fireEvent.click(screen.getByText('app.stopAllAutomation'));
            expect(onStop).toHaveBeenCalledTimes(1);
        });

        it('stops saying so once a new session is running', () => {
            render(
                <AutoVoteControls
                    {...voting({
                        lastStop: {
                            outcome: 'stopped-locally',
                            durable: false,
                            reason: 'no-fence',
                            withdrawal: 'none',
                        },
                    })}
                />,
            );
            expect(screen.queryByRole('alert')).toBeNull();
        });

        it('a Stop the computer has not confirmed reads as requested, never as stopped (the phone)', () => {
            render(<AutoVoteControls {...voting({ lastStop: { outcome: 'requested', durable: false } })} />);
            const note = screen.getByText('app.stopRequested');
            expect(note.closest('[aria-live="polite"]')).toBeTruthy();
            // The mode is still what the host last said, and the Stop stays within reach.
            expect(screen.getByText('app.modeVoting')).toBeTruthy();
            expect(screen.getByText('app.stopAllAutomation')).toBeTruthy();
        });

        it('a Run sent to the computer keeps the Stop in view, hides Start, and says it is waiting', () => {
            render(<AutoVoteControls {...props({ startPending: true })} />);
            expect(screen.getByText('app.startRequested')).toBeTruthy();
            expect(screen.getByText('app.stopAllAutomation')).toBeTruthy();
            expect(screen.queryByText('app.startAutoVote')).toBeNull();
            expect(screen.getByText('app.modeStopped')).toBeTruthy();
        });
    });

    describe('focus after a transition', () => {
        const stopButton = () => screen.getByText('app.stopAllAutomation').closest('button')!;

        it('goes to Start when a full Stop took the Stop button away', () => {
            const view = render(<AutoVoteControls {...voting()} />);
            fireEvent.focus(stopButton());
            view.rerender(<AutoVoteControls {...props()} />);
            expect(document.activeElement).toBe(screen.getByText('app.startAutoVote').closest('button'));
        });

        it('goes to Stop when Resume voting turned the voting stages on', () => {
            const view = render(<AutoVoteControls {...props({ executionMode: 'armed' })} />);
            fireEvent.focus(screen.getByText('app.resumeVoting').closest('button')!);
            view.rerender(<AutoVoteControls {...voting()} />);
            expect(document.activeElement).toBe(stopButton());
        });

        it('goes to Resume voting when a scenario paused the voting stages', () => {
            const view = render(<AutoVoteControls {...voting()} />);
            fireEvent.focus(stopButton());
            view.rerender(<AutoVoteControls {...props({ executionMode: 'armed' })} />);
            expect(document.activeElement).toBe(screen.getByText('app.resumeVoting').closest('button'));
        });

        it('goes to Stop when a Run was sent and Start went away', () => {
            const view = render(<AutoVoteControls {...props()} />);
            fireEvent.focus(screen.getByText('app.startAutoVote').closest('button')!);
            view.rerender(<AutoVoteControls {...props({ startPending: true })} />);
            expect(document.activeElement).toBe(stopButton());
        });

        it('leaves focus alone when it was not on a control', () => {
            const view = render(<AutoVoteControls {...voting()} />);
            view.rerender(<AutoVoteControls {...props()} />);
            expect(document.activeElement).not.toBe(screen.getByText('app.startAutoVote').closest('button'));
        });

        it('leaves focus alone when it had already left the controls', () => {
            const view = render(<AutoVoteControls {...voting()} />);
            fireEvent.focus(stopButton());
            fireEvent.blur(stopButton());
            view.rerender(<AutoVoteControls {...props()} />);
            expect(document.activeElement).not.toBe(screen.getByText('app.startAutoVote').closest('button'));
        });
    });

    it('shows the auto-join badge next to the status when armed AND voting', () => {
        render(<AutoVoteControls {...voting({ autoJoinActive: true })} />);

        const badge = screen.getByText('app.autoJoinBadge');
        expect(badge.className).toContain('badge-success');
        // It lives in the same group as the running status, not the bankroll row.
        const statusGroup = screen.getByText('app.status').parentElement!;
        expect(statusGroup.contains(badge)).toBe(true);
        expect(badge.closest('[role="status"]')).toBe(badge);
    });

    it('hides the auto-join badge when armed but NOT voting (avoids implying it runs)', () => {
        render(<AutoVoteControls {...props({ autoJoinActive: true })} />);

        expect(screen.queryByText('app.autoJoinBadge')).toBeNull();
    });

    it('shows no auto-join badge when inactive even while voting', () => {
        render(<AutoVoteControls {...voting()} />);

        expect(screen.queryByText('app.autoJoinBadge')).toBeNull();
    });

    describe('the Error status', () => {
        const withError = (props: { status?: string; error?: string | null; pendingStartAt?: number | null } = {}) =>
            render(
                <AutoVoteControls
                    {...voting({
                        status: props.status ?? 'Error',
                        statusClass: 'badge-error',
                        error: props.error,
                        pendingStartAt: props.pendingStartAt ?? null,
                    })}
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
                {...props({
                    pendingStartAt,
                    onStartNow: over.onStartNow ?? jest.fn(),
                    onCancelResume: over.onCancelResume ?? jest.fn(),
                })}
            />
        );
        const renderPending = (over: { onStartNow?: () => void; onCancelResume?: () => void } = {}) =>
            render(controls(BASE_MS + 45_000, over));

        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(BASE_MS);
            mockTranslator.t.mockImplementation((key, vars) =>
                fillTemplate(key === 'app.resumeHold' ? 'Resumes in {time}.' : key, vars),
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
