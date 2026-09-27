/**
 * Tests for useCustomizedChallengeIds — challenge ids with manual overrides
 * or an active automatic profile.
 */

import { act, render, screen, waitFor } from './helpers/test-utils';
import { fireSettingsChanged } from './helpers/setup';
import { useCustomizedChallengeIds } from '@/hooks/useCustomizedChallengeIds';
import { invalid } from '../helpers/invalid';

function Probe({ challenges }: { challenges: Parameters<typeof useCustomizedChallengeIds>[0] }) {
    const ids = useCustomizedChallengeIds(challenges);
    return <div data-testid="ids">{[...ids].map(([id, kind]) => `${id}:${kind}`).join(',')}</div>;
}

beforeEach(() => {
    window.api.getChallengeOverrides = jest.fn(async (id: string | number) => {
        if (id === '1') return { boostTime: 30 };
        if (id === '2') return {};
        return null; // handler's error fallback
    });
    window.api.getTitleProfile = jest.fn().mockResolvedValue(null);
});

test('marks only ids whose override map is non-empty', async () => {
    render(
        <Probe
            challenges={[
                { id: 1, title: 'One' },
                { id: 2, title: 'Two' },
                { id: 3, title: 'Three' },
            ]}
        />,
    );
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('1:manual'));
    expect(jest.mocked(window.api.getChallengeOverrides).mock.calls.map((c) => c[0])).toEqual(['1', '2', '3']);
});

test('skips missing ids and de-duplicates repeats before querying', async () => {
    render(
        <Probe challenges={invalid([null, { id: null }, {}, { id: 1, title: 'One' }, { id: '1', title: 'One' }])} />,
    );
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('1:manual'));
    expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1);
    expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('1');
});

test('an empty list issues no IPC and yields an empty set', async () => {
    render(<Probe challenges={[]} />);
    // Let the mount fetch settle.
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe(''));
    expect(window.api.getChallengeOverrides).not.toHaveBeenCalled();
    expect(window.api.getTitleProfile).not.toHaveBeenCalled();
});

test('marks an active automatic profile but not a suppressed one', async () => {
    jest.mocked(window.api.getTitleProfile).mockImplementation(async (_title, id) =>
        id === '2'
            ? { name: '4 pics', values: {}, suppressed: false }
            : { name: '4 pics', values: {}, suppressed: true },
    );
    render(
        <Probe
            challenges={[
                { id: 2, title: 'Profiled' },
                { id: 3, title: 'Suppressed' },
            ]}
        />,
    );

    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('2:profile'));
    expect(window.api.getTitleProfile).toHaveBeenCalledWith('Profiled', '2');
});

test('manual overrides and an automatic profile can both apply', async () => {
    jest.mocked(window.api.getTitleProfile).mockResolvedValue({ name: '4 pics', values: {}, suppressed: false });
    render(<Probe challenges={[{ id: 1, title: 'Manual' }]} />);

    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('1:both'));
    expect(window.api.getTitleProfile).toHaveBeenCalledWith('Manual', '1');
});

const deferred = () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
};

test('a settings change during a read gets its own read, and the older read cannot overwrite it', async () => {
    const first = deferred();
    window.api.getChallengeOverrides = jest
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue({ boostTime: 30 });
    render(<Probe challenges={[{ id: 1, title: 'One' }]} />);
    await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1));

    // The override is saved while the first read is still in flight.
    await act(async () => {
        fireSettingsChanged();
    });
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('1:manual'));
    expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(2);

    // The stale first read (from before the save) settles last and is dropped.
    await act(async () => first.resolve({}));
    expect(screen.getByTestId('ids').textContent).toBe('1:manual');
});

test('a new challenge list during a read is read too', async () => {
    const first = deferred();
    window.api.getChallengeOverrides = invalid(
        jest.fn((id: string | number) => (id === '1' ? first.promise : Promise.resolve({ boostTime: 5 }))),
    );
    const { rerender } = render(<Probe challenges={[{ id: 1, title: 'One' }]} />);
    await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('1'));

    rerender(<Probe challenges={[{ id: 2, title: 'Two' }]} />);
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('2:manual'));

    await act(async () => first.resolve({ boostTime: 1 }));
    expect(screen.getByTestId('ids').textContent).toBe('2:manual');
});
