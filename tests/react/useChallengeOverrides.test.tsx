/**
 * useChallengeOverrides — the save guard behind a failed load: the form then
 * holds empty overrides, and saving them would wipe the challenge's stored
 * settings. The modal hides Save in that state; the hook refuses too.
 */

import { renderHook, act, waitFor } from '@testing-library/preact';
import { useChallengeOverrides } from '@/hooks/useChallengeOverrides';
import { mockApi } from './helpers/setup';
import { announceChosenPhotosCleared } from '@/api/chosenPhotosCleared';
import { invalid } from '../helpers/invalid';
import { titleRuleInfo } from './helpers/titleRules';
import type { RendererSchema } from '../../src/ts/types/settingsEditor';

const props = () => ({
    isOpen: true,
    challengeId: '1',
    challengeTitle: 'Challenge 1',
    schema: invalid<RendererSchema>({ exposure: { type: 'number', default: 100, perChallenge: true } }),
    defaults: { exposure: 70 },
    refetchSchema: jest.fn(),
    rearmSchedule: jest.fn().mockResolvedValue(undefined),
    onClose: jest.fn(),
});

beforeEach(() => {
    mockApi.getTitleProfile.mockReset().mockResolvedValue(null);
    mockApi.replaceChallengeOverrides.mockReset().mockResolvedValue(true);
    mockApi.logError.mockReset().mockResolvedValue(invalid(undefined));
});

test('save() writes nothing after a failed load', async () => {
    mockApi.getChallengeOverrides.mockReset().mockRejectedValue(new Error('ipc'));
    const p = props();
    const { result } = renderHook(() => useChallengeOverrides(p));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));

    await act(() => result.current.save());

    expect(mockApi.replaceChallengeOverrides).not.toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
});

test('a successful load clears the failure flag and saves normally', async () => {
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({ exposure: 50 });
    const p = props();
    const { result } = renderHook(() => useChallengeOverrides(p));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadFailed).toBe(false);

    await act(() => result.current.save());

    expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', { exposure: 50 }, false);
    expect(p.onClose).toHaveBeenCalled();
});

test('applyProfile() without a schema (its fetch failed) keeps no key instead of throwing', async () => {
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
    const p = { ...props(), schema: null };
    const { result } = renderHook(() => useChallengeOverrides(p));

    act(() => result.current.applyProfile({ exposure: 50 }));

    expect(result.current.overrides).toEqual({});
    expect(result.current.titleRules).toMatchObject({ suppressed: true, profile: null });
});

test("applyProfile() keeps the challenge's own Manual Only, which a profile never holds as off", async () => {
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({ exposure: 50, manualPhotosOnly: false });
    const p = {
        ...props(),
        schema: invalid<RendererSchema>({
            exposure: { type: 'number', default: 100, perChallenge: true },
            manualPhotosOnly: { type: 'boolean', default: false, perChallenge: true, challengeOnly: true },
        }),
    };
    const { result } = renderHook(() => useChallengeOverrides(p));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.applyProfile({ exposure: 80 }));
    expect(result.current.overrides).toEqual({ exposure: 80, manualPhotosOnly: false });

    // With no value of its own, the profile's "on" is taken.
    act(() => result.current.clearAll());
    act(() => result.current.applyProfile({ manualPhotosOnly: true }));
    expect(result.current.overrides).toEqual({ manualPhotosOnly: true });
});

test("applyProfile(): a profile that sets Manual Only wins over the challenge's own value, and one that does not leaves it", async () => {
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({ manualPhotosOnly: false });
    const p = {
        ...props(),
        schema: invalid<RendererSchema>({
            exposure: { type: 'number', default: 100, perChallenge: true },
            manualPhotosOnly: { type: 'boolean', default: false, perChallenge: true, challengeOnly: true },
        }),
    };
    const { result } = renderHook(() => useChallengeOverrides(p));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.applyProfile({ manualPhotosOnly: true }));
    expect(result.current.overrides).toEqual({ manualPhotosOnly: true });

    // An own `true` stays when the profile has no value for the key.
    act(() => result.current.applyProfile({ exposure: 60 }));
    expect(result.current.overrides).toEqual({ exposure: 60, manualPhotosOnly: true });
});

test('every list removed while the form is open leaves the overrides and the matched profile without it', async () => {
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({ exposure: 50, chosenPhotos: ['a'] });
    mockApi.getTitleProfile.mockReset().mockResolvedValue(
        titleRuleInfo({
            profile: { name: 'Mine', values: { exposure: 60, chosenPhotos: ['b'] } },
            inlineValues: { chosenPhotos: ['c'], scenario: 'Plan' },
        }),
    );
    const p = {
        ...props(),
        schema: invalid<RendererSchema>({
            exposure: { type: 'number', default: 100, perChallenge: true },
            chosenPhotos: { type: 'photos', default: [], perChallenge: true },
        }),
    };
    const { result } = renderHook(() => useChallengeOverrides(p));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.overrides).toEqual({ exposure: 50, chosenPhotos: ['a'] });

    act(() => announceChosenPhotosCleared());
    expect(result.current.overrides).toEqual({ exposure: 50 });
    // The matched profile and both rule layers lose the list too; everything else stays.
    expect(result.current.profileValues).toEqual({ exposure: 60 });
    expect(result.current.titleRules?.ruleValues).toEqual({ exposure: 60, scenario: 'Plan' });
    expect(result.current.titleRules?.inlineValues).toEqual({ scenario: 'Plan' });
    expect(result.current.inheritedOf('chosenPhotos')).toEqual([]);

    await act(() => result.current.save());
    expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', { exposure: 50 }, false);
});

describe("what the challenge's rules contribute", () => {
    const open = async (info: ReturnType<typeof titleRuleInfo> | null, stored: Record<string, unknown> = {}) => {
        mockApi.getChallengeOverrides.mockReset().mockResolvedValue(stored);
        mockApi.getTitleProfile.mockReset().mockResolvedValue(info);
        const p = {
            ...props(),
            schema: invalid<RendererSchema>({
                exposure: { type: 'number', default: 100, perChallenge: true },
                scenario: { type: 'scenario', default: '', perChallenge: true },
                autoJoin: { type: 'boolean', default: false, perChallenge: true },
            }),
        };
        const hook = renderHook(() => useChallengeOverrides(p));
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        return { ...hook, p };
    };
    const seaside = () =>
        titleRuleInfo({
            profile: { name: 'Quad', values: { exposure: 60 } },
            inlineValues: { scenario: 'Plan', autoJoin: true },
            ruleSources: { scenario: { title: 'Seaside', index: 1 }, autoJoin: { title: 'Seaside', index: 1 } },
        });

    test('a rule-assigned scenario and auto-join are the inherited values, not the default, and name their rule', async () => {
        const { result } = await open(seaside());
        expect(result.current.inheritedOf('scenario')).toBe('Plan');
        expect(result.current.effectiveOf('autoJoin')).toBe(true);
        expect(result.current.ruleSourceOf('scenario')).toEqual({ title: 'Seaside', index: 1 });
        // A key only the profile sets is the profile's, with no rule named.
        expect(result.current.inheritedOf('exposure')).toBe(60);
        expect(result.current.ruleSourceOf('exposure')).toBeUndefined();
        expect(result.current.profileValues).toEqual({ exposure: 60 });
        // A key nothing sets falls back to the global default, then the schema's.
        const { result: bare } = await open(titleRuleInfo());
        expect(bare.current.inheritedOf('exposure')).toBe(70);
        expect(bare.current.inheritedOf('scenario')).toBe('');
    });

    test('a manual override still wins over a rule value', async () => {
        const { result } = await open(seaside(), { scenario: 'Mine' });
        expect(result.current.effectiveOf('scenario')).toBe('Mine');
        expect(result.current.inheritedOf('scenario')).toBe('Plan');
    });

    test("with the profile suppressed the rule's own values still apply and the profile's do not", async () => {
        const { result } = await open({ ...seaside(), suppressed: true });
        expect(result.current.inheritedOf('scenario')).toBe('Plan');
        expect(result.current.inheritedOf('exposure')).toBe(70);
        expect(result.current.profileValues).toEqual({});
        expect(result.current.ruleSourceOf('scenario')).toEqual({ title: 'Seaside', index: 1 });
    });

    test('applying a profile suppresses the matched one but keeps the rule values; Clear all brings it back', async () => {
        const { result } = await open(seaside());
        act(() => result.current.applyProfile({ exposure: 90 }));
        expect(result.current.titleRules?.suppressed).toBe(true);
        expect(result.current.inheritedOf('scenario')).toBe('Plan');
        expect(result.current.inheritedOf('exposure')).toBe(70);
        act(() => result.current.clearAll());
        expect(result.current.titleRules?.suppressed).toBe(false);
        expect(result.current.inheritedOf('exposure')).toBe(60);
        expect(result.current.inheritedOf('scenario')).toBe('Plan');
    });

    describe('when the matched profile is edited or deleted, the rules are read again from the settings', () => {
        const callsAfterOpen = () => mockApi.getTitleProfile.mock.calls.length;

        test('an edit shows what the settings now say, not a client-side merge', async () => {
            const { result } = await open(seaside());
            const opened = callsAfterOpen();
            // The settings' first-match order decides: the edited profile's autoSubmit (rule 1) beats rule 2's inline one.
            mockApi.getTitleProfile.mockResolvedValue(
                titleRuleInfo({
                    profile: { name: 'quad', values: { exposure: 80, autoSubmit: false } },
                    inlineValues: { scenario: 'Plan', autoJoin: true, autoSubmit: true },
                    ruleValues: { exposure: 80, autoSubmit: false, scenario: 'Plan', autoJoin: true },
                    ruleSources: {
                        scenario: { title: 'Seaside', index: 1 },
                        autoSubmit: { title: 'Seaside', index: 1, viaProfile: true },
                    },
                    inlineSources: { autoSubmit: { title: 'Sea', index: 2 }, scenario: { title: 'Seaside', index: 1 } },
                }),
            );
            act(() => result.current.onProfilesChanged({ name: 'quad', values: { exposure: 80, autoSubmit: false } }));
            await waitFor(() => expect(result.current.inheritedOf('exposure')).toBe(80));
            expect(callsAfterOpen()).toBe(opened + 1);
            expect(mockApi.getTitleProfile).toHaveBeenLastCalledWith('Challenge 1', '1');
            // The profile's value runs, so it is not credited to rule 2, which only sets it inline.
            expect(result.current.inheritedOf('autoSubmit')).toBe(false);
            expect(result.current.ruleSourceOf('autoSubmit')).toBeUndefined();
            expect(result.current.ruleSourceOf('scenario')).toEqual({ title: 'Seaside', index: 1 });
        });

        test('with the profile suppressed, the key then names the rule that sets it inline', async () => {
            const { result } = await open({ ...seaside(), suppressed: true });
            mockApi.getTitleProfile.mockResolvedValue(
                titleRuleInfo({
                    suppressed: true,
                    profile: { name: 'quad', values: { autoSubmit: false } },
                    inlineValues: { autoSubmit: true },
                    ruleSources: { autoSubmit: { title: 'Seaside', index: 1, viaProfile: true } },
                    inlineSources: { autoSubmit: { title: 'Sea', index: 2 } },
                }),
            );
            act(() => result.current.onProfilesChanged({ name: 'Quad', values: { autoSubmit: false } }));
            await waitFor(() => expect(result.current.inheritedOf('autoSubmit')).toBe(true));
            expect(result.current.ruleSourceOf('autoSubmit')).toEqual({ title: 'Sea', index: 2 });
        });

        test('a deletion leaves the inline values, with or without a suppression', async () => {
            const { result } = await open(seaside());
            mockApi.getTitleProfile.mockResolvedValue(
                titleRuleInfo({
                    inlineValues: { scenario: 'Plan', autoJoin: true },
                    ruleSources: { scenario: { title: 'Seaside', index: 1 } },
                }),
            );
            act(() => result.current.onProfilesChanged({ name: 'Quad', deleted: true }));
            await waitFor(() => expect(result.current.titleRules?.profile).toBeNull());
            expect(result.current.inheritedOf('exposure')).toBe(70);
            expect(result.current.inheritedOf('scenario')).toBe('Plan');
            expect(result.current.inheritedOf('autoJoin')).toBe(true);

            const { result: suppressed } = await open({ ...seaside(), suppressed: true });
            mockApi.getTitleProfile.mockResolvedValue(
                titleRuleInfo({ inlineValues: { scenario: 'Plan' }, ruleSources: {} }),
            );
            act(() => suppressed.current.onProfilesChanged({ name: 'Quad', deleted: true }));
            await waitFor(() => expect(suppressed.current.titleRules?.profile).toBeNull());
            expect(suppressed.current.titleRules?.suppressed).toBe(true);
            expect(suppressed.current.inheritedOf('scenario')).toBe('Plan');
        });

        test("the dialog's own unsaved suppression survives the reread, either way", async () => {
            const { result } = await open(seaside());
            act(() => result.current.applyProfile({ exposure: 90 }));
            expect(result.current.titleRules?.suppressed).toBe(true);
            // The settings still say "not suppressed" (nothing is saved yet).
            act(() => result.current.onProfilesChanged({ name: 'Quad', values: { exposure: 60 } }));
            await waitFor(() => expect(callsAfterOpen()).toBeGreaterThan(1));
            await act(async () => undefined);
            expect(result.current.titleRules?.suppressed).toBe(true);
            act(() => result.current.clearAll());
            expect(result.current.titleRules?.suppressed).toBe(false);
        });

        test('a rule that names a profile not stored yet picks it up when it is saved from the dialog', async () => {
            // The rule names "X", which does not exist: no profile matched.
            const { result } = await open(titleRuleInfo({ inlineValues: { scenario: 'Plan' } }));
            expect(result.current.titleRules?.profile).toBeNull();
            const opened = callsAfterOpen();
            mockApi.getTitleProfile.mockResolvedValue(
                titleRuleInfo({
                    profile: { name: 'X', values: { exposure: 55 } },
                    inlineValues: { scenario: 'Plan' },
                }),
            );
            act(() => result.current.onProfilesChanged({ name: 'X', values: { exposure: 55 } }));
            await waitFor(() => expect(result.current.titleRules?.profile?.name).toBe('X'));
            expect(callsAfterOpen()).toBe(opened + 1);
            expect(result.current.inheritedOf('exposure')).toBe(55);
            expect(result.current.profileValues).toEqual({ exposure: 55 });
        });

        test('a reread that fails changes nothing', async () => {
            const { result } = await open(seaside());
            mockApi.getTitleProfile.mockRejectedValue(new Error('ipc'));
            act(() => result.current.onProfilesChanged({ name: 'Quad', values: { exposure: 1 } }));
            await waitFor(() => expect(mockApi.getTitleProfile).toHaveBeenCalledTimes(2));
            await act(async () => undefined);
            expect(result.current.inheritedOf('exposure')).toBe(60);
        });

        describe('a reply that arrives for a challenge no longer on screen is dropped', () => {
            const SCHEMA = invalid<RendererSchema>({
                exposure: { type: 'number', default: 100, perChallenge: true },
                scenario: { type: 'scenario', default: '', perChallenge: true },
                autoJoin: { type: 'boolean', default: false, perChallenge: true },
            });
            const base = () => ({ ...props(), schema: SCHEMA });
            const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
            const late = () => {
                let release: (info: ReturnType<typeof titleRuleInfo>) => void = () => undefined;
                const reply = new Promise<ReturnType<typeof titleRuleInfo>>((resolve) => (release = resolve));
                return { reply, release };
            };

            test('after the dialog moved to another challenge', async () => {
                mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
                const { reply, release } = late();
                mockApi.getTitleProfile
                    .mockReset()
                    .mockResolvedValueOnce(seaside()) // A, on open
                    .mockReturnValueOnce(invalid(reply)) // A, read again after a profile edit
                    .mockResolvedValue(titleRuleInfo({ inlineValues: { scenario: 'B plan' } })); // B, on open
                const hook = renderHook((p) => useChallengeOverrides(p), {
                    initialProps: { ...base(), challengeId: 'A', challengeTitle: 'Seaside' },
                });
                await waitFor(() => expect(hook.result.current.loading).toBe(false));
                act(() => hook.result.current.onProfilesChanged({ name: 'Quad', values: { exposure: 1 } }));

                hook.rerender({ ...base(), challengeId: 'B', challengeTitle: 'Other' });
                await waitFor(() => expect(hook.result.current.inheritedOf('scenario')).toBe('B plan'));

                // A's answer comes late: it must not replace B's rules.
                release(titleRuleInfo({ inlineValues: { scenario: 'A plan' } }));
                await flush();
                expect(hook.result.current.inheritedOf('scenario')).toBe('B plan');
                expect(hook.result.current.titleRules?.profile).toBeNull();
            });

            test('after the dialog was closed', async () => {
                mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
                const { reply, release } = late();
                mockApi.getTitleProfile
                    .mockReset()
                    .mockResolvedValueOnce(seaside())
                    .mockReturnValueOnce(invalid(reply));
                const hook = renderHook((p) => useChallengeOverrides(p), {
                    initialProps: { ...base(), challengeId: 'A', challengeTitle: 'Seaside' },
                });
                await waitFor(() => expect(hook.result.current.loading).toBe(false));
                act(() => hook.result.current.onProfilesChanged({ name: 'Quad', values: { exposure: 1 } }));
                hook.rerender({ ...base(), challengeId: 'A', challengeTitle: 'Seaside', isOpen: false });
                release(titleRuleInfo({ inlineValues: { scenario: 'late' } }));
                await flush();
                expect(hook.result.current.inheritedOf('scenario')).toBe('Plan');
            });

            test('still on the same challenge, the reply is used', async () => {
                mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
                const { reply, release } = late();
                mockApi.getTitleProfile
                    .mockReset()
                    .mockResolvedValueOnce(seaside())
                    .mockReturnValueOnce(invalid(reply));
                const hook = renderHook((p) => useChallengeOverrides(p), {
                    initialProps: { ...base(), challengeId: 'A', challengeTitle: 'Seaside' },
                });
                await waitFor(() => expect(hook.result.current.loading).toBe(false));
                act(() => hook.result.current.onProfilesChanged({ name: 'Quad', values: { exposure: 1 } }));
                release(titleRuleInfo({ inlineValues: { scenario: 'fresh' } }));
                await flush();
                expect(hook.result.current.inheritedOf('scenario')).toBe('fresh');
            });
        });

        test('nothing is read without a challenge to ask about', async () => {
            mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
            const p = { ...props(), challengeId: null };
            const { result } = renderHook(() => useChallengeOverrides(p));
            act(() => result.current.onProfilesChanged({ name: 'Quad' }));
            expect(mockApi.getTitleProfile).not.toHaveBeenCalled();
        });
    });

    test('a change to a profile that is not the matched one is ignored', async () => {
        const { result } = await open(seaside());
        const opened = mockApi.getTitleProfile.mock.calls.length;
        act(() => result.current.onProfilesChanged({ name: 'Elsewhere', values: { exposure: 1 } }));
        expect(result.current.inheritedOf('exposure')).toBe(60);
        expect(mockApi.getTitleProfile).toHaveBeenCalledTimes(opened);
        const { result: none } = await open(titleRuleInfo({ inlineValues: { scenario: 'Plan' } }));
        act(() => none.current.onProfilesChanged({ name: 'Quad', values: { exposure: 1 } }));
        expect(none.current.inheritedOf('exposure')).toBe(70);
    });

    test('saving without a change stores nothing: only the keys the user changed are written, and the suppression flag', async () => {
        const { result, p } = await open(seaside());
        await act(() => result.current.save());
        expect(mockApi.replaceChallengeOverrides).toHaveBeenLastCalledWith('1', {}, false);
        expect(p.onClose).toHaveBeenCalled();

        const { result: edited } = await open(seaside());
        act(() => edited.current.changeOverride('exposure', 55));
        act(() => edited.current.applyProfile({ exposure: 55 }));
        await act(() => edited.current.save());
        expect(mockApi.replaceChallengeOverrides).toHaveBeenLastCalledWith('1', { exposure: 55 }, true);
    });

    test('a load that failed to read the rules leaves the form on the plain defaults', async () => {
        const { result } = await open(null);
        expect(result.current.titleRules).toBeNull();
        expect(result.current.inheritedOf('exposure')).toBe(70);
        expect(result.current.ruleSourceOf('scenario')).toBeUndefined();
        act(() => result.current.clearAll());
        expect(result.current.titleRules).toBeNull();
        act(() => result.current.onProfilesChanged({ name: 'x', values: {} }));
        expect(result.current.titleRules).toBeNull();
    });
});

describe('isDirty', () => {
    const open = async (
        stored: Record<string, unknown> = { exposure: 50 },
        info: ReturnType<typeof titleRuleInfo> | null = null,
    ) => {
        mockApi.getChallengeOverrides.mockReset().mockResolvedValue(stored);
        mockApi.getTitleProfile.mockReset().mockResolvedValue(info);
        const p = {
            ...props(),
            schema: invalid<RendererSchema>({
                exposure: { type: 'number', default: 100, perChallenge: true },
                chosenPhotos: { type: 'photos', default: [], perChallenge: true },
            }),
        };
        const hook = renderHook((current) => useChallengeOverrides(current), { initialProps: p });
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        return { ...hook, p };
    };

    test('is false until the load has landed', () => {
        mockApi.getChallengeOverrides.mockReset().mockReturnValue(new Promise(() => {}));
        const { result } = renderHook(() => useChallengeOverrides(props()));
        expect(result.current.isDirty()).toBe(false);
        // A list removed before the load lands has no baseline to move.
        act(() => announceChosenPhotosCleared());
        expect(result.current.isDirty()).toBe(false);
    });

    test('an edit is dirty, putting it back is not, and a refetch of the same data is not', async () => {
        const { result } = await open();
        expect(result.current.isDirty()).toBe(false);

        act(() => result.current.changeOverride('exposure', 60));
        expect(result.current.isDirty()).toBe(true);
        act(() => result.current.changeOverride('exposure', 50));
        expect(result.current.isDirty()).toBe(false);

        act(() => result.current.clearOverride('exposure'));
        expect(result.current.isDirty()).toBe(true);
    });

    test('the profile suppression counts: applying a profile and Clear all', async () => {
        const matched = titleRuleInfo({ profile: { name: 'Quad', values: { exposure: 60 } } });
        const { result } = await open({ exposure: 50 }, matched);

        act(() => result.current.applyProfile({ exposure: 50 }));
        // Same overrides, but the matched profile is now suppressed.
        expect(result.current.isDirty()).toBe(true);
        act(() => result.current.clearAll());
        expect(result.current.isDirty()).toBe(true);
        act(() => result.current.changeOverride('exposure', 50));
        expect(result.current.isDirty()).toBe(false);
    });

    test('a chosen-photos clear is not an unsaved edit', async () => {
        const { result } = await open({ exposure: 50, chosenPhotos: ['a'] });
        act(() => announceChosenPhotosCleared());
        expect(result.current.overrides).toEqual({ exposure: 50 });
        expect(result.current.isDirty()).toBe(false);
    });

    test('closing drops the baseline: a reopened modal is not dirty from the last one', async () => {
        const { result, rerender, p } = await open();
        act(() => result.current.changeOverride('exposure', 60));
        expect(result.current.isDirty()).toBe(true);

        rerender({ ...p, isOpen: false });
        expect(result.current.isDirty()).toBe(false);
    });
});
