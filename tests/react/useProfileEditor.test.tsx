/**
 * useProfileEditor: load-on-open with a read dropped at close, seeding from
 * the whole stored profile, the inherit chain, the on-only `false` → clear
 * edit, and the whole-map save through saveChallengeProfile.
 */

import { renderHook, waitFor, act } from '@testing-library/preact';
import { useProfileEditor } from '@/hooks/useProfileEditor';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

import type { RendererSchema } from '../../src/ts/types/settingsEditor';
import type { ChallengeValues } from '../../src/ts/types/settings';

const SCHEMA = invalid<RendererSchema>({
    exposure: { perChallenge: true, group: 'g', default: 70 },
    manualPhotosOnly: { perChallenge: true, group: 'g', default: false },
    // challengeOnly: a profile may set it, but it has no global value.
    chosenPhotos: { perChallenge: true, challengeOnly: true, group: 'g', default: [] },
    // perChallenge but in a group the profiles tab never renders (no cell).
    extra: { perChallenge: true, group: 'noBand', default: false },
});

const PROFILES: Record<string, ChallengeValues> = {
    tactic: { exposure: 80, extra: true },
};

const deferred = () => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const withProfiles = (profiles: Record<string, ChallengeValues>) =>
    mockApi.getChallengeProfiles.mockReset().mockResolvedValue(invalid(profiles));

beforeEach(() => {
    window.api = invalid(mockApi);
    withProfiles(PROFILES);
    mockApi.saveChallengeProfile.mockReset().mockResolvedValue(true);
});

const renderEditor = (overrides: { schema?: RendererSchema | null; defaults?: Record<string, unknown> | null } = {}) =>
    renderHook(
        ({ isOpen }: { isOpen: boolean }) =>
            useProfileEditor({
                isOpen,
                schema: overrides.schema === undefined ? SCHEMA : overrides.schema,
                defaults: overrides.defaults === undefined ? {} : overrides.defaults,
            }),
        // Starts closed, like the modal the section renders in.
        { initialProps: { isOpen: false } },
    );

const open = async (overrides: { schema?: RendererSchema | null; defaults?: Record<string, unknown> | null } = {}) => {
    const view = renderEditor(overrides);
    view.rerender({ isOpen: true });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    return view;
};

describe('useProfileEditor — load', () => {
    test('loads on open, and nothing is picked or dirty until one is', async () => {
        const { result } = await open();
        expect(result.current.profiles).toEqual(PROFILES);
        expect(result.current.selected).toBeNull();
        expect(result.current.isDirty()).toBe(false);
        expect(result.current.loadFailed).toBe(false);
    });

    test('reopening replaces an older copy while the form is not dirty', async () => {
        const view = await open();
        view.rerender({ isOpen: false });
        await waitFor(() => expect(view.result.current.selected).toBeNull());
        withProfiles({ tactic: { exposure: 85, extra: true }, fresh: {} });
        view.rerender({ isOpen: true });
        await waitFor(() =>
            expect(view.result.current.profiles).toEqual({ tactic: { exposure: 85, extra: true }, fresh: {} }),
        );
    });

    test('a read that resolves after close is dropped, with no reseed', async () => {
        const pending = deferred();
        mockApi.getChallengeProfiles.mockReset().mockReturnValue(invalid(pending.promise));
        const view = renderEditor();
        view.rerender({ isOpen: true });

        view.rerender({ isOpen: false });
        await act(async () => {
            pending.resolve(PROFILES);
        });
        // The dropped read neither filled the store nor seeded anything.
        expect(view.result.current.profiles).toEqual({});
        expect(view.result.current.selected).toBeNull();
        expect(view.result.current.isDirty()).toBe(false);

        // The next open loads again.
        view.rerender({ isOpen: true });
        await waitFor(() => expect(view.result.current.profiles).toEqual(PROFILES));
    });

    test('a rejected read and a null resolution both fail the load', async () => {
        mockApi.getChallengeProfiles.mockReset().mockRejectedValue(new Error('ipc down'));
        const view = renderEditor();
        view.rerender({ isOpen: true });
        await waitFor(() => expect(view.result.current.loadFailed).toBe(true));
        await waitFor(() =>
            expect(mockApi.logError).toHaveBeenCalledWith('Error loading challenge profiles: ipc down'),
        );

        // A rejection with no message falls back to the raw reason in the log.
        mockApi.getChallengeProfiles.mockRejectedValueOnce(invalid(undefined));
        view.rerender({ isOpen: false });
        view.rerender({ isOpen: true });
        await waitFor(() =>
            expect(mockApi.logError).toHaveBeenCalledWith('Error loading challenge profiles: undefined'),
        );

        withProfiles(PROFILES);
        mockApi.getChallengeProfiles.mockResolvedValueOnce(invalid(null));
        view.rerender({ isOpen: false });
        view.rerender({ isOpen: true });
        await waitFor(() => expect(view.result.current.loadFailed).toBe(true));
    });
});

describe('useProfileEditor — the form', () => {
    test('selecting a profile seeds the whole stored map; edit and reset a key', async () => {
        const { result } = await open();
        act(() => result.current.selectProfile('tactic'));
        expect(result.current.overrides).toEqual({ exposure: 80, extra: true });
        expect(result.current.isDirty()).toBe(false);
        expect(result.current.effectiveOf('exposure')).toBe(80);

        act(() => result.current.changeOverride('exposure', 90));
        expect(result.current.overrides).toEqual({ exposure: 90, extra: true });
        expect(result.current.isDirty()).toBe(true);
        expect(result.current.effectiveOf('exposure')).toBe(90);
        // A key the map does not hold reads the inherit chain.
        expect(result.current.effectiveOf('manualPhotosOnly')).toBe(false);

        // Resetting the key takes it out of the map: unlike the stored profile,
        // the form no longer sets it, so a save would drop it and the draft
        // stays unsaved. Its shown value reads the inherit chain again.
        act(() => result.current.clearOverride('exposure'));
        expect(result.current.overrides).toEqual({ extra: true });
        expect(result.current.isDirty()).toBe(true);
        expect(result.current.effectiveOf('exposure')).toBe(70);

        // An edit undone back to the stored value is not a draft.
        act(() => result.current.changeOverride('exposure', 80));
        expect(result.current.isDirty()).toBe(false);
    });

    test('setting an on-only key to false clears it instead', async () => {
        withProfiles({ 'Manual only': { exposure: 80, manualPhotosOnly: true } });
        const { result } = await open();
        act(() => result.current.selectProfile('Manual only'));
        act(() => result.current.changeOverride('manualPhotosOnly', false));
        // A profile cannot store that `false` — the key is gone, not off.
        expect(result.current.overrides).toEqual({ exposure: 80 });
        expect(result.current.isDirty()).toBe(true);
    });

    test('the inherit chain: a stored global default, the schema fallback, and the challengeOnly schema default', async () => {
        const { result } = await open({ defaults: { exposure: 60 } });
        expect(result.current.inheritedOf('exposure')).toBe(60);
        expect(result.current.inheritedOf('manualPhotosOnly')).toBe(false);
        // challengeOnly has no global value: even a stored one is ignored.
        expect(result.current.inheritedOf('chosenPhotos')).toEqual([]);
    });

    test('a missing schema falls back to the schema defaults being out of reach', async () => {
        const { result } = await open({ schema: null });
        // defaults {} holds nothing, and schema null has no default either.
        expect(result.current.inheritedOf('exposure')).toBeUndefined();
    });

    test('ruleSourceOf and profileValues are the stable no-rule stand-ins', async () => {
        const { result, rerender } = await open();
        expect(result.current.ruleSourceOf('exposure')).toBeUndefined();
        const before = result.current.profileValues;
        rerender({ isOpen: true });
        expect(result.current.profileValues).toBe(before);
    });
});

describe('useProfileEditor — save and discard', () => {
    test('save writes the whole map, including a stored key with no cell, and lands the draft', async () => {
        const { result } = await open();
        act(() => result.current.selectProfile('tactic'));
        act(() => result.current.changeOverride('exposure', 90));
        await act(async () => {
            await result.current.save();
        });
        expect(mockApi.saveChallengeProfile).toHaveBeenCalledWith('tactic', { exposure: 90, extra: true });
        expect(result.current.isDirty()).toBe(false);
        expect(result.current.savedNote).toBe(true);
        expect(result.current.saveError).toBe(false);
        // The copy this tab edits from shows the saved values.
        expect(result.current.profiles.tactic).toEqual({ exposure: 90, extra: true });
    });

    test('a refused save keeps the draft and reports the failure', async () => {
        mockApi.saveChallengeProfile.mockResolvedValue(false);
        const { result } = await open();
        act(() => result.current.selectProfile('tactic'));
        act(() => result.current.changeOverride('exposure', 90));
        await act(async () => {
            await result.current.save();
        });
        expect(result.current.saveError).toBe(true);
        expect(result.current.savedNote).toBe(false);
        expect(result.current.isDirty()).toBe(true);
    });

    test('a thrown save is logged and reported like a refusal', async () => {
        mockApi.saveChallengeProfile.mockRejectedValue(new Error('ipc down'));
        const { result } = await open();
        act(() => result.current.selectProfile('tactic'));
        act(() => result.current.changeOverride('exposure', 90));
        await act(async () => {
            await result.current.save();
        });
        expect(mockApi.logError).toHaveBeenCalledWith('Error saving challenge profile: ipc down');
        expect(result.current.saveError).toBe(true);

        // A rejection with no message falls back to the raw reason in the log.
        mockApi.saveChallengeProfile.mockRejectedValueOnce(invalid(null));
        await act(async () => {
            await result.current.save();
        });
        expect(mockApi.logError).toHaveBeenCalledWith('Error saving challenge profile: null');
        expect(result.current.saveError).toBe(true);
    });

    test('saving with no profile picked never reaches IPC', async () => {
        const { result } = await open();
        await act(async () => {
            await result.current.save();
        });
        expect(mockApi.saveChallengeProfile).not.toHaveBeenCalled();
    });

    test('a settled read while the form is dirty does not reseed; a discard read does', async () => {
        const pending = deferred();
        mockApi.getChallengeProfiles.mockReset().mockReturnValue(invalid(pending.promise));
        const view = renderEditor();
        view.rerender({ isOpen: true });
        // A pick and an edit made before the open's read settles leave a draft.
        act(() => view.result.current.selectProfile('tactic'));
        act(() => view.result.current.changeOverride('exposure', 95));

        await act(async () => {
            pending.resolve({ tactic: { exposure: 80, extra: true } });
        });
        // The settled read fills the store but leaves the draft alone.
        await waitFor(() => expect(view.result.current.profiles.tactic).toEqual({ exposure: 80, extra: true }));
        expect(view.result.current.overrides).toEqual({ exposure: 95 });
        expect(view.result.current.isDirty()).toBe(true);

        // The discard's fresh read is the one reseed that may land over it.
        mockApi.getChallengeProfiles.mockResolvedValue(invalid({ tactic: { exposure: 85, extra: true } }));
        act(() => view.result.current.discard());
        await waitFor(() => expect(view.result.current.overrides).toEqual({ exposure: 85, extra: true }));
        expect(view.result.current.isDirty()).toBe(false);
    });

    test('an edit made while the save is out stays dirty, and the stored copy holds the sent values', async () => {
        const { result } = await open();
        act(() => result.current.selectProfile('tactic'));
        act(() => result.current.changeOverride('exposure', 90));
        let resolveSave!: (value: boolean) => void;
        mockApi.saveChallengeProfile.mockReturnValue(
            invalid(
                new Promise<boolean>((resolve) => {
                    resolveSave = resolve;
                }),
            ),
        );
        let saving!: Promise<boolean>;
        await act(async () => {
            saving = result.current.save();
        });
        // The edit lands while the write is out — it is not part of this save.
        act(() => result.current.changeOverride('exposure', 95));

        await act(async () => {
            resolveSave(true);
            await saving;
        });
        expect(mockApi.saveChallengeProfile).toHaveBeenCalledWith('tactic', { exposure: 90, extra: true });
        // The sent values, not the later edit, became the baseline.
        expect(result.current.profiles.tactic).toEqual({ exposure: 90, extra: true });
        expect(result.current.overrides).toEqual({ exposure: 95, extra: true });
        expect(result.current.isDirty()).toBe(true);
        expect(result.current.savedNote).toBe(true);
    });

    test('a save that resolves after close changes nothing', async () => {
        const view = await open();
        const { result } = view;
        act(() => result.current.selectProfile('tactic'));
        act(() => result.current.changeOverride('exposure', 90));
        let resolveSave!: (value: boolean) => void;
        mockApi.saveChallengeProfile.mockReturnValue(
            invalid(
                new Promise<boolean>((resolve) => {
                    resolveSave = resolve;
                }),
            ),
        );
        let saving!: Promise<boolean>;
        await act(async () => {
            saving = result.current.save();
        });
        // The tab closes before the write resolves.
        view.rerender({ isOpen: false });

        await act(async () => {
            resolveSave(true);
            await saving;
        });
        // The answer names a draft the closed tab no longer holds.
        expect(result.current.profiles.tactic).toEqual({ exposure: 80, extra: true });
        expect(result.current.savedNote).toBe(false);
        expect(result.current.saveError).toBe(false);
    });

    test('a save that rejects after close and reopen shows no error in the new session', async () => {
        const view = await open();
        act(() => view.result.current.selectProfile('tactic'));
        act(() => view.result.current.changeOverride('exposure', 90));
        let rejectSave!: (reason?: unknown) => void;
        mockApi.saveChallengeProfile.mockReturnValue(
            invalid(
                new Promise<boolean>((_resolve, reject) => {
                    rejectSave = reject;
                }),
            ),
        );
        let saving!: Promise<boolean>;
        await act(async () => {
            saving = view.result.current.save();
        });
        // The tab closes and reopens while the write is out.
        view.rerender({ isOpen: false });
        view.rerender({ isOpen: true });
        await waitFor(() => expect(view.result.current.loading).toBe(false));

        await act(async () => {
            rejectSave(new Error('ipc down'));
            await saving;
        });
        // The rejection is logged, but the reopened session holds no draft of
        // it: no stale error appears.
        expect(mockApi.logError).toHaveBeenCalledWith('Error saving challenge profile: ipc down');
        expect(view.result.current.saveError).toBe(false);
    });

    test('a stale save settling after a newer one started does not clear the newer saving flag', async () => {
        const view = await open();
        act(() => view.result.current.selectProfile('tactic'));
        act(() => view.result.current.changeOverride('exposure', 90));
        let resolveFirst!: (value: boolean) => void;
        mockApi.saveChallengeProfile.mockReturnValue(
            invalid(
                new Promise<boolean>((resolve) => {
                    resolveFirst = resolve;
                }),
            ),
        );
        let first!: Promise<boolean>;
        await act(async () => {
            first = view.result.current.save();
        });
        // The tab closes (dropping the draft) and reopens; its own save starts
        // while the first write is still out.
        view.rerender({ isOpen: false });
        view.rerender({ isOpen: true });
        await waitFor(() => expect(view.result.current.loading).toBe(false));
        act(() => view.result.current.selectProfile('tactic'));
        act(() => view.result.current.changeOverride('exposure', 95));

        let resolveSecond!: (value: boolean) => void;
        mockApi.saveChallengeProfile.mockReturnValue(
            invalid(
                new Promise<boolean>((resolve) => {
                    resolveSecond = resolve;
                }),
            ),
        );
        let second!: Promise<boolean>;
        await act(async () => {
            second = view.result.current.save();
        });
        expect(view.result.current.saving).toBe(true);

        // The stale save settles first: the newer call owns the flag.
        await act(async () => {
            resolveFirst(true);
            await first;
        });
        expect(view.result.current.saving).toBe(true);

        await act(async () => {
            resolveSecond(true);
            await second;
        });
        expect(view.result.current.saving).toBe(false);
        expect(view.result.current.profiles.tactic).toEqual({ exposure: 95, extra: true });
    });
});
