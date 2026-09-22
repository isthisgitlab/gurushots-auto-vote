/**
 * Tests for useOverriddenChallengeIds — the set of challenge ids that carry at
 * least one per-challenge override, read one getChallengeOverrides call per id.
 */

import { render, screen, waitFor } from './helpers/test-utils';
import { useOverriddenChallengeIds } from '@/hooks/useOverriddenChallengeIds';

function Probe({ challenges }) {
    const ids = useOverriddenChallengeIds(challenges);
    return <div data-testid="ids">{[...ids].join(',')}</div>;
}

beforeEach(() => {
    window.api.getChallengeOverrides = jest.fn(async (id) => {
        if (id === '1') return { boostTime: 30 };
        if (id === '2') return {};
        return null; // handler's error fallback
    });
});

test('marks only ids whose override map is non-empty', async () => {
    render(<Probe challenges={[{ id: 1 }, { id: 2 }, { id: 3 }]} />);
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('1'));
    expect(window.api.getChallengeOverrides.mock.calls.map((c) => c[0])).toEqual(['1', '2', '3']);
});

test('skips missing ids and de-duplicates repeats before querying', async () => {
    render(<Probe challenges={[null, { id: null }, {}, { id: 1 }, { id: '1' }]} />);
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('1'));
    expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1);
    expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('1');
});

test('an empty list issues no IPC and yields an empty set', async () => {
    render(<Probe challenges={[]} />);
    // Let the mount fetch settle.
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe(''));
    expect(window.api.getChallengeOverrides).not.toHaveBeenCalled();
});
