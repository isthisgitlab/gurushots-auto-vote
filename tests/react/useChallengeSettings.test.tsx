/**
 * Tests for useChallengeSettings — reads a card's effective autoSubmit /
 * compactCards values plus override flags, and toggles the per-card density.
 */

import { render, screen, fireEvent, waitFor, act } from './helpers/test-utils';
import { useChallengeSettings } from '@/hooks/useChallengeSettings';
import { invalid } from '../helpers/invalid';
import { isBoolean, isShape, parseJsonAs } from '../helpers/parseJson';

function Probe({ id = 42, initialCompact, version }: { id?: number; initialCompact?: boolean; version?: number }) {
    const s = useChallengeSettings(id, initialCompact, version);
    return (
        <div>
            <span data-testid="state">
                {JSON.stringify({
                    custom: s.hasCustomSettings,
                    fill: s.autoSubmitEnabled,
                    manual: s.manualPhotosOnly,
                    compact: s.isCompact,
                    override: s.hasCompactOverride,
                })}
            </span>
            <button onClick={s.toggleCompact}>toggle</button>
        </div>
    );
}

/** What Probe renders into its state span. */
type ProbeState = { custom: boolean; fill: boolean; manual: boolean; compact: boolean; override: boolean };
const state = () =>
    parseJsonAs(
        screen.getByTestId('state').textContent,
        isShape<ProbeState>({
            custom: isBoolean,
            fill: isBoolean,
            manual: isBoolean,
            compact: isBoolean,
            override: isBoolean,
        }),
    );

let overrides: Record<string, unknown>;
let effective: Record<string, unknown>;

beforeEach(() => {
    overrides = {};
    effective = { autoSubmit: false, manualPhotosOnly: false, compactCards: false };
    window.api.getSettingsSchema = jest.fn();
    window.api.getChallengeOverride = jest.fn();
    window.api.getChallengeOverrides = jest.fn(async () => ({ ...overrides }));
    window.api.getEffectiveSetting = jest.fn(async (key) => (key in overrides ? overrides[key] : effective[key]));
    window.api.setChallengeOverride = jest.fn(async (key, _id, value) => {
        overrides[key] = value;
        return true;
    });
    window.api.removeChallengeOverride = jest.fn(async (key) => {
        delete overrides[key];
        return true;
    });
});

test('seeds isCompact from initialCompact, then applies the IPC values', async () => {
    overrides = { boostTime: 10 };
    effective = { autoSubmit: true, compactCards: false };
    render(<Probe initialCompact={true} />);
    expect(state().compact).toBe(true);
    await waitFor(() =>
        expect(state()).toEqual({ custom: true, fill: true, manual: false, compact: false, override: false }),
    );
    // The override map is read once, with a stringified id.
    expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1);
    expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('42');
});

test('a card makes zero schema reads and one overrides read, however many per-challenge keys exist', async () => {
    overrides = { boostTime: 10, compactCards: true };
    render(<Probe />);
    await waitFor(() => expect(state().override).toBe(true));
    expect(window.api.getSettingsSchema).not.toHaveBeenCalled();
    expect(window.api.getChallengeOverride).not.toHaveBeenCalled();
    expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1);
    // The three effective values stay separate reads.
    expect(jest.mocked(window.api.getEffectiveSetting).mock.calls.map((c) => c[0])).toEqual([
        'autoSubmit',
        'manualPhotosOnly',
        'compactCards',
    ]);
});

test('an override map with only compactCards marks the compact override and custom settings', async () => {
    overrides = { compactCards: false };
    render(<Probe />);
    await waitFor(() => expect(state().override).toBe(true));
    expect(state().custom).toBe(true);
});

test('an empty override map, or one whose values are all null, has no custom settings and no compact override', async () => {
    overrides = { boostTime: null, compactCards: null };
    render(<Probe />);
    await waitFor(() => expect(window.api.getEffectiveSetting).toHaveBeenCalled());
    expect(state()).toEqual({ custom: false, fill: false, manual: false, compact: false, override: false });
});

test("a null override map (the handler's error answer) leaves the previous values in place", async () => {
    overrides = { compactCards: true };
    const { rerender } = render(<Probe version={0} />);
    await waitFor(() => expect(state().override).toBe(true));

    window.api.getChallengeOverrides = invalid(jest.fn().mockResolvedValue(null));
    effective.compactCards = false;
    rerender(<Probe version={1} />);
    await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalled());
    expect(window.api.getEffectiveSetting).toHaveBeenCalledTimes(3);
    expect(state()).toEqual({ custom: true, fill: false, manual: false, compact: true, override: true });
});

test('reads the effective Manual Only value', async () => {
    effective = { autoSubmit: true, manualPhotosOnly: true, compactCards: false };
    render(<Probe />);
    await waitFor(() => expect(state().manual).toBe(true));
});

test('initialCompact defaults to false', () => {
    render(<Probe />);
    expect(state().compact).toBe(false);
});

test('toggle sets an override opposite to the current density, second toggle removes it', async () => {
    render(<Probe />);
    await waitFor(() => expect(window.api.getEffectiveSetting).toHaveBeenCalled());

    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() =>
        expect(state()).toEqual({ custom: true, fill: false, manual: false, compact: true, override: true }),
    );
    expect(window.api.setChallengeOverride).toHaveBeenCalledWith('compactCards', '42', true);

    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(state().override).toBe(false));
    expect(window.api.removeChallengeOverride).toHaveBeenCalledWith('compactCards', '42');
    expect(state()).toEqual({ custom: false, fill: false, manual: false, compact: false, override: false });
});

test('a failed toggle leaves the UI unchanged', async () => {
    window.api.setChallengeOverride = jest.fn().mockRejectedValue(new Error('ipc down'));
    render(<Probe />);
    await waitFor(() => expect(window.api.getEffectiveSetting).toHaveBeenCalled());
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(window.api.setChallengeOverride).toHaveBeenCalled());
    expect(state()).toEqual({ custom: false, fill: false, manual: false, compact: false, override: false });
});

test('a failed or null overrides read leaves the defaults', async () => {
    window.api.getChallengeOverrides = jest.fn().mockRejectedValue(new Error('boom'));
    const { unmount } = render(<Probe initialCompact={true} />);
    await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalled());
    expect(state()).toEqual({ custom: false, fill: false, manual: false, compact: true, override: false });
    unmount();

    window.api.getChallengeOverrides = invalid(jest.fn().mockResolvedValue(null));
    render(<Probe />);
    await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalled());
    expect(window.api.getEffectiveSetting).not.toHaveBeenCalled();
});

describe('unmount mid-reload drops the pending results', () => {
    const deferred = () => {
        let resolve!: (value: unknown) => void;
        const promise = new Promise((r) => (resolve = r));
        return { promise, resolve };
    };

    test('after the overrides read', async () => {
        const d = deferred();
        window.api.getChallengeOverrides = invalid(jest.fn(() => d.promise));
        const { unmount } = render(<Probe />);
        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalled());
        unmount();
        await act(async () => d.resolve({ boostTime: 10 }));
        expect(window.api.getEffectiveSetting).not.toHaveBeenCalled();
    });

    test('after the effective-value reads', async () => {
        const d = deferred();
        window.api.getEffectiveSetting = jest.fn(() => d.promise);
        const { unmount } = render(<Probe />);
        await waitFor(() => expect(window.api.getEffectiveSetting).toHaveBeenCalled());
        unmount();
        // Resolving after unmount must not throw / warn about state updates.
        await act(async () => d.resolve(true));
        expect(jest.mocked(window.api.getEffectiveSetting).mock.calls.map((c) => c[0])).toEqual([
            'autoSubmit',
            'manualPhotosOnly',
            'compactCards',
        ]);
    });
});

describe('useChallengeSettings — settingsVersion', () => {
    const deferred = () => {
        let resolve!: (value: unknown) => void;
        const promise = new Promise((r) => {
            resolve = r;
        });
        return { promise, resolve };
    };

    test('a new settingsVersion re-reads the values without remounting', async () => {
        const { rerender } = render(<Probe version={0} />);
        await waitFor(() => expect(state().compact).toBe(false));
        const node = screen.getByTestId('state');

        effective.compactCards = true;
        rerender(<Probe version={1} />);

        await waitFor(() => expect(state().compact).toBe(true));
        expect(screen.getByTestId('state')).toBe(node);
    });

    test('an older reload settling after a newer one does not overwrite its values', async () => {
        const first = deferred();
        let calls = 0;
        window.api.getChallengeOverrides = invalid(
            jest.fn(() => {
                calls += 1;
                return calls === 1 ? first.promise : Promise.resolve({ compactCards: true });
            }),
        );
        effective.compactCards = true;
        const { rerender } = render(<Probe version={0} />);
        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1));

        rerender(<Probe version={1} />);
        await waitFor(() => expect(state().compact).toBe(true));

        effective.compactCards = false;
        await act(async () => first.resolve({ compactCards: false }));

        expect(state().compact).toBe(true);
    });
});
