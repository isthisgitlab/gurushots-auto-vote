/**
 * useScenarios (the stored scenarios + templates) and useScenarioStatus (the
 * card-sized summary of where a challenge is in its scenario).
 */

import { render, screen, waitFor } from './helpers/test-utils';
import { useScenarios } from '@/api/useScenarios';
import { useScenarioStatus } from '@/api/useScenarioStatus';
import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/js/types/gurushots';

function ScenariosProbe({ enabled }: { enabled?: boolean }) {
    const { scenarios, templates, error, loading } = useScenarios(enabled);
    return (
        <div data-testid="out">
            {loading ? 'loading' : `${Object.keys(scenarios).join(',')}|${templates.length}|${error ?? ''}`}
        </div>
    );
}

function StatusProbe({ challenge, version = 0, pass = 0 }: { challenge: Challenge; version?: number; pass?: number }) {
    const summary = useScenarioStatus(challenge, version, pass);
    return <div data-testid="out">{summary === null ? 'none' : JSON.stringify(summary)}</div>;
}

const out = () => screen.getByTestId('out').textContent;
const NOW = Math.floor(Date.now() / 1000);
const scenario = {
    name: 'Plan',
    start: 'main',
    phases: { main: { rules: [{ id: 'r', if: [{ type: 'inPhaseFor', min: '10m' }], do: [] }] } },
};
const challenge = (entries = [{ id: 'a', votes: 1, rank: 5 }]) =>
    invalid<Challenge>({
        id: 7,
        close_time: NOW + 86400,
        member: { boost: { state: 'LOCKED' }, turbo: { state: 'FREE' }, ranking: { entries } },
    });

describe('useScenarios', () => {
    test('loads scenarios and templates', async () => {
        jest.mocked(window.api.getScenarios).mockResolvedValueOnce(
            invalid({
                success: true,
                scenarios: { Plan: scenario },
                templates: [{ id: 't' }],
            }),
        );
        render(<ScenariosProbe />);
        await waitFor(() => expect(out()).toBe('Plan|1|'));
    });

    test('a success without lists reads as empty; a failure reports its error', async () => {
        jest.mocked(window.api.getScenarios).mockResolvedValueOnce(invalid({ success: true }));
        const { unmount } = render(<ScenariosProbe />);
        await waitFor(() => expect(out()).toBe('|0|'));
        unmount();
        jest.mocked(window.api.getScenarios).mockResolvedValueOnce({ success: false, error: 'boom' });
        const second = render(<ScenariosProbe />);
        await waitFor(() => expect(out()).toBe('|0|boom'));
        second.unmount();
        jest.mocked(window.api.getScenarios).mockResolvedValueOnce(invalid(undefined));
        render(<ScenariosProbe />);
        await waitFor(() => expect(out()).toBe('|0|failed'));
    });
});

describe('useScenarioStatus', () => {
    test('no scenario, and a failed or rejected read, mean no summary', async () => {
        render(<StatusProbe challenge={challenge()} />);
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalledWith(7));
        expect(out()).toBe('none');
        jest.mocked(window.api.getScenarioStatus).mockRejectedValueOnce(new Error('ipc down'));
        render(<StatusProbe challenge={challenge()} />);
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalledTimes(2));
        expect(screen.getAllByTestId('out').every((el) => el.textContent === 'none')).toBe(true);
    });

    test('an unknown scenario and unreadable state', async () => {
        jest.mocked(window.api.getScenarioStatus).mockResolvedValueOnce(
            invalid({ success: true, assigned: 'Gone', scenario: null }),
        );
        const { unmount } = render(<StatusProbe challenge={challenge()} />);
        await waitFor(() => expect(JSON.parse(out())).toEqual({ name: 'Gone', missing: true }));
        unmount();
        jest.mocked(window.api.getScenarioStatus).mockResolvedValueOnce(
            invalid({
                success: true,
                assigned: 'Plan',
                scenario,
                corrupt: true,
            }),
        );
        render(<StatusProbe challenge={challenge()} />);
        await waitFor(() => expect(JSON.parse(out())).toEqual({ name: 'Plan', corrupt: true }));
    });

    test('a plan not started yet is summarised from its start phase', async () => {
        jest.mocked(window.api.getScenarioStatus).mockResolvedValueOnce(
            invalid({
                success: true,
                assigned: 'Plan',
                scenario,
                state: null,
                corrupt: false,
                timezone: 'UTC',
            }),
        );
        render(<StatusProbe challenge={challenge()} />);
        await waitFor(() => expect(out()).not.toBe('none'));
        const summary = JSON.parse(out());
        expect(summary).toEqual(
            expect.objectContaining({ name: 'Plan', phase: 'main', started: false, lastError: null }),
        );
        expect(summary.nextWakeAt).toBeGreaterThan(NOW);
    });

    test('a running plan carries its phase and last problem', async () => {
        jest.mocked(window.api.getScenarioStatus).mockResolvedValue(
            invalid({
                success: true,
                assigned: 'Plan',
                scenario,
                corrupt: false,
                timezone: 'UTC',
                state: { phase: 'main', phaseEnteredAt: NOW, fired: {}, memory: {}, lastError: { message: 'no slot' } },
            }),
        );
        const { rerender } = render(<StatusProbe challenge={challenge()} />);
        await waitFor(() => expect(out()).toContain('no slot'));
        expect(JSON.parse(out())).toEqual(expect.objectContaining({ started: true, nextWakeAt: NOW + 600 }));
        // A re-render with the same fingerprint does not refetch; a changed entry or settings version does.
        rerender(<StatusProbe challenge={challenge()} />);
        rerender(<StatusProbe challenge={challenge([{ id: 'a', votes: 9, rank: 2 }])} />);
        rerender(<StatusProbe challenge={challenge([{ id: 'a', votes: 9, rank: 2 }])} version={1} />);
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalledTimes(3));
        // A finished pass refetches even when the challenge payload is unchanged.
        rerender(<StatusProbe challenge={challenge([{ id: 'a', votes: 9, rank: 2 }])} version={1} pass={1} />);
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalledTimes(4));
    });

    test('a challenge without entries, and a result that lands after unmount, are handled', async () => {
        let resolve!: (value: unknown) => void;
        jest.mocked(window.api.getScenarioStatus).mockReturnValueOnce(
            invalid(
                new Promise((r) => {
                    resolve = r;
                }),
            ),
        );
        const { unmount } = render(<StatusProbe challenge={invalid({ id: 8 })} />);
        unmount();
        resolve({ success: true, assigned: 'Plan', scenario: null });
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalledWith(8));
    });
});
