/**
 * The card's scenario status line: scenario, phase, next check and the last
 * problem; warnings for a missing scenario or unreadable progress.
 */

import { render, screen } from './helpers/test-utils';
import { ScenarioStatusLine } from '@/components/app/ScenarioStatusLine';

const NOW = Math.floor(Date.now() / 1000);

test('renders nothing without a scenario', () => {
    const { container } = render(<ScenarioStatusLine status={null} />);
    expect(container.textContent).toBe('');
});

test.each([
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
