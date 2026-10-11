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
            ruleSources: { scenario: 'Seaside', autoJoin: 'Seaside' },
        });

    test('a rule-assigned scenario and auto-join are the inherited values, not the default, and name their rule', async () => {
        const { result } = await open(seaside());
        expect(result.current.inheritedOf('scenario')).toBe('Plan');
        expect(result.current.effectiveOf('autoJoin')).toBe(true);
        expect(result.current.ruleSourceOf('scenario')).toBe('Seaside');
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
        expect(result.current.ruleSourceOf('scenario')).toBe('Seaside');
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

    test('editing the matched profile re-derives the rule layer under the inline values', async () => {
        const { result } = await open(seaside());
        // The edit changes a profile-only key and tries to change an inline one: the inline value wins.
        act(() => result.current.onProfilesChanged({ name: 'quad', values: { exposure: 80, scenario: 'Other' } }));
        expect(result.current.inheritedOf('exposure')).toBe(80);
        expect(result.current.inheritedOf('scenario')).toBe('Plan');
        expect(result.current.titleRules?.profile).toEqual({
            name: 'quad',
            values: { exposure: 80, scenario: 'Other' },
        });
    });

    test('deleting the matched profile keeps the inline values, with or without a suppression', async () => {
        const { result } = await open(seaside());
        act(() => result.current.onProfilesChanged({ name: 'Quad', deleted: true }));
        expect(result.current.titleRules?.profile).toBeNull();
        expect(result.current.inheritedOf('exposure')).toBe(70);
        expect(result.current.inheritedOf('scenario')).toBe('Plan');
        expect(result.current.inheritedOf('autoJoin')).toBe(true);

        const { result: suppressed } = await open({ ...seaside(), suppressed: true });
        act(() => suppressed.current.onProfilesChanged({ name: 'Quad', deleted: true }));
        expect(suppressed.current.titleRules).toMatchObject({ profile: null, suppressed: true });
        expect(suppressed.current.inheritedOf('scenario')).toBe('Plan');
    });

    test('a change to a profile that is not the matched one is ignored', async () => {
        const { result } = await open(seaside());
        act(() => result.current.onProfilesChanged({ name: 'Elsewhere', values: { exposure: 1 } }));
        expect(result.current.inheritedOf('exposure')).toBe(60);
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
