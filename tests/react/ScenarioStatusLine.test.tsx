/**
 * The card's scenario status line: scenario, phase, next check and the last
 * problem; warnings for a missing scenario or unreadable progress.
 */

import { render, screen } from './helpers/test-utils';
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
    [{ name: 'Plan', corrupt: true }, 'app.scenarioStatusCorrupt'],
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
    [false, 'app.scenarioStatusSpendUnclear', 'Not spent again: “Unlock the boost with a key”'],
    [true, 'app.scenarioStatusSpendStopped', 'Rule stopped: “Unlock the boost with a key”'],
])(
    "a spend that got no answer is worded as that (stopped: %s), with the action's own label, not as a skipped step",
    (stopped, key, text) => {
        mockTranslator.t.mockImplementation((k) =>
            k === key
                ? text.replace('Unlock the boost with a key', '{action}')
                : k === 'app.sbAct_unlockBoost'
                  ? 'Unlock the boost with a key'
                  : k,
        );
        try {
            render(
                <ScenarioStatusLine
                    status={{
                        name: 'Plan',
                        phase: 'main',
                        started: true,
                        lastError: 'r1 → unlockBoost: …',
                        spendUnclear: { action: 'unlockBoost', stopped },
                        nextWakeAt: null,
                    }}
                />,
            );
            expect(screen.getByRole('status').textContent).toBe(text);
        } finally {
            mockTranslator.t.mockImplementation((k) => k);
        }
    },
);

test('a spend that got no answer is shown even when an unrelated problem has replaced the last error', () => {
    render(
        <ScenarioStatusLine
            status={{
                name: 'Plan',
                phase: 'main',
                started: true,
                lastError: null,
                spendUnclear: { action: 'swap', stopped: false },
                nextWakeAt: null,
            }}
        />,
    );
    expect(screen.getByRole('status').textContent).toBe('app.scenarioStatusSpendUnclear');
});

test('a spend that got no answer is clamped in the compact line', () => {
    render(
        <ScenarioStatusLine
            status={{
                name: 'Plan',
                phase: 'main',
                started: true,
                lastError: null,
                spendUnclear: { action: 'swap', stopped: true },
                nextWakeAt: null,
            }}
            compact
        />,
    );
    expect(screen.getByRole('status').className).toContain('line-clamp-2');
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
