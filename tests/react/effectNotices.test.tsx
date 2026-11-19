/**
 * The two inline notices of the effective-settings work: a change with no final result (We could not confirm the change /
 * Waiting for the background service, with Check status) and a value of the running scenario that cannot be read.
 */
import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { EffectOutcomeNotice } from '@/components/ui/EffectOutcomeNotice';
import { EffectiveUnavailableNotice } from '@/components/ui/EffectiveUnavailableNotice';

import type { EffectOutcome } from '@/api/ipc';

describe('EffectOutcomeNotice', () => {
    const outcome = (over: Partial<EffectOutcome> = {}): EffectOutcome => ({
        kind: 'unclear',
        requestId: 'req-1',
        checked: null,
        ...over,
    });

    it('shows nothing without an open outcome', () => {
        const { container } = render(<EffectOutcomeNotice outcome={null} onCheck={jest.fn()} onDismiss={jest.fn()} />);
        expect(container.querySelector('.alert')).toBeNull();
    });

    it('says the change could not be confirmed, why, and what to do, in an inline warning', () => {
        render(<EffectOutcomeNotice outcome={outcome()} onCheck={jest.fn()} onDismiss={jest.fn()} />);
        const alert = screen.getByText('app.effectUnclear').closest('.alert') as HTMLElement;
        expect(alert.className).toContain('alert-warning');
        expect(alert.getAttribute('role')).toBe('status');
        expect(alert.textContent).toContain('app.effectUnclearDetail');
    });

    it('Check status asks, is held while the check runs, and can be pressed again after', async () => {
        let release!: (settled: boolean) => void;
        const onCheck = jest.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
        render(<EffectOutcomeNotice outcome={outcome()} onCheck={onCheck} onDismiss={jest.fn()} />);
        const button = screen.getByText('app.effectCheckStatus') as HTMLButtonElement;
        fireEvent.click(button);
        expect(onCheck).toHaveBeenCalledTimes(1);
        expect(button.disabled).toBe(true);
        release(false);
        await waitFor(() => expect(button.disabled).toBe(false));
    });

    it('Dismiss gives the change up', () => {
        const onDismiss = jest.fn();
        render(<EffectOutcomeNotice outcome={outcome()} onCheck={jest.fn()} onDismiss={onDismiss} />);
        fireEvent.click(screen.getByText('errors.dismiss'));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('an Android request the service has queued says it is waiting for the background service', () => {
        render(
            <EffectOutcomeNotice
                outcome={outcome({ kind: 'queued', requestId: 'app-1' })}
                onCheck={jest.fn()}
                onDismiss={jest.fn()}
            />,
        );
        expect(screen.getByText('app.effectQueued')).toBeTruthy();
        expect(screen.getByText('app.effectQueuedDetail')).toBeTruthy();
    });

    it('a change a check found still pending says it is waiting for the computer', () => {
        render(
            <EffectOutcomeNotice outcome={outcome({ kind: 'waiting' })} onCheck={jest.fn()} onDismiss={jest.fn()} />,
        );
        expect(screen.getByText('app.effectWaiting')).toBeTruthy();
        expect(screen.getByText('app.effectWaitingDetail')).toBeTruthy();
    });

    it.each([
        ['not-recorded', 'app.effectNotRecorded'],
        ['unreadable', 'app.effectUnreadable'],
    ] as const)('says what the last check found (%s)', (checked, key) => {
        render(<EffectOutcomeNotice outcome={outcome({ checked })} onCheck={jest.fn()} onDismiss={jest.fn()} />);
        expect(screen.getByText(key)).toBeTruthy();
    });

    it('offers no Check status for a change that carries no identity', () => {
        render(
            <EffectOutcomeNotice outcome={outcome({ requestId: null })} onCheck={jest.fn()} onDismiss={jest.fn()} />,
        );
        expect(screen.queryByText('app.effectCheckStatus')).toBeNull();
        expect(screen.getByText('errors.dismiss')).toBeTruthy();
    });
});

describe('EffectiveUnavailableNotice', () => {
    it('shows nothing when every value can be read', () => {
        const { container } = render(<EffectiveUnavailableNotice reasons={[]} />);
        expect(container.querySelector('.alert')).toBeNull();
    });

    it('says what happened, that the last settings stay, and the reasons, in an inline warning', () => {
        render(<EffectiveUnavailableNotice reasons={['expired', 'theme-unavailable']} />);
        const alert = screen.getByText('app.effectiveUnavailableTitle').closest('.alert') as HTMLElement;
        expect(alert.className).toContain('alert-warning');
        expect(alert.textContent).toContain('app.effectiveUnavailableDetail');
        expect(alert.textContent).toContain('app.effectiveUnavailableReason');
    });
});
