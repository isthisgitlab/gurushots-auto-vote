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
        expect(button.className).toContain('btn-latvian');
        expect(screen.getByText('Stopped').className).toContain('badge-neutral');
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
        expect(screen.getByText('Running').className).toContain('badge-success');
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

    describe('while an auto-resume is held at launch', () => {
        const renderPending = (over: { onStartNow?: () => void; onCancelResume?: () => void } = {}) =>
            render(
                <AutoVoteControls
                    running={false}
                    status="Stopped"
                    statusClass="badge-neutral"
                    lastRun={null}
                    cycles={0}
                    onToggle={jest.fn()}
                    autoJoinActive={false}
                    pendingStartAt={BASE_MS + 45_000}
                    onStartNow={over.onStartNow ?? jest.fn()}
                    onCancelResume={over.onCancelResume ?? jest.fn()}
                />,
            );

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

            expect(screen.getByText('app.statusStarting').className).toContain('badge-warning');
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
    });
});
