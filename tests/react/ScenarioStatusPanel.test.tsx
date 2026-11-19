/**
 * The card's scenario status with its reset dialog: what the dialog resets is settled when it opens, and the
 * "what applies now" detail reads the subject's snapshot (overlaid values and sources, schedule rows, the pause
 * with its Resume, and a lifecycle request still waiting for its answer).
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { ScenarioStatusPanel } from '@/components/app/ScenarioStatusPanel';
import { invalid } from '../helpers/invalid';
import { refreshScenarioStatuses } from '@/api/useScenarioStatus';
import type { ScenarioSummary } from '@/api/useScenarioStatus';

const challenge = { id: 101, title: 'Sunset', url: 'sunset' };
const corrupt = (kind: 'file' | 'record'): ScenarioSummary => ({ name: 'Plan', corrupt: kind });
const running: ScenarioSummary = { name: 'Plan', phase: 'main', started: true };

beforeEach(() => {
    window.api.resetScenarioState = jest.fn().mockResolvedValue({ success: true });
    window.api.resetAllScenarioState = jest.fn().mockResolvedValue({ success: true });
    window.api.getScenarioSnapshot = jest.fn();
    window.api.getScenarioRequestStatus = jest
        .fn()
        .mockResolvedValue(
            invalid({ success: true, state: 'target', target: '101', revision: 0, pending: null, results: [] }),
        );
});

test('a bad record opens the reset of this challenge, and the whole file the reset of every challenge', async () => {
    const { rerender } = render(<ScenarioStatusPanel status={corrupt('record')} challenge={challenge} />);
    fireEvent.click(screen.getByText('app.scenarioReset'));
    expect(screen.getByText('app.scenarioResetBody')).toBeTruthy();
    fireEvent.click(screen.getByText('app.cancel'));
    await waitFor(() => expect(screen.queryByText('app.scenarioResetTitle')).toBeNull());

    rerender(<ScenarioStatusPanel status={corrupt('file')} challenge={challenge} />);
    fireEvent.click(screen.getByText('app.scenarioResetAll'));
    expect(screen.getByText('app.scenarioResetAllBody')).toBeTruthy();
});

test('what the dialog resets does not change under it when the card learns more while it is open', async () => {
    const { rerender } = render(<ScenarioStatusPanel status={corrupt('record')} challenge={challenge} />);
    fireEvent.click(screen.getByText('app.scenarioReset'));
    // The progress turns out to be unreadable altogether (a status read while the dialog is open): the dialog
    // goes on offering what it was opened for, and does not turn into a reset of every challenge.
    rerender(<ScenarioStatusPanel status={corrupt('file')} challenge={challenge} />);
    expect(screen.getByText('app.scenarioResetBody')).toBeTruthy();
    fireEvent.click(screen.getByText('app.scenarioResetConfirm'));
    await waitFor(() => expect(window.api.resetScenarioState).toHaveBeenCalledWith(101));
    expect(window.api.resetAllScenarioState).not.toHaveBeenCalled();
});

describe('what applies now', () => {
    const snapshot = () =>
        invalid<Record<string, unknown>>({
            success: true,
            subject: '101',
            assignment: 'Plan',
            corrupt: false,
            paused: false,
            generation: 2,
            withdrawn: false,
            base: {},
            effective: {
                exposure: invalid({ state: 'known', value: { kind: 'number', value: 10, quantity: 'percent' } }),
                autoSubmit: invalid({ state: 'absent', reason: 'not-applicable' }),
                autoBoost: invalid({ state: 'unknown', reason: 'clock-unreadable', dependencies: ['clock'] }),
            },
            overlay: invalid({
                bound: true,
                available: true,
                reason: null,
                sources: {
                    patch: ['secret'],
                    literals: ['exposure'],
                    bindings: ['autoSubmit'],
                    profile: ['autoBoost', 'autoSubmit'],
                },
                published: null,
            }),
            publication: null,
            schedules: invalid({
                kind: 'resolved',
                schedules: {
                    submit: invalid({
                        alignment: 'end',
                        rows: [
                            invalid({ count: 1, state: 'absent', reason: 'not-applicable' }),
                            invalid({ count: 2, state: 'known', at: 1_800_000_000 }),
                            invalid({ count: 3, state: 'unknown', reason: 'timer-unreadable' }),
                            invalid({ count: 4, state: 'unknown' }),
                        ],
                    }),
                    vote: invalid({
                        rows: [
                            invalid({ state: 'known', start: 1_799_900_000, end: 1_799_910_000 }),
                            invalid({ state: 'unknown' }),
                        ],
                    }),
                    pause: invalid({
                        rows: [
                            invalid({ state: 'known', start: 1_799_950_000, end: 1_799_960_000 }),
                            invalid({ state: 'unknown', reason: 'clock-unreadable' }),
                        ],
                    }),
                },
            }),
            pins: null,
            pool: null,
        });

    /** The fixture's overlay, as the spread rewrites below read it. */
    const overlayOf = () => snapshot().overlay as Record<string, unknown>;
    const open = async () => {
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        await waitFor(() => expect(window.api.getScenarioSnapshot).toHaveBeenCalledWith('101'));
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        await screen.findByText(/: 10% \(/);
    };

    test('every overlaid key reads its effective value and its source, absent and unknown in plain words', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(snapshot());
        await open();
        expect(screen.getByText(/app\.scenarioValueAbsent/)).toBeTruthy();
        expect(screen.getAllByText(/app\.scenarioValueUnknown/).length).toBeGreaterThan(1);
        expect(screen.getAllByText(/\(app\.scenarioSourcePhase\)/).length).toBeGreaterThan(0);
        expect(screen.getByText(/\(app\.scenarioSourceProfile\)/)).toBeTruthy();
    });

    test('a key only the overlay names reads as empty, and a translated key by its name', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(snapshot());
        const { mockTranslator } = jest.requireActual('./helpers/setup') as typeof import('./helpers/setup');
        const original = mockTranslator.t.getMockImplementation();
        mockTranslator.t.mockImplementation((key: string) => (key === 'app.exposure' ? 'Exposure' : key));
        try {
            await open();
            expect(screen.getByText(/^secret: /)).toBeTruthy();
            expect(screen.getByText(/^Exposure: 10%/)).toBeTruthy();
        } finally {
            mockTranslator.t.mockImplementation(original);
        }
    });

    test('a snapshot without an overlay row (as the installation reads) shows none', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(invalid({ ...snapshot(), overlay: null }));
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        // No overlay rows and no warning: the schedules are still there to read.
        expect(await screen.findAllByText(/app\.sbDeadline_submit/)).toBeTruthy();
        expect(screen.queryByText(/: 10% \(/)).toBeNull();
        expect(screen.queryByText(/app\.scenarioOverlayUnavailable/)).toBeNull();
    });

    test('an overlay that cannot be read says why', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(
            invalid({
                ...snapshot(),
                overlay: invalid({ ...overlayOf(), available: false, reason: 'nothing is published yet' }),
            }),
        );
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        expect(await screen.findByText(/app\.scenarioOverlayUnavailable/)).toBeTruthy();
    });

    test('an overlay that cannot be read with no reason given still reads plainly', async () => {
        window.api.getScenarioSnapshot = jest
            .fn()
            .mockResolvedValue(
                invalid({ ...snapshot(), overlay: invalid({ ...overlayOf(), available: false, reason: null }) }),
            );
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        expect(await screen.findByText(/app\.scenarioOverlayUnavailable/)).toBeTruthy();
    });

    test('schedules that cannot be read say why', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(
            invalid({
                ...snapshot(),
                schedules: invalid({ kind: 'unavailable', reason: 'the phase is not published' }),
            }),
        );
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        expect(await screen.findByText(/app\.scenarioScheduleUnknown/)).toBeTruthy();
    });

    test('the resolved schedule rows show their counts and deadlines, unknown ones say why', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(snapshot());
        await open();
        expect(screen.getAllByText(/app\.sbDeadline_submit/)).toHaveLength(4);
        expect(screen.getAllByText(/app\.scenarioValueUnknown/).length).toBeGreaterThan(0);
    });

    test('reasons read in plain words, an absent row is not missing data, and an unworded reason reads as not known', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(snapshot());
        const { mockTranslator, fillTemplate } = jest.requireActual(
            './helpers/setup',
        ) as typeof import('./helpers/setup');
        const original = mockTranslator.t.getMockImplementation();
        const words: Record<string, string> = {
            'app.scenarioValueUnknown': 'Missing data ({reason})',
            'app.scenarioValueAbsent': 'Not applicable',
            'app.scenarioReason_unreadable': 'cannot be read',
            'app.scenarioReason_other': 'not known',
            'app.sbDeadline_submit': 'Photo {count} by {at}',
        };
        mockTranslator.t.mockImplementation((key: string, vars?: Record<string, string | number | null | undefined>) =>
            fillTemplate(words[key] ?? key, vars),
        );
        try {
            await open();
            // A schedule row confirmed absent is not applicable; an unknown one says why in words.
            expect(screen.getByText('Photo 1 by Not applicable')).toBeTruthy();
            expect(screen.getByText('Photo 3 by Missing data (cannot be read)')).toBeTruthy();
            expect(screen.getByText('Photo 4 by Missing data (not known)')).toBeTruthy();
            // The backend's code is never printed as written.
            expect(screen.queryByText(/unreadable/)).toBeNull();
            expect(screen.getByText(/Missing data \(cannot be read\) \(app\.scenarioSourceProfile\)/)).toBeTruthy();
        } finally {
            mockTranslator.t.mockImplementation(original);
        }
    });

    test.each([
        ['pool-unbound', 'app.scenarioPoolBlock_unbound'],
        ['pool-exhausted', 'app.scenarioPoolBlock_exhausted'],
    ])('a pool that blocks the phase (%s) says what is wrong and what to do', async (block, key) => {
        window.api.getScenarioSnapshot = jest
            .fn()
            .mockResolvedValue(
                invalid({ ...snapshot(), pool: { name: 'Wall', only: true, inOrder: false, ids: [], block } }),
            );
        await open();
        expect(screen.getByText(key)).toBeTruthy();
    });

    test('a pool that blocks nothing says nothing', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(
            invalid({
                ...snapshot(),
                pool: { name: 'Wall', only: false, inOrder: false, ids: ['a'], block: null },
            }),
        );
        await open();
        expect(screen.queryByText(/app\.scenarioPoolBlock/)).toBeNull();
    });

    test('a pause offers Resume, which asks the subject to go on', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(invalid({ ...snapshot(), paused: true }));
        window.api.resumeScenario = jest.fn().mockResolvedValue({ success: true, paused: false });
        await open();
        expect(screen.getByText('app.scenarioPaused')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'app.scenarioResume' }));
        await waitFor(() => expect(window.api.resumeScenario).toHaveBeenCalledWith('101'));
    });

    test('a lifecycle request still waiting shows the shared notice and checks by its identity', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(snapshot());
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValue(
            invalid({
                success: true,
                state: 'target',
                target: '101',
                revision: 1,
                pending: invalid({
                    requestId: 'req-9',
                    operation: 'resume-scenario',
                    target: '101',
                    status: 'pending',
                    error: null,
                    revision: 1,
                    at: 5,
                }),
                results: [],
            }),
        );
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        await screen.findByText('app.effectWaiting');
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValue(
            invalid({
                success: true,
                state: 'request',
                record: invalid({
                    requestId: 'req-9',
                    operation: 'pause-scenario',
                    target: '101',
                    status: 'applied',
                    error: null,
                    revision: 1,
                    at: 6,
                }),
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.effectCheckStatus' }));
        await waitFor(() =>
            expect(window.api.getScenarioRequestStatus).toHaveBeenLastCalledWith({ requestId: 'req-9' }),
        );
        // Giving the waiting request up hides it here; the host keeps it.
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        await waitFor(() => expect(screen.queryByText('app.effectWaiting')).toBeNull());
    });
});

const pausedSnapshot = () => ({
    success: true,
    subject: '101',
    assignment: 'Plan',
    corrupt: false,
    paused: true,
    generation: 1,
    withdrawn: false,
    base: {},
    effective: {},
    overlay: invalid({
        bound: false,
        available: true,
        reason: null,
        sources: { patch: [], literals: [], bindings: [], profile: [] },
        published: null,
    }),
    publication: null,
    schedules: { kind: 'none' },
    pins: null,
    pool: null,
});

describe('what applies now, when it does not', () => {
    test('a snapshot that cannot be read keeps the summary and says it is loading', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(invalid({ success: false, error: 'x' }));
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        expect(await screen.findByText('common.loading')).toBeTruthy();
    });

    test('a refused resume shows its error beside the button', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(
            invalid({
                success: true,
                subject: '101',
                assignment: 'Plan',
                corrupt: false,
                paused: true,
                generation: 1,
                withdrawn: false,
                base: {},
                effective: {},
                overlay: invalid({
                    bound: false,
                    available: true,
                    reason: null,
                    sources: { patch: [], literals: [], bindings: [], profile: [] },
                    published: null,
                }),
                publication: null,
                schedules: { kind: 'none' },
                pins: null,
                pool: null,
            }),
        );
        window.api.resumeScenario = jest.fn().mockResolvedValue(invalid({ success: false, error: 'busy' }));
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        fireEvent.click(await screen.findByRole('button', { name: 'app.scenarioResume' }));
        // The scenario's own wording, not the generic line: it names what to do next.
        expect(await screen.findByText('app.scenarioRefusal_busy')).toBeTruthy();
    });

    test('a resume that fails for a reason nobody worded reads the generic line', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(invalid({ ...pausedSnapshot() }));
        window.api.resumeScenario = jest.fn().mockResolvedValue(invalid({ success: false, error: 'mystery' }));
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        fireEvent.click(await screen.findByRole('button', { name: 'app.scenarioResume' }));
        expect(await screen.findByText('errors.actionFailed')).toBeTruthy();
    });

    test('an unreadable progress on resume says so', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(invalid({ ...pausedSnapshot() }));
        window.api.resumeScenario = jest.fn().mockResolvedValue(invalid({ success: false, error: 'state-unreadable' }));
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        fireEvent.click(await screen.findByRole('button', { name: 'app.scenarioResume' }));
        expect(await screen.findByText('app.scenarioRefusal_stateUnreadable')).toBeTruthy();
    });
});

describe('what applies now, on the way out', () => {
    test('a snapshot that lands after the card moved to another challenge is dropped', async () => {
        // Only the FIRST read stays out (a later one answers at once): resolving it after the move must be dropped.
        let answer!: (value: unknown) => void;
        const heldOut = new Promise((resolve) => {
            answer = resolve;
        });
        window.api.getScenarioSnapshot = jest
            .fn()
            .mockReturnValueOnce(invalid(heldOut))
            .mockReturnValue(invalid({ success: false, error: 'stale' }));
        let answerStatus!: (value: unknown) => void;
        window.api.getScenarioRequestStatus = jest
            .fn()
            .mockReturnValueOnce(
                invalid(
                    new Promise((resolve) => {
                        answerStatus = resolve;
                    }),
                ),
            )
            .mockReturnValue(
                invalid({ success: true, state: 'target', target: '102', revision: 0, pending: null, results: [] }),
            );
        const other = { id: 102, title: 'Night', url: 'night' };
        const { rerender } = render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        await waitFor(() => expect(window.api.getScenarioSnapshot).toHaveBeenCalledWith('101'));
        // The card re-reads for another challenge while the first read is still out.
        rerender(<ScenarioStatusPanel status={running} challenge={invalid(other)} />);
        answerStatus(
            invalid({
                success: true,
                state: 'target',
                target: '101',
                revision: 0,
                pending: invalid({
                    requestId: 'r1',
                    operation: 'pause-scenario',
                    target: '101',
                    status: 'pending',
                    error: null,
                    revision: 0,
                    at: 1,
                }),
                results: [],
            }),
        );
        answer(
            invalid({
                success: true,
                subject: '101',
                assignment: 'Plan',
                corrupt: false,
                paused: false,
                generation: 1,
                withdrawn: false,
                base: {},
                effective: {},
                overlay: invalid({
                    bound: false,
                    available: true,
                    reason: null,
                    sources: { patch: [], literals: [], bindings: [], profile: [] },
                    published: null,
                }),
                publication: null,
                schedules: { kind: 'none' },
                pins: null,
                pool: null,
            }),
        );
        // Nothing of the stale read shows: only the new challenge's detail is on the card.
        await waitFor(() => expect(window.api.getScenarioSnapshot).toHaveBeenCalledWith('102'));
        expect(await screen.findAllByText('app.scenarioWhatApplies')).toBeTruthy();
    });

    test('resolved schedules with no rows show nothing', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(
            invalid({
                success: true,
                subject: '101',
                assignment: 'Plan',
                corrupt: false,
                paused: false,
                generation: 1,
                withdrawn: false,
                base: {},
                effective: {},
                overlay: invalid({
                    bound: false,
                    available: true,
                    reason: null,
                    sources: { patch: [], literals: [], bindings: [], profile: [] },
                    published: null,
                }),
                publication: null,
                schedules: invalid({ kind: 'resolved', schedules: {} }),
                pins: null,
                pool: null,
            }),
        );
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        await waitFor(() => expect(screen.queryByText('app.sbDeadlines')).toBeNull());
    });
});

describe('what applies now, typed values', () => {
    /** The snapshot as the host sends it: every known value is typed (`{ kind, value, quantity }`). */
    const typed = (effective: Record<string, unknown>, literals: string[]) =>
        invalid<Record<string, unknown>>({
            success: true,
            subject: '101',
            assignment: 'Plan',
            corrupt: false,
            paused: null,
            generation: 1,
            withdrawn: false,
            base: {},
            effective,
            overlay: invalid({
                bound: true,
                available: true,
                reason: null,
                sources: { patch: [], literals, bindings: [], profile: [] },
                published: null,
            }),
            publication: null,
            schedules: { kind: 'none' },
            pins: null,
            pool: null,
        });
    const known = (value: unknown) => invalid({ state: 'known', value });

    test('a typed value reads as its inner value with its unit, never as an object', async () => {
        const at = 1_800_000_000;
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(
            typed(
                {
                    autoSubmit: known({ kind: 'boolean', value: true }),
                    autoBoost: known({ kind: 'boolean', value: false }),
                    exposure: known({ kind: 'number', value: 75, quantity: 'percent' }),
                    boostWait: known({ kind: 'number', value: 5400, quantity: 'duration' }),
                    apiTimeout: known({ kind: 'number', value: 30, quantity: 'duration' }),
                    startAt: known({ kind: 'number', value: at, quantity: 'instant' }),
                    maxSwaps: known({ kind: 'number', value: 3, quantity: 'count' }),
                    keepKeys: known({ kind: 'number', value: 2, quantity: 'keys' }),
                    timezone: known({ kind: 'string', value: 'Europe/Riga' }),
                    tags: known({ kind: 'list', value: ['pink', 'nature'] }),
                },
                [
                    'autoSubmit',
                    'autoBoost',
                    'exposure',
                    'boostWait',
                    'apiTimeout',
                    'startAt',
                    'maxSwaps',
                    'keepKeys',
                    'timezone',
                    'tags',
                ],
            ),
        );
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        await screen.findByText(/^autoSubmit: /);
        const row = (key: string) => screen.getByText(new RegExp(`^${key}: `)).textContent;
        expect(row('autoSubmit')).toBe('autoSubmit: common.on (app.scenarioSourcePhase)');
        expect(row('autoBoost')).toBe('autoBoost: common.off (app.scenarioSourcePhase)');
        expect(row('exposure')).toBe('exposure: 75% (app.scenarioSourcePhase)');
        expect(row('boostWait')).toBe('boostWait: 1 app.hours, 30 app.minutes (app.scenarioSourcePhase)');
        expect(row('apiTimeout')).toBe('apiTimeout: 30 app.sbUnit_seconds (app.scenarioSourcePhase)');
        expect(row('startAt')).toBe(`startAt: ${new Date(at * 1000).toLocaleString()} (app.scenarioSourcePhase)`);
        expect(row('maxSwaps')).toBe('maxSwaps: 3 (app.scenarioSourcePhase)');
        expect(row('keepKeys')).toBe('keepKeys: 2 app.sbQuantity_keys (app.scenarioSourcePhase)');
        expect(row('timezone')).toBe('timezone: Europe/Riga (app.scenarioSourcePhase)');
        expect(row('tags')).toBe('tags: pink, nature (app.scenarioSourcePhase)');
        expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    });
});

describe('what applies now, before the scenario starts', () => {
    const notStarted: ScenarioSummary = { name: 'Plan', phase: 'main', started: false };
    const emptySnapshot = (paused: unknown = null) =>
        invalid({
            success: true,
            subject: '101',
            assignment: 'Plan',
            corrupt: false,
            paused,
            generation: 0,
            withdrawn: false,
            base: {},
            effective: {},
            overlay: null,
            publication: null,
            schedules: null,
            pins: null,
            pool: null,
        });

    test('a scenario that has not started says so in plain words instead of an empty panel', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(emptySnapshot());
        render(<ScenarioStatusPanel status={notStarted} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        expect(await screen.findByText('app.scenarioNotStartedYet')).toBeTruthy();
    });

    test('a scenario that has started does not say it has not', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(emptySnapshot());
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        await waitFor(() => expect(window.api.getScenarioSnapshot).toHaveBeenCalled());
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        expect(screen.queryByText('app.scenarioNotStartedYet')).toBeNull();
    });
});

describe('what applies now, kept current', () => {
    const base = (paused: unknown) =>
        invalid({
            success: true,
            subject: '101',
            assignment: 'Plan',
            corrupt: false,
            paused,
            generation: 1,
            withdrawn: false,
            base: {},
            effective: {},
            overlay: null,
            publication: null,
            schedules: null,
            pins: null,
            pool: null,
        });
    const pause = { at: 5, reason: 'user' };

    test('the snapshot is read again when the card reads its status again (a pass, a phase change, a settings change)', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(base(null));
        const { rerender } = render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        await waitFor(() => expect(window.api.getScenarioSnapshot).toHaveBeenCalledTimes(1));
        // The same summary again (a render for another reason) reads nothing.
        rerender(<ScenarioStatusPanel status={running} challenge={challenge} />);
        // A new summary is the card's own re-read: the detail follows it.
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(base(pause));
        rerender(<ScenarioStatusPanel status={{ ...running }} challenge={challenge} />);
        await waitFor(() => expect(window.api.getScenarioSnapshot).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        expect(await screen.findByRole('button', { name: 'app.scenarioResume' })).toBeTruthy();
    });

    test('a resume that goes through reads the snapshot again, and the pause line goes', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValueOnce(base(pause)).mockResolvedValue(base(null));
        window.api.resumeScenario = jest.fn().mockResolvedValue({ success: true, paused: false });
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        fireEvent.click(await screen.findByRole('button', { name: 'app.scenarioResume' }));
        await waitFor(() => expect(screen.queryByText('app.scenarioPaused')).toBeNull());
        expect(window.api.getScenarioSnapshot).toHaveBeenCalledTimes(2);
    });

    test('a progress reset anywhere reads it again', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(base(null));
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        await waitFor(() => expect(window.api.getScenarioSnapshot).toHaveBeenCalledTimes(1));
        act(() => refreshScenarioStatuses());
        await waitFor(() => expect(window.api.getScenarioSnapshot).toHaveBeenCalledTimes(2));
    });

    test('a resume that is refused reads nothing again', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(base(pause));
        window.api.resumeScenario = jest.fn().mockResolvedValue(invalid({ success: false, error: 'busy' }));
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        fireEvent.click(await screen.findByRole('button', { name: 'app.scenarioResume' }));
        await screen.findByText('app.scenarioRefusal_busy');
        expect(window.api.getScenarioSnapshot).toHaveBeenCalledTimes(1);
    });

    test('the focus stays on the panel summary after Resume, never on the page', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValueOnce(base(pause)).mockResolvedValue(base(null));
        window.api.resumeScenario = jest.fn().mockResolvedValue({ success: true, paused: false });
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        const resume = await screen.findByRole<HTMLButtonElement>('button', { name: 'app.scenarioResume' });
        resume.focus();
        fireEvent.click(resume);
        await waitFor(() => expect(screen.queryByText('app.scenarioPaused')).toBeNull());
        expect(document.activeElement === screen.getByText('app.scenarioWhatApplies')).toBe(true);
    });

    test('the focus stays on the summary when the resume is refused too', async () => {
        window.api.getScenarioSnapshot = jest.fn().mockResolvedValue(base(pause));
        window.api.resumeScenario = jest.fn().mockResolvedValue(invalid({ success: false, error: 'busy' }));
        render(<ScenarioStatusPanel status={running} challenge={challenge} />);
        fireEvent.click(screen.getByText('app.scenarioWhatApplies'));
        const resume = await screen.findByRole<HTMLButtonElement>('button', { name: 'app.scenarioResume' });
        resume.focus();
        fireEvent.click(resume);
        await screen.findByText('app.scenarioRefusal_busy');
        expect(document.activeElement === screen.getByText('app.scenarioWhatApplies')).toBe(true);
    });
});
