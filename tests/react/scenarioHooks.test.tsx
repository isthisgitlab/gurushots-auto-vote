/**
 * useScenarios (the stored scenarios + templates) and useScenarioStatus (the
 * card-sized summary of where a challenge is in its scenario).
 */

import { act, render, screen, waitFor } from './helpers/test-utils';
import { useScenarios } from '@/api/useScenarios';
import { refreshScenarioStatuses, useScenarioStatus } from '@/api/useScenarioStatus';
import type { ScenarioSummary } from '@/api/useScenarioStatus';
import { invalid } from '../helpers/invalid';
import type { Challenge } from '../../src/ts/types/gurushots';

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
                corrupt: 'file',
            }),
        );
        render(<StatusProbe challenge={challenge()} />);
        await waitFor(() => expect(JSON.parse(out())).toEqual({ name: 'Plan', corrupt: 'file' }));
    });

    test('progress that is bad for this challenge alone is told from progress that is unreadable altogether', async () => {
        jest.mocked(window.api.getScenarioStatus).mockResolvedValueOnce(
            invalid({ success: true, assigned: 'Plan', scenario, corrupt: 'record' }),
        );
        render(<StatusProbe challenge={challenge()} />);
        await waitFor(() => expect(JSON.parse(out())).toEqual({ name: 'Plan', corrupt: 'record' }));
    });

    test('a reset anywhere makes every card read its status again', async () => {
        render(
            <>
                <StatusProbe challenge={challenge()} />
                <StatusProbe challenge={invalid<Challenge>({ id: 8, close_time: NOW + 86400 })} />
            </>,
        );
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalledTimes(2));
        act(() => refreshScenarioStatuses());
        await waitFor(() => expect(window.api.getScenarioStatus).toHaveBeenCalledTimes(4));
        expect(window.api.getScenarioStatus).toHaveBeenCalledWith(8);
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
        const summary = JSON.parse(out()) as ScenarioSummary;
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

    describe('a spend that got no answer', () => {
        const withRepeat = (repeat?: string) => ({
            ...scenario,
            phases: {
                idle: {},
                main: { rules: [{ id: 'r', ...(repeat ? { repeat } : {}), if: [], do: [] }] },
            },
        });
        const note = (over: object) => ({
            challengeId: 7,
            again: 'phase',
            newerProblem: false,
            origin: 'unclear',
            ...over,
        });
        const halted = { r: { at: NOW, phaseEnteredAt: NOW, unclearHalt: 'swap' } };

        test.each([
            [
                'a step being checked on, carried by the rule in flight',
                { inFlight: { ruleId: 'r', actionIndex: 1, unclear: ['unlockBoost'] } },
                undefined,
                note({ action: 'unlockBoost', stopped: false }),
            ],
            [
                'a step being checked on, with a later problem (the scenario was edited and halted)',
                {
                    inFlight: { ruleId: 'r', actionIndex: 1, unclear: ['unlockBoost'], unclearAt: NOW },
                    lastError: { at: NOW + 5, message: 'halted' },
                },
                undefined,
                note({ action: 'unlockBoost', stopped: false, newerProblem: true }),
            ],
            [
                'a step being checked on, with no problem recorded',
                {
                    inFlight: { ruleId: 'r', actionIndex: 1, unclear: ['unlockBoost'], unclearAt: NOW },
                    lastError: null,
                },
                undefined,
                note({ action: 'unlockBoost', stopped: false }),
            ],
            [
                'a step being checked on, whose own message is the last problem',
                {
                    inFlight: { ruleId: 'r', actionIndex: 1, unclear: ['unlockBoost'], unclearAt: NOW },
                    lastError: { at: NOW, message: 'its own' },
                },
                undefined,
                note({ action: 'unlockBoost', stopped: false }),
            ],
            [
                'a rule stopped after one, in the phase it is in now',
                { fired: halted },
                undefined,
                note({ action: 'swap', stopped: true }),
            ],
            [
                'a rule stopped in an earlier entry of the phase',
                { fired: { r: { at: NOW, phaseEnteredAt: NOW - 100, unclearHalt: 'swap' } } },
                undefined,
                null,
            ],
            ['a rule that finished normally', { fired: { r: { at: NOW, phaseEnteredAt: NOW } } }, undefined, null],
            ['a rule in flight with no marker', { inFlight: { ruleId: 'r', actionIndex: 1 } }, undefined, null],
            [
                'a once rule, which can run again only after a reset',
                { fired: halted },
                'once',
                note({ action: 'swap', stopped: true, again: 'reset' }),
            ],
            [
                'a once-a-day rule, which can run again the next day',
                { fired: halted },
                'oncePerDay',
                note({ action: 'swap', stopped: true, again: 'day' }),
            ],
            [
                'a once-per-phase rule, which can run again when the phase is entered again',
                { fired: halted },
                'oncePerPhase',
                note({ action: 'swap', stopped: true }),
            ],
            [
                'a stopped rule the scenario no longer has',
                { fired: { gone: { at: NOW, phaseEnteredAt: NOW, unclearHalt: 'swap' } } },
                'once',
                note({ action: 'swap', stopped: true }),
            ],
            [
                'a rule stopped from a marker written before the spend (the app stopped before it knew)',
                { fired: { r: { at: NOW, phaseEnteredAt: NOW, unclearHalt: 'swap', haltOrigin: 'pending' } } },
                undefined,
                note({ action: 'swap', stopped: true, origin: 'pending' }),
            ],
            [
                'a step that more than one spend of is being checked on: the first is what the card names',
                { inFlight: { ruleId: 'r', actionIndex: 1, unclear: ['fillExposure', 'swap'], unclearAt: NOW } },
                undefined,
                note({ action: 'fillExposure', stopped: false }),
            ],
            [
                'a stop followed by a later problem',
                { fired: halted, lastError: { at: NOW + 5, message: 'later' } },
                undefined,
                note({ action: 'swap', stopped: true, newerProblem: true }),
            ],
            [
                'a stop with no problem after it',
                { fired: halted, lastError: null },
                undefined,
                note({ action: 'swap', stopped: true }),
            ],
        ])('%s reads as the spend %p on the card', async (_name, extra, repeat, spend) => {
            jest.mocked(window.api.getScenarioStatus).mockResolvedValue(
                invalid({
                    success: true,
                    assigned: 'Plan',
                    scenario: withRepeat(repeat),
                    corrupt: false,
                    timezone: 'UTC',
                    state: {
                        phase: 'main',
                        phaseEnteredAt: NOW,
                        fired: {},
                        memory: {},
                        lastError: { at: NOW, message: 'x' },
                        inFlight: null,
                        ...extra,
                    },
                }),
            );
            render(<StatusProbe challenge={challenge()} />);
            await waitFor(() => expect(out()).not.toBe('none'));
            expect((JSON.parse(out()) as ScenarioSummary).spendUnclear ?? null).toEqual(spend);
        });
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
