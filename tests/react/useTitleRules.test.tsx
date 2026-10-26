/**
 * useTitleRules — the rule editor's dirty tracking against the saved rules,
 * and the settings-changed refresh that follows rule/profile writes while the
 * modal is open.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useTitleRules } from '@/hooks/useTitleRules';
import { fireSettingsChanged, mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

import type { ChallengeValues, TitleRule } from '../../src/ts/types/settings';

const RULE_A: TitleRule = { title: 'A', mustIncludeTags: ['x'] };

/**
 * A fireSettingsChanged whose refresh settles before the assertions run:
 * preact defers the refresh's continuation (and effect cleanups) past act's
 * flush, and a macrotask tick drains both.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fire = async () => {
    await act(async () => {
        fireSettingsChanged();
    });
    await tick();
};

// The tests set persistent mock answers; hand the setup defaults back so no
// implementation leaks into the next test (setup's clearAllMocks keeps them).
afterEach(() => {
    mockApi.getTitleRules.mockReset().mockResolvedValue([]);
    mockApi.getChallengeProfiles.mockReset().mockResolvedValue({});
    mockApi.setTitleRules.mockReset().mockResolvedValue(true);
});

/** Renders the hook open on a settled load, then clears the fetch counters. */
const openOn = async (rules: TitleRule[], profiles: Record<string, ChallengeValues>) => {
    mockApi.getTitleRules.mockResolvedValue(invalid(rules));
    mockApi.getChallengeProfiles.mockResolvedValue(invalid(profiles));
    const hook = renderHook(() => useTitleRules(true));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    mockApi.getTitleRules.mockClear();
    mockApi.getChallengeProfiles.mockClear();
    return hook;
};

describe('isDirty', () => {
    const loaded = async (rules: unknown[] = [{ title: 'A', mustIncludeTags: ['x'] }]) => {
        mockApi.getTitleRules.mockResolvedValue(invalid(rules));
        const hook = renderHook(() => useTitleRules(true));
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        return hook;
    };

    test('is false while loading and when the load failed', async () => {
        mockApi.getTitleRules.mockReturnValue(new Promise(() => {}));
        const pending = renderHook(() => useTitleRules(true));
        expect(pending.result.current.isDirty()).toBe(false);
        pending.unmount();

        mockApi.getTitleRules.mockRejectedValue(new Error('disk'));
        const failed = renderHook(() => useTitleRules(true));
        await waitFor(() => expect(failed.result.current.loadFailed).toBe(true));
        act(() => failed.result.current.change([{ title: 'typed anyway' }]));
        expect(failed.result.current.isDirty()).toBe(false);
    });

    test('an edit is dirty and putting it back is not', async () => {
        const { result } = await loaded();
        expect(result.current.isDirty()).toBe(false);

        act(() => result.current.change([{ title: 'A', mustIncludeTags: ['x', 'y'] }]));
        expect(result.current.isDirty()).toBe(true);
        act(() => result.current.change([{ title: 'A', mustIncludeTags: ['x'] }]));
        expect(result.current.isDirty()).toBe(false);
    });

    test('the same rule with its keys in another order is not an edit', async () => {
        const { result } = await loaded();
        act(() => result.current.change([{ mustIncludeTags: ['x'], title: 'A' }]));
        expect(result.current.isDirty()).toBe(false);
        act(() => result.current.change([{ mustIncludeTags: ['y', 'x'], title: 'A' }]));
        expect(result.current.isDirty()).toBe(true);
    });

    test('a persist that landed moves the baseline; a rejected one does not', async () => {
        const { result } = await loaded();
        act(() => result.current.change([{ title: 'B' }]));

        mockApi.setTitleRules.mockResolvedValueOnce(false);
        await act(async () => {
            await result.current.persist();
        });
        expect(result.current.isDirty()).toBe(true);

        mockApi.setTitleRules.mockResolvedValueOnce(true);
        await act(async () => {
            await result.current.persist();
        });
        expect(result.current.isDirty()).toBe(false);
    });
});

describe('the settings-changed refresh — clean editor', () => {
    test('a profile saved elsewhere arrives in profiles after a broadcast', async () => {
        const { result } = await openOn([RULE_A], { tactic: { exposure: 80 } });

        mockApi.getTitleRules.mockResolvedValue(invalid([RULE_A]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({ tactic: { exposure: 80 }, brand: { exposure: 90 } }));
        await fire();

        expect(result.current.profiles).toEqual({ tactic: { exposure: 80 }, brand: { exposure: 90 } });
        expect(result.current.rules).toEqual([RULE_A]);
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(1);
    });

    test('a re-cased profile reaches an unedited rule through the fresh rules', async () => {
        const { result } = await openOn([{ title: 'A', profile: 'tactic', mustIncludeTags: ['x'] }], {
            tactic: { exposure: 80 },
        });

        mockApi.getTitleRules.mockResolvedValue(invalid([{ title: 'A', profile: 'Tactic', mustIncludeTags: ['x'] }]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({ Tactic: { exposure: 80 } }));
        await fire();

        expect(result.current.profiles).toEqual({ Tactic: { exposure: 80 } });
        expect(result.current.rules).toEqual([{ title: 'A', profile: 'Tactic', mustIncludeTags: ['x'] }]);
        expect(result.current.isDirty()).toBe(false);
    });

    test('a deleted profile disappears, and an unedited rule that used it is replaced by the disk rules', async () => {
        const { result } = await openOn([{ title: 'A', profile: 'gone', mustIncludeTags: ['x'] }], {
            gone: { exposure: 80 },
        });

        mockApi.getTitleRules.mockResolvedValue(invalid([{ title: 'A', mustIncludeTags: ['x'] }]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({}));
        await fire();

        expect(result.current.profiles).toEqual({});
        expect(result.current.rules).toEqual([{ title: 'A', mustIncludeTags: ['x'] }]);
    });

    test('a draft rule with no profile is untouched, and a whitespace/case variant reconciles to the fresh name', async () => {
        const free = { title: 'Free', mustIncludeTags: ['f'] };
        const variant = { title: 'Var', profile: '  TACTIC ', mustIncludeTags: [] };
        const { result } = await openOn([free, variant], { tactic: { exposure: 80 } });

        const draft: TitleRule[] = [free, variant, { title: 'Ed', mustIncludeTags: [] }];
        act(() => result.current.change(draft));
        expect(result.current.isDirty()).toBe(true);

        mockApi.getTitleRules.mockResolvedValue(invalid([free, variant, { title: 'Ed', mustIncludeTags: [] }]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({ tactic: { exposure: 80 } }));
        await fire();

        expect(result.current.rules[0]).toBe(free); // untouched, same object
        expect(result.current.rules[1]).toEqual({ title: 'Var', profile: 'tactic', mustIncludeTags: [] });
    });

    test('a refresh answering malformed payloads keeps the state and logs', async () => {
        const loadedProfiles = { tactic: { exposure: 80 } };
        const { result } = await openOn([RULE_A], loadedProfiles);
        const draft: TitleRule[] = [{ ...RULE_A, profile: 'tactic' }];
        act(() => result.current.change(draft));

        mockApi.getTitleRules.mockResolvedValue(invalid(null));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid(null));
        await fire();

        expect(mockApi.logError).toHaveBeenCalledWith('Error refreshing title rules: unexpected payload');
        expect(result.current.rules).toEqual(draft); // the draft keeps its profile
        expect(result.current.profiles).toEqual(loadedProfiles); // not stripped to {}
        expect(result.current.isDirty()).toBe(true);
    });

    test('a clean editor keeps its rules when a refresh answers malformed payloads', async () => {
        const { result } = await openOn([RULE_A], {});
        mockApi.getTitleRules.mockResolvedValue(invalid(null));
        await fire();

        expect(mockApi.logError).toHaveBeenCalledWith('Error refreshing title rules: unexpected payload');
        expect(result.current.rules).toEqual([RULE_A]);
    });

    test('a rejected refresh keeps the state and logs', async () => {
        const { result } = await openOn([RULE_A], { tactic: { exposure: 80 } });
        mockApi.getTitleRules.mockRejectedValueOnce('bare');
        await fire();

        expect(mockApi.logError).toHaveBeenCalledWith('Error refreshing title rules: bare');
        expect(result.current.rules).toEqual([RULE_A]);
        expect(result.current.profiles).toEqual({ tactic: { exposure: 80 } });
    });
});

describe('the settings-changed refresh — dirty draft', () => {
    test('a dirty draft keeps its rules identity over a profiles-only change while the baseline moves', async () => {
        const { result } = await openOn([RULE_A], { tactic: { exposure: 80 } });
        const draft: TitleRule[] = [{ ...RULE_A, profile: 'tactic' }];
        act(() => result.current.change(draft));
        expect(result.current.isDirty()).toBe(true);

        // Only the profiles changed on disk; the rules answer is unchanged.
        mockApi.getTitleRules.mockResolvedValue(invalid([RULE_A]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({ tactic: { exposure: 80 }, brand: { exposure: 90 } }));
        await fire();

        expect(result.current.rules).toBe(draft); // identity kept — the reconcile changed nothing
        expect(result.current.profiles).toEqual({ tactic: { exposure: 80 }, brand: { exposure: 90 } });
        expect(result.current.isDirty()).toBe(true); // the draft still differs from the moved baseline
    });

    test('a dirty draft keeps its edits while the baseline moves to the fresh disk rules', async () => {
        const { result } = await openOn([RULE_A], {});
        const draft: TitleRule[] = [{ title: 'A', mustIncludeTags: ['x', 'y'] }];
        act(() => result.current.change(draft));

        const freshDisk: TitleRule[] = [{ title: 'B', mustIncludeTags: [] }];
        mockApi.getTitleRules.mockResolvedValue(invalid(freshDisk));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({}));
        await fire();

        expect(result.current.rules).toEqual(draft); // edits kept
        expect(result.current.isDirty()).toBe(true); // still differs from the moved baseline
        act(() => result.current.change(freshDisk));
        expect(result.current.isDirty()).toBe(false); // the baseline is the fresh disk rules
    });

    test('a dirty draft whose edit equals the fresh disk rules stops being dirty', async () => {
        const { result } = await openOn([RULE_A], {});
        const edit: TitleRule[] = [{ title: 'B', mustIncludeTags: [] }];
        act(() => result.current.change(edit));
        expect(result.current.isDirty()).toBe(true);

        mockApi.getTitleRules.mockResolvedValue(invalid(edit)); // the same edit landed from elsewhere
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({}));
        await fire();

        expect(result.current.isDirty()).toBe(false);
    });

    test('a dirty draft drops a deleted profile from its untouched rule and keeps the other edits', async () => {
        const one = { title: 'One', profile: 'gone', mustIncludeTags: ['x'] };
        const two = { title: 'Two', mustIncludeTags: ['y'] };
        const { result } = await openOn([one, two], { gone: { exposure: 80 }, keep: { exposure: 70 } });

        const draft: TitleRule[] = [one, { title: 'Two', mustIncludeTags: ['z'] }];
        act(() => result.current.change(draft));

        mockApi.getTitleRules.mockResolvedValue(invalid([{ title: 'One', mustIncludeTags: ['x'] }, two]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({ keep: { exposure: 70 } }));
        await fire();

        expect(result.current.rules).toEqual([
            { title: 'One', mustIncludeTags: ['x'] }, // the deleted profile's field went
            { title: 'Two', mustIncludeTags: ['z'] }, // the other edit stays
        ]);
        expect(result.current.isDirty()).toBe(true);
    });

    test('a dirty draft takes a re-cased profile name', async () => {
        const { result } = await openOn([{ title: 'One', profile: 'tactic', mustIncludeTags: ['x'] }], {
            tactic: { exposure: 80 },
        });

        const draft: TitleRule[] = [{ title: 'One', profile: 'tactic', mustIncludeTags: ['x', 'extra'] }];
        act(() => result.current.change(draft));

        mockApi.getTitleRules.mockResolvedValue(invalid([{ title: 'One', profile: 'Tactic', mustIncludeTags: ['x'] }]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({ Tactic: { exposure: 80 } }));
        await fire();

        expect(result.current.rules).toEqual([{ title: 'One', profile: 'Tactic', mustIncludeTags: ['x', 'extra'] }]);
    });

    test('a draft rule set to "None" (profile: \'\') is untouched and keeps a shown rule-save error', async () => {
        const { result } = await openOn([{ title: 'A', mustIncludeTags: ['x'] }], {});
        const draft: TitleRule[] = [{ title: 'A', mustIncludeTags: ['x'], profile: '' }];
        act(() => result.current.change(draft));

        // The shown error: a rejected save, with the '' draft still on screen.
        mockApi.setTitleRules.mockResolvedValueOnce(false);
        await act(async () => {
            expect(await result.current.persist()).toBe(false);
        });
        expect(result.current.error).toBe(true);

        mockApi.getTitleRules.mockResolvedValue(invalid([{ title: 'A', mustIncludeTags: ['x'] }]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({}));
        await fire();

        expect(result.current.rules).toBe(draft); // identity kept — '' is "None", not a name to reconcile
        expect(result.current.rules[0]).toBe(draft[0]);
        expect(result.current.error).toBe(true); // the refresh changed nothing, so the error stays
    });
});

describe('the settings-changed refresh — around the load', () => {
    test('broadcasts during the initial load run one refresh once it lands', async () => {
        let resolveRules!: (rules: TitleRule[]) => void;
        mockApi.getTitleRules.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRules = resolve;
            }),
        );
        const hook = renderHook(() => useTitleRules(true));

        await fire();
        await fire();
        // The load has not settled: nothing fetched beyond the initial load.
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(1);

        await act(async () => resolveRules(invalid([RULE_A])));
        await waitFor(() => expect(mockApi.getTitleRules).toHaveBeenCalledTimes(2)); // one refresh, not two
        expect(hook.result.current.loading).toBe(false);
    });

    test('a broadcast that lands after onLoad but before the next render still refreshes', async () => {
        let releaseLoad!: (rules: TitleRule[]) => void;
        let calls = 0;
        let inWindowFired = false;
        mockApi.getTitleRules.mockImplementation(async () => {
            calls += 1;
            if (calls === 1) return new Promise<TitleRule[]>((resolve) => (releaseLoad = resolve));
            // The refresh that onLoad starts for the missed broadcast calls
            // this mock after the load has applied (loadAppliedRef is set)
            // but before the render flush: firing the subscribed callback
            // there is the window where a render-time loading read still said
            // "loading" and lost the broadcast.
            if (!inWindowFired) {
                inWindowFired = true;
                fireSettingsChanged();
            }
            return invalid([RULE_A]);
        });
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({}));
        const hook = renderHook(() => useTitleRules(true));

        await act(async () => {
            fireSettingsChanged(); // during the load: the missed flag
            releaseLoad(invalid([RULE_A]));
        });
        await tick();

        // The initial load + the flag's refresh + the in-window broadcast's own.
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(3);
        expect(hook.result.current.error).toBe(false);
        expect(hook.result.current.rules).toEqual([RULE_A]);
    });

    test('no broadcast during the load means no refresh follows it', async () => {
        await openOn([RULE_A], {});
        await act(async () => {});
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(0);
    });

    test('a broadcast around a failed load starts no refresh', async () => {
        let rejectRules!: (reason?: unknown) => void;
        mockApi.getTitleRules.mockReturnValueOnce(
            new Promise((_, reject) => {
                rejectRules = reject;
            }),
        );
        const hook = renderHook(() => useTitleRules(true));

        await fire(); // during the load: only the missed flag is set
        await act(async () => rejectRules(new Error('disk')));
        await waitFor(() => expect(hook.result.current.loadFailed).toBe(true));
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(1);

        await fire(); // after the failure: the alert replaced the editor
        await act(async () => {});
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(1);
    });

    test('a broadcast missed during a failed load is not consumed by the next open', async () => {
        let rejectRules!: (reason?: unknown) => void;
        mockApi.getTitleRules
            .mockReturnValueOnce(
                new Promise((_, reject) => {
                    rejectRules = reject;
                }),
            )
            .mockResolvedValueOnce(invalid([RULE_A])); // the reopened session's load

        const hook = renderHook(({ open }) => useTitleRules(open), { initialProps: { open: true } });
        await fire();
        await act(async () => rejectRules(new Error('disk')));
        await waitFor(() => expect(hook.result.current.loadFailed).toBe(true));

        hook.rerender({ open: false });
        hook.rerender({ open: true });
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        await act(async () => {});
        // Two loads (one per open), no refresh: the flag died with the first open.
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(2);
    });

    test('no subscription while closed, cleanup unsubscribes, and a host without the event still mounts', async () => {
        const closed = renderHook(() => useTitleRules(false));
        expect(mockApi.onSettingsChanged).not.toHaveBeenCalled();
        closed.unmount();

        const hook = await openOn([RULE_A], {});
        expect(mockApi.onSettingsChanged).toHaveBeenCalledTimes(1);
        const unsubscribe = invalid<() => void>(mockApi.onSettingsChanged.mock.results[0]?.value);
        hook.unmount();
        await tick();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    test('a host whose onSettingsChanged returns undefined still mounts and unmounts', () => {
        // The WindowApi type promises an unsubscribe fn; a real host may leave
        // the event out, and then the forwarder answers undefined.
        mockApi.onSettingsChanged.mockImplementation(
            invalid<(callback: (...args: never[]) => void) => () => void>(() => undefined),
        );
        const hook = renderHook(() => useTitleRules(true));
        expect(() => hook.unmount()).not.toThrow();
    });
});

describe('the settings-changed refresh — error state', () => {
    test('a refresh that changes the draft clears a shown rule-save error', async () => {
        const { result } = await openOn([{ title: 'One', profile: 'gone', mustIncludeTags: ['x'] }], {
            gone: { exposure: 80 },
        });
        mockApi.setTitleRules.mockResolvedValueOnce(false);
        await act(async () => {
            expect(await result.current.persist()).toBe(false);
        });
        expect(result.current.error).toBe(true);

        mockApi.getTitleRules.mockResolvedValue(invalid([{ title: 'One', mustIncludeTags: ['x'] }]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({}));
        await fire();

        expect(result.current.error).toBe(false);
        expect(result.current.rules).toEqual([{ title: 'One', mustIncludeTags: ['x'] }]);
    });

    test('a refresh that leaves a rejected draft unchanged keeps the error', async () => {
        const { result } = await openOn([RULE_A], {});
        mockApi.setTitleRules.mockResolvedValueOnce(false);
        await act(async () => {
            expect(await result.current.persist()).toBe(false);
        });
        expect(result.current.error).toBe(true);

        await fire(); // answers the unchanged disk rules
        expect(result.current.error).toBe(true);
    });

    test('persist()’s refresh after a rejected write reconciles the draft and keeps the error', async () => {
        const { result } = await openOn([{ title: 'One', profile: 'gone', mustIncludeTags: ['x'] }], {
            gone: { exposure: 80 },
        });
        const draft: TitleRule[] = [{ title: 'One', profile: 'gone', mustIncludeTags: ['x', 'extra'] }];
        act(() => result.current.change(draft));

        mockApi.getChallengeProfiles.mockResolvedValue(invalid({})); // the profile is gone on disk
        mockApi.setTitleRules.mockResolvedValueOnce(false);
        await act(async () => {
            expect(await result.current.persist()).toBe(false);
        });

        expect(result.current.error).toBe(true); // the trailing refresh never clears it
        expect(result.current.rules).toEqual([{ title: 'One', mustIncludeTags: ['x', 'extra'] }]);
    });

    test('a skipped write (a failed load) starts no refresh', async () => {
        mockApi.getTitleRules.mockRejectedValueOnce(new Error('disk'));
        const hook = renderHook(() => useTitleRules(true));
        await waitFor(() => expect(hook.result.current.loadFailed).toBe(true));
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(1);

        await act(async () => {
            expect(await hook.result.current.persist()).toBe(true);
        });
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(1);
        expect(hook.result.current.error).toBe(false);
    });
});

describe('the settings-changed refresh — persist and superseding', () => {
    test('persist() runs one refresh after its write, landed or rejected', async () => {
        const { result } = await openOn([RULE_A], {});
        mockApi.setTitleRules.mockResolvedValueOnce(true);
        await act(async () => {
            await result.current.persist();
        });
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(1); // exactly the trailing refresh

        mockApi.setTitleRules.mockResolvedValueOnce(false);
        await act(async () => {
            await result.current.persist();
        });
        expect(mockApi.getTitleRules).toHaveBeenCalledTimes(2); // and one after the rejection
    });

    test('broadcasts around a landed save end in one correct, clean state', async () => {
        const { result } = await openOn([RULE_A], {});
        act(() => result.current.change([{ title: 'B', mustIncludeTags: [] }]));

        // The shells' timing: the write's own broadcast fires inside the call.
        mockApi.setTitleRules.mockImplementation(async () => {
            fireSettingsChanged();
            return true;
        });
        await act(async () => {
            expect(await result.current.persist()).toBe(true);
        });
        await fire(); // the watcher's late broadcast, after the write settled

        expect(result.current.isDirty()).toBe(false);
        expect(result.current.error).toBe(false);
        expect(result.current.rules).toEqual([RULE_A]);
        expect(result.current.profiles).toEqual({});
    });

    test('a refresh started before persist() settles dropped', async () => {
        const { result } = await openOn([RULE_A], {});

        let staleResolve!: (rules: TitleRule[]) => void;
        mockApi.getTitleRules.mockReturnValueOnce(
            new Promise((resolve) => {
                staleResolve = resolve;
            }),
        );
        await fire(); // refresh in flight on the stale answer

        mockApi.setTitleRules.mockResolvedValueOnce(true);
        await act(async () => {
            expect(await result.current.persist()).toBe(true);
        });
        expect(result.current.rules).toEqual([RULE_A]); // the trailing refresh's answer

        await act(async () => staleResolve(invalid([{ title: 'STALE', mustIncludeTags: [] }])));
        await act(async () => {});
        expect(result.current.rules).toEqual([RULE_A]); // the stale refresh never applied
        expect(mockApi.logError).not.toHaveBeenCalled();
    });

    test('a superseded refresh is dropped', async () => {
        const { result } = await openOn([RULE_A], {});

        let staleResolve!: (rules: TitleRule[]) => void;
        mockApi.getTitleRules
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    staleResolve = resolve;
                }),
            )
            .mockResolvedValueOnce(invalid([{ title: 'FRESH', mustIncludeTags: [] }]));
        await fire(); // refresh 1, pending on the stale answer
        await fire(); // refresh 2 supersedes it and answers FRESH

        await waitFor(() => expect(result.current.rules).toEqual([{ title: 'FRESH', mustIncludeTags: [] }]));
        await act(async () => staleResolve(invalid([{ title: 'STALE', mustIncludeTags: [] }])));
        await act(async () => {});
        expect(result.current.rules).toEqual([{ title: 'FRESH', mustIncludeTags: [] }]);
    });

    test('a superseded refresh that rejects stays silent', async () => {
        const { result } = await openOn([RULE_A], {});

        let staleReject!: (reason?: unknown) => void;
        mockApi.getTitleRules
            .mockReturnValueOnce(
                new Promise((_, reject) => {
                    staleReject = reject;
                }),
            )
            .mockResolvedValueOnce(invalid([{ title: 'FRESH', mustIncludeTags: [] }]));
        await fire(); // refresh 1, pending on the rejecting answer
        await fire(); // refresh 2 supersedes it and applies FRESH

        await waitFor(() => expect(result.current.rules).toEqual([{ title: 'FRESH', mustIncludeTags: [] }]));
        await act(async () => staleReject(new Error('late')));
        await tick();
        expect(mockApi.logError).not.toHaveBeenCalled(); // the drop wins over the rejection
        expect(result.current.rules).toEqual([{ title: 'FRESH', mustIncludeTags: [] }]);
    });

    test('a refresh that settles after close/reopen is dropped', async () => {
        mockApi.getTitleRules.mockResolvedValue(invalid([RULE_A]));
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({}));
        const hook = renderHook(({ open }) => useTitleRules(open), { initialProps: { open: true } });
        await waitFor(() => expect(hook.result.current.loading).toBe(false));

        let staleResolve!: (rules: TitleRule[]) => void;
        mockApi.getTitleRules.mockReturnValueOnce(
            new Promise((resolve) => {
                staleResolve = resolve;
            }),
        );
        await fire(); // refresh in flight on the stale answer

        hook.rerender({ open: false }); // cleanup advances the generation
        hook.rerender({ open: true }); // the reopened session's own load
        await waitFor(() => expect(hook.result.current.loading).toBe(false));

        await act(async () => staleResolve(invalid([{ title: 'STALE', mustIncludeTags: [] }])));
        await act(async () => {});
        expect(hook.result.current.rules).toEqual([RULE_A]); // the reopened load's answer
        expect(hook.result.current.error).toBe(false);
    });
});
