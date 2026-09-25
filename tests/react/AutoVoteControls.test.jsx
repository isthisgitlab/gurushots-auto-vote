import { render, screen, fireEvent } from './helpers/test-utils';
import { AutoVoteControls } from '@/components/app/AutoVoteControls';

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
            />,
        );

        const button = screen.getByText('app.startAutoVote').closest('button');
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
            />,
        );

        expect(screen.getByText('app.stopAutoVote').closest('button').className).toContain('btn-error');
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
            />,
        );

        const badge = screen.getByText('app.autoJoinBadge');
        expect(badge.className).toContain('badge-success');
        // It lives in the same group as the running status, not the bankroll row.
        const statusGroup = screen.getByText('app.status').parentElement;
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
            />,
        );

        expect(screen.queryByText('app.autoJoinBadge')).toBeNull();
    });
});
