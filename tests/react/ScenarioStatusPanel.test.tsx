/**
 * The card's scenario status with its reset dialog: what the dialog resets is settled when it opens.
 */

import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { ScenarioStatusPanel } from '@/components/app/ScenarioStatusPanel';
import type { ScenarioSummary } from '@/api/useScenarioStatus';

const challenge = { id: 101, title: 'Sunset', url: 'sunset' };
const corrupt = (kind: 'file' | 'record'): ScenarioSummary => ({ name: 'Plan', corrupt: kind });

beforeEach(() => {
    window.api.resetScenarioState = jest.fn().mockResolvedValue({ success: true });
    window.api.resetAllScenarioState = jest.fn().mockResolvedValue({ success: true });
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
