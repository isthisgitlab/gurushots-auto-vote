/**
 * The three reads the scenario editors lean on — the installation assignment and its generation, the profiles a phase may apply,
 * and the account's photo pools — each answers for the latest read only, and a read that is lost says so by clearing what it was
 * meant to renew (a generation to state, a list of eligible names) rather than leaving the old one to be used.
 */

import { renderHook, waitFor, act } from '@testing-library/preact';
import { useInstallationScenario } from '@/api/useInstallationScenario';
import { usePhaseProfiles } from '@/api/usePhaseProfiles';
import { usePhotoPools } from '@/api/usePhotoPools';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

const held = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};
type Assignment = Awaited<ReturnType<typeof window.api.getInstallationScenario>>;
const assignment = (generation: number) =>
    invalid<Assignment>({ success: true, installation: { scenario: 'Ops', executor: 'cli', generation }, generation });

beforeEach(() => {
    window.api = invalid(mockApi);
    jest.clearAllMocks();
    mockApi.getInstallationScenario.mockReset();
    mockApi.getPhaseProfiles.mockReset();
    mockApi.getPhotoPools.mockReset();
});

describe('useInstallationScenario', () => {
    test('reads the assignment and its generation', async () => {
        mockApi.getInstallationScenario.mockResolvedValue(assignment(3));
        const { result } = renderHook(() => useInstallationScenario());
        await waitFor(() => expect(result.current.generation).toBe(3));
        expect(result.current.installation).toEqual({ scenario: 'Ops', executor: 'cli', generation: 3 });
    });

    test('a rejected read clears the generation, as a failure reply does, and the old one is not used again', async () => {
        mockApi.getInstallationScenario.mockResolvedValueOnce(assignment(3)).mockRejectedValueOnce(new Error('lost'));
        const { result } = renderHook(() => useInstallationScenario());
        await waitFor(() => expect(result.current.generation).toBe(3));
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.generation).toBeNull();
        mockApi.getInstallationScenario.mockResolvedValueOnce(invalid({ success: false, error: 'x' }));
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.generation).toBeNull();
    });

    test('a read made after a change drops the generation first, and states the new one only when that read succeeds', async () => {
        mockApi.getInstallationScenario.mockResolvedValueOnce(assignment(3));
        const { result } = renderHook(() => useInstallationScenario());
        await waitFor(() => expect(result.current.generation).toBe(3));
        const next = held<unknown>();
        mockApi.getInstallationScenario.mockImplementationOnce(() => next.promise as never);
        let reading!: Promise<void>;
        await act(async () => {
            reading = result.current.refetch();
        });
        expect(result.current.generation).toBeNull();
        await act(async () => {
            next.resolve(assignment(4));
            await reading;
        });
        expect(result.current.generation).toBe(4);
    });

    test('a slower, older read never replaces a newer one', async () => {
        const old = held<unknown>();
        mockApi.getInstallationScenario.mockImplementationOnce(() => old.promise as never);
        const { result } = renderHook(() => useInstallationScenario());
        mockApi.getInstallationScenario.mockResolvedValueOnce(assignment(5));
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.generation).toBe(5);
        await act(async () => {
            old.resolve(assignment(2));
        });
        expect(result.current.generation).toBe(5);
    });
});

describe('usePhaseProfiles', () => {
    test('lists the names the host answers', async () => {
        mockApi.getPhaseProfiles.mockResolvedValue({ success: true, profiles: ['Evening'] });
        const { result } = renderHook(() => usePhaseProfiles());
        await waitFor(() => expect(result.current).toEqual(['Evening']));
    });

    test.each([
        ['rejects', () => mockApi.getPhaseProfiles.mockRejectedValue(new Error('lost'))],
        ['answers a failure', () => mockApi.getPhaseProfiles.mockResolvedValue({ success: false, error: 'x' })],
    ])(
        'a read that %s clears the names: a profile the host may no longer accept is not offered',
        async (_label, fail) => {
            let change!: () => void;
            window.api = invalid({
                ...mockApi,
                onSettingsChanged: (listener: () => void) => {
                    change = listener;
                    return () => undefined;
                },
            });
            mockApi.getPhaseProfiles.mockResolvedValueOnce({ success: true, profiles: ['Evening'] });
            const { result } = renderHook(() => usePhaseProfiles());
            await waitFor(() => expect(result.current).toEqual(['Evening']));
            // The next read (a settings change) is the one that is lost or refused.
            fail();
            await act(async () => {
                change();
            });
            await waitFor(() => expect(result.current).toEqual([]));
        },
    );

    test('an older read that answers after a newer one changes nothing', async () => {
        const old = held<unknown>();
        mockApi.getPhaseProfiles.mockImplementationOnce(() => old.promise as never);
        let change!: () => void;
        window.api = invalid({
            ...mockApi,
            onSettingsChanged: (listener: () => void) => {
                change = listener;
                return () => undefined;
            },
        });
        const { result } = renderHook(() => usePhaseProfiles());
        mockApi.getPhaseProfiles.mockResolvedValueOnce({ success: true, profiles: [] });
        await act(async () => {
            change();
        });
        await act(async () => {
            old.resolve({ success: true, profiles: ['Gone'] });
        });
        expect(result.current).toEqual([]);
    });
});

describe('usePhotoPools', () => {
    test('confirm puts a pool in the list at once, and a read already on its way does not replace it', async () => {
        const old = held<unknown>();
        mockApi.getPhotoPools.mockImplementationOnce(() => old.promise as never);
        const { result } = renderHook(() => usePhotoPools());
        await act(async () => {
            result.current.confirm('Beach', ['p1', 'p2']);
        });
        expect(result.current.pools).toEqual({ Beach: ['p1', 'p2'] });
        await act(async () => {
            old.resolve({ success: true, pools: { Other: ['o'] } });
        });
        expect(result.current.pools).toEqual({ Beach: ['p1', 'p2'] });
    });

    test('the read after it is the truth, and a failed one leaves the confirmed pool where it is', async () => {
        mockApi.getPhotoPools.mockResolvedValueOnce({ success: true, pools: {} });
        const { result } = renderHook(() => usePhotoPools());
        await waitFor(() => expect(mockApi.getPhotoPools).toHaveBeenCalled());
        await act(async () => {
            result.current.confirm('Beach', ['p1']);
        });
        mockApi.getPhotoPools.mockResolvedValueOnce({ success: false, error: 'x' });
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.pools).toEqual({ Beach: ['p1'] });
        mockApi.getPhotoPools.mockResolvedValueOnce({ success: true, pools: { Beach: ['p1'], Late: ['l'] } });
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.pools).toEqual({ Beach: ['p1'], Late: ['l'] });
    });
});
