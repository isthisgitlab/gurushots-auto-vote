/**
 * The card's scenario status line: scenario, phase, next check and the last
 * problem; warnings for a missing scenario or unreadable progress.
 */

import { cleanup, fireEvent, render, screen } from './helpers/test-utils';
import { ScenarioStatusLine } from '@/components/app/ScenarioStatusLine';
import type { ScenarioSummary } from '@/api/useScenarioStatus';
import { mockTranslator } from './helpers/setup';

const NOW = Math.floor(Date.now() / 1000);

test('renders nothing without a scenario', () => {
    const { container } = render(<ScenarioStatusLine status={null} />);
    expect(container.textContent).toBe('');
});

test.each<[ScenarioSummary, string]>([
    [{ name: 'Gone', missing: true }, 'app.scenarioStatusMissing'],
    [{ name: 'Plan', corrupt: 'file' }, 'app.scenarioStatusCorrupt'],
    [{ name: 'Plan', corrupt: 'record' }, 'app.scenarioStatusCorruptRecord'],
    [{ name: 'Plan', corrupt: 'unloaded' }, 'app.scenarioStatusUnloaded'],
])('warns for %p', (status, key) => {
    render(<ScenarioStatusLine status={status} />);
    expect(screen.getByRole('status').textContent).toContain(key);
});

test('a running plan: phase, next check and last problem (detail)', () => {
    render(
        <ScenarioStatusLine
            status={{ name: 'Plan', phase: 'holding', started: true, lastError: 'no slot', nextWakeAt: NOW + 3600 }}
        />,
    );
    expect(screen.getByTitle('Plan').textContent).toContain('Plan · app.scenarioStatusPhase · app.scenarioStatusNext');
    expect(screen.getByRole('status').textContent).toBe('app.scenarioStatusProblem');
});

test.each([
    [false, 'app.scenarioStatusPausedManual'],
    [true, 'app.scenarioStatusPausedManualShort'],
])('Manual Only pauses the plan: compact=%s says so in place of a countdown', (compact, key) => {
    render(
        <ScenarioStatusLine
            compact={compact}
            status={{ name: 'Plan', phase: 'main', started: true, lastError: null, manualOnly: true, nextWakeAt: null }}
        />,
    );
    expect(screen.getByTitle('Plan').textContent).toBe(`🧭 Plan · app.scenarioStatusPhase · ${key}`);
    expect(screen.queryByText(/scenarioStatusNext/)).toBeNull();
});

test.each([[false], [true]])(
    'a paused plan that has not started does not promise the next run, and adds no paused suffix (compact=%s)',
    (compact) => {
        render(
            <ScenarioStatusLine
                compact={compact}
                status={{
                    name: 'Plan',
                    phase: 'main',
                    started: false,
                    lastError: null,
                    manualOnly: true,
                    nextWakeAt: null,
                }}
            />,
        );
        expect(screen.getByTitle('Plan').textContent).toBe('🧭 Plan · app.scenarioStatusNotStartedManual');
    },
);

test('a plan that has not started, with the switch off, still starts on the next run', () => {
    render(<ScenarioStatusLine status={{ name: 'Plan', phase: 'main', started: false, lastError: null }} />);
    expect(screen.getByTitle('Plan').textContent).toBe('🧭 Plan · app.scenarioStatusNotStarted');
});

const unclear = (over: Partial<NonNullable<ScenarioSummary['spendUnclear']>> = {}): ScenarioSummary => ({
    name: 'Plan',
    phase: 'main',
    started: true,
    lastError: 'r1 → unlockBoost: …',
    spendUnclear: {
        action: 'unlockBoost',
        stopped: false,
        again: 'phase',
        challengeId: 7,
        newerProblem: false,
        origin: 'unclear',
        ...over,
    },
    nextWakeAt: null,
});

const WORDS: Record<string, string> = {
    'app.scenarioStatusSpendUnclear': 'Not spent again: “{action}”',
    'app.scenarioStatusSpendStopped': 'Rule stopped: “{action}”. {hint}',
    'app.scenarioStatusResetHint': '{again} Reset: --challenge={id}',
    'app.scenarioStatusAgainPhase': 'phase again',
    'app.scenarioStatusAgainReset': 'reset only',
    'app.scenarioStatusAgainDay': 'next day',
    'app.sbAct_unlockBoost': 'Unlock the boost with a key',
    'app.scenarioStatusProblem': 'Problem: {message}',
};

describe('with the card’s words', () => {
    beforeEach(() => mockTranslator.t.mockImplementation((k) => WORDS[k] ?? k));
    afterEach(() => mockTranslator.t.mockImplementation((k) => k));

    test("a spend that got no answer is worded as that, with the action's own label, not as a skipped step", () => {
        render(<ScenarioStatusLine status={unclear()} />);
        expect(screen.getByRole('status').textContent).toBe('Not spent again: “Unlock the boost with a key”');
    });

    test.each([
        ['phase', 'phase again'],
        ['reset', 'reset only'],
        ['day', 'next day'],
    ] as const)(
        'a rule stopped after one says when it can run again (%s) and names the reset for its challenge',
        (again, words) => {
            render(<ScenarioStatusLine status={unclear({ stopped: true, again })} />);
            expect(screen.getByRole('status').textContent).toBe(
                `Rule stopped: “Unlock the boost with a key”. ${words} Reset: --challenge=7`,
            );
        },
    );

    test('a problem that came after the stop is shown beside it; an older one is not', () => {
        render(<ScenarioStatusLine status={unclear({ stopped: true, newerProblem: true })} />);
        expect(screen.getAllByRole('status').map((line) => line.textContent)).toEqual([
            expect.stringContaining('Rule stopped'),
            'Problem: r1 → unlockBoost: …',
        ]);
        cleanup();
        render(<ScenarioStatusLine status={unclear({ stopped: true })} />);
        expect(screen.getAllByRole('status')).toHaveLength(1);
    });
});

test.each([
    ['unclear', 'app.scenarioStatusSpendUnclearManual'],
    ['pending', 'app.scenarioStatusSpendUnclearPendingManual'],
] as const)(
    'under Manual Only the %s notice says the check waits for the switch, not the next cycle',
    (origin, key) => {
        render(<ScenarioStatusLine status={{ ...unclear({ origin }), manualOnly: true, lastError: null }} />);
        expect(screen.getByRole('status').textContent).toBe(key);
    },
);

test('a spend that got no answer is shown even when an unrelated problem has replaced the last error', () => {
    render(<ScenarioStatusLine status={{ ...unclear({ action: 'swap' }), lastError: null }} />);
    expect(screen.getByRole('status').textContent).toBe('app.scenarioStatusSpendUnclear');
});

test('a spend that got no answer is clamped in the compact line', () => {
    render(<ScenarioStatusLine status={{ ...unclear({ stopped: true }), lastError: null }} compact />);
    expect(screen.getByRole('status').className).toContain('line-clamp-2');
});

describe('the reset button', () => {
    const stoppedStatus = (over: Partial<NonNullable<ScenarioSummary['spendUnclear']>> = {}) => ({
        ...unclear({ stopped: true, ...over }),
        lastError: null,
    });

    test('is offered on the card for a stopped rule, and presses through', () => {
        const onReset = jest.fn();
        render(<ScenarioStatusLine status={stoppedStatus()} onReset={onReset} />);
        fireEvent.click(screen.getByText('app.scenarioReset'));
        expect(onReset).toHaveBeenCalledTimes(1);
    });

    test('the reset is a destructive (filled error) button', () => {
        render(<ScenarioStatusLine status={stoppedStatus()} onReset={jest.fn()} />);
        const button = screen.getByRole('button', { name: 'app.scenarioReset' });
        expect(button.className).toContain('btn-error');
        expect(button.className).not.toContain('btn-outline');
    });

    test('is offered, for every challenge, when the whole file of progress cannot be read', () => {
        const onReset = jest.fn();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'file' }} onReset={onReset} />);
        fireEvent.click(screen.getByText('app.scenarioResetAll'));
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('app.scenarioReset')).toBeNull();
    });

    test('is not offered for progress that was not loaded yet: nothing is known of it, and nothing is reset', () => {
        const onReset = jest.fn();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'unloaded' }} onReset={onReset} />);
        expect(screen.queryByText('app.scenarioReset')).toBeNull();
        expect(screen.queryByText('app.scenarioResetAll')).toBeNull();
        cleanup();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'unloaded' }} compact />);
        expect(screen.getByRole('status').textContent).toContain('app.scenarioStatusUnloadedShort');
    });

    test('with the background service only this window lacks the progress, and the notice says the plans go on', () => {
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'unloaded', serviceRuns: true }} />);
        expect(screen.getByRole('status').textContent).toContain('app.scenarioStatusUnloadedService');
        cleanup();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'unloaded', serviceRuns: true }} compact />);
        expect(screen.getByRole('status').textContent).toContain('app.scenarioStatusUnloadedServiceShort');
        cleanup();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'unloaded', serviceRuns: false }} />);
        expect(screen.getByRole('status').textContent).toContain('app.scenarioStatusUnloaded');
        expect(screen.getByRole('status').textContent).not.toContain('Service');
    });

    test('is the reset of this challenge alone when only its record cannot be read', () => {
        const onReset = jest.fn();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'record' }} onReset={onReset} />);
        fireEvent.click(screen.getByText('app.scenarioReset'));
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('app.scenarioResetAll')).toBeNull();
    });

    test.each([
        ['a stopped rule', stoppedStatus(), 'app.scenarioReset'],
        ['unreadable progress', { name: 'Plan', corrupt: 'file' as const }, 'app.scenarioResetAll'],
    ])('stays outside the live region that announces the notice (%s)', (_name, status, label) => {
        render(<ScenarioStatusLine status={status} onReset={jest.fn()} />);
        const button = screen.getByText(label);
        expect(button.closest('[role="status"]')).toBeNull();
        for (const region of screen.getAllByRole('status')) expect(region.contains(button)).toBe(false);
    });

    test.each([
        ['a rule only being checked on', unclear()],
        ['a plan with nothing stopped', { name: 'Plan', phase: 'main', started: true, lastError: null }],
        ['a scenario that no longer exists', { name: 'Gone', missing: true as const }],
    ])('is not offered for %s', (_name, status) => {
        render(<ScenarioStatusLine status={status} onReset={jest.fn()} />);
        expect(screen.queryByText('app.scenarioReset')).toBeNull();
        expect(screen.queryByText('app.scenarioResetAll')).toBeNull();
    });

    test('is not offered where there is no dialog to open it (no handler: the compact tile has none)', () => {
        render(<ScenarioStatusLine status={stoppedStatus()} />);
        expect(screen.queryByText('app.scenarioReset')).toBeNull();
        cleanup();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'file' }} />);
        expect(screen.queryByText('app.scenarioResetAll')).toBeNull();
    });

    test('the compact tile gets a short notice, whole, where the card has the long one', () => {
        render(<ScenarioStatusLine status={stoppedStatus()} compact />);
        expect(screen.getByRole('status').textContent).toBe('app.scenarioStatusSpendStoppedShort');
        cleanup();
        render(<ScenarioStatusLine status={stoppedStatus()} />);
        expect(screen.getByRole('status').textContent).toBe('app.scenarioStatusSpendStopped');
        cleanup();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'file' }} compact />);
        expect(screen.getByRole('status').textContent).toContain('app.scenarioStatusCorruptShort');
        cleanup();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'file' }} />);
        expect(screen.getByRole('status').textContent).toContain('app.scenarioStatusCorrupt');
        expect(screen.getByRole('status').textContent).not.toContain('Short');
        cleanup();
        render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'record' }} compact />);
        expect(screen.getByRole('status').textContent).toContain('app.scenarioStatusCorruptRecordShort');
    });

    test('a spend the app did not record, being checked on, says so too', () => {
        render(<ScenarioStatusLine status={unclear({ origin: 'pending' })} />);
        expect(screen.getByRole('status').textContent).toBe('app.scenarioStatusSpendUnclearPending');
    });

    test('a rule stopped before the app knew whether the spend was sent says so, on the card and on the tile', () => {
        render(<ScenarioStatusLine status={stoppedStatus({ origin: 'pending' })} />);
        expect(screen.getByRole('status').textContent).toBe('app.scenarioStatusSpendStoppedPending');
        cleanup();
        render(<ScenarioStatusLine status={stoppedStatus({ origin: 'pending' })} compact />);
        expect(screen.getByRole('status').textContent).toBe('app.scenarioStatusSpendStoppedPendingShort');
    });

    test('an unreadable-progress notice names the reset control by its own label, not a fixed word', () => {
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.scenarioReset'
                ? 'Clear'
                : key === 'app.scenarioResetAll'
                  ? 'Clear all'
                  : key === 'app.scenarioStatusCorruptShort' || key === 'app.scenarioStatusCorruptRecordShort'
                    ? 'Press “{reset}”.'
                    : key,
        );
        try {
            render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'file' }} compact />);
            expect(screen.getByRole('status').textContent).toContain('Press “Clear all”.');
            cleanup();
            render(<ScenarioStatusLine status={{ name: 'Plan', corrupt: 'record' }} compact />);
            expect(screen.getByRole('status').textContent).toContain('Press “Clear”.');
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('a short notice names the control that opens the card, by its own label', () => {
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.details'
                ? 'Details'
                : key === 'app.scenarioStatusSpendStoppedShort'
                  ? 'Press “{details}” for more.'
                  : key,
        );
        try {
            render(<ScenarioStatusLine status={stoppedStatus()} compact />);
            expect(screen.getByRole('status').textContent).toBe('Press “Details” for more.');
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });
});

test('a plan not started, with nothing pending or already due (compact)', () => {
    const { rerender } = render(
        <ScenarioStatusLine
            status={{ name: 'Plan', phase: 'main', started: false, lastError: null, nextWakeAt: null }}
            compact
        />,
    );
    expect(screen.getByTitle('Plan').textContent).toBe('🧭 Plan · app.scenarioStatusNotStarted');
    rerender(
        <ScenarioStatusLine
            status={{ name: 'Plan', phase: 'main', started: true, lastError: 'x', nextWakeAt: NOW - 5 }}
            compact
        />,
    );
    expect(screen.getByTitle('Plan').textContent).toBe('🧭 Plan · app.scenarioStatusPhase');
    expect(screen.getByRole('status')).toBeTruthy();
});
