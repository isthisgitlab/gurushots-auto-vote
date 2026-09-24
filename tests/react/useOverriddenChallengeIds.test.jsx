/**
 * Tests for useOverriddenChallengeIds — the set of challenge ids that carry at
 * least one per-challenge override, read one getChallengeOverrides call per id.
 */

import { act, render, screen, waitFor } from './helpers/test-utils';
import { fireSettingsChanged } from './helpers/setup';
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

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
};

test('a settings change during a read gets its own read, and the older read cannot overwrite it', async () => {
    const first = deferred();
    window.api.getChallengeOverrides = jest
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue({ boostTime: 30 });
    render(<Probe challenges={[{ id: 1 }]} />);
    await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1));

    // The override is saved while the first read is still in flight.
    await act(async () => {
        fireSettingsChanged();
    });
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('1'));
    expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(2);

    // The stale first read (from before the save) settles last and is dropped.
    await act(async () => first.resolve({}));
    expect(screen.getByTestId('ids').textContent).toBe('1');
});

test('a new challenge list during a read is read too', async () => {
    const first = deferred();
    window.api.getChallengeOverrides = jest.fn((id) =>
        id === '1' ? first.promise : Promise.resolve({ boostTime: 5 }),
    );
    const { rerender } = render(<Probe challenges={[{ id: 1 }]} />);
    await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('1'));

    rerender(<Probe challenges={[{ id: 2 }]} />);
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('2'));

    await act(async () => first.resolve({ boostTime: 1 }));
    expect(screen.getByTestId('ids').textContent).toBe('2');
});
