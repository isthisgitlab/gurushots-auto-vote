/**
 * Tests for useChallengeSettings — reads a card's effective autoFill /
 * compactCards values plus override flags, and toggles the per-card density.
 */

import { render, screen, fireEvent, waitFor, act } from './helpers/test-utils';
import { useChallengeSettings } from '@/hooks/useChallengeSettings';

function Probe({ id = 42, initialCompact }) {
    const s = useChallengeSettings(id, initialCompact);
    return (
        <div>
            <span data-testid="state">
                {JSON.stringify({
                    custom: s.hasCustomSettings,
                    fill: s.autoFillEnabled,
                    compact: s.isCompact,
                    override: s.hasCompactOverride,
                })}
            </span>
            <button onClick={s.toggleCompact}>toggle</button>
        </div>
    );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent);

let overrides;
let effective;

beforeEach(() => {
    overrides = {};
    effective = { autoFill: false, compactCards: false };
    window.api.getSettingsSchema = jest.fn().mockResolvedValue({
        schema: { boostTime: { perChallenge: true }, compactCards: { perChallenge: true }, theme: {} },
    });
    window.api.getChallengeOverride = jest.fn(async (key) => (key in overrides ? overrides[key] : null));
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
    effective = { autoFill: true, compactCards: false };
    render(<Probe initialCompact={true} />);
    expect(state().compact).toBe(true);
    await waitFor(() => expect(state()).toEqual({ custom: true, fill: true, compact: false, override: false }));
    // Only perChallenge schema keys are probed, with a stringified id.
    expect(window.api.getChallengeOverride).toHaveBeenCalledWith('boostTime', '42');
    expect(window.api.getChallengeOverride).not.toHaveBeenCalledWith('theme', '42');
});

test('initialCompact defaults to false', () => {
    render(<Probe />);
    expect(state().compact).toBe(false);
});

test('toggle sets an override opposite to the current density, second toggle removes it', async () => {
    render(<Probe />);
    await waitFor(() => expect(window.api.getEffectiveSetting).toHaveBeenCalled());

    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(state()).toEqual({ custom: true, fill: false, compact: true, override: true }));
    expect(window.api.setChallengeOverride).toHaveBeenCalledWith('compactCards', '42', true);

    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(state().override).toBe(false));
    expect(window.api.removeChallengeOverride).toHaveBeenCalledWith('compactCards', '42');
    expect(state()).toEqual({ custom: false, fill: false, compact: false, override: false });
});

test('a failed toggle leaves the UI unchanged', async () => {
    window.api.setChallengeOverride = jest.fn().mockRejectedValue(new Error('ipc down'));
    render(<Probe />);
    await waitFor(() => expect(window.api.getEffectiveSetting).toHaveBeenCalled());
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(window.api.setChallengeOverride).toHaveBeenCalled());
    expect(state()).toEqual({ custom: false, fill: false, compact: false, override: false });
});

test('a failed or empty schema read leaves the defaults', async () => {
    window.api.getSettingsSchema = jest.fn().mockRejectedValue(new Error('boom'));
    const { unmount } = render(<Probe initialCompact={true} />);
    await waitFor(() => expect(window.api.getSettingsSchema).toHaveBeenCalled());
    expect(state()).toEqual({ custom: false, fill: false, compact: true, override: false });
    unmount();

    window.api.getSettingsSchema = jest.fn().mockResolvedValue(null);
    render(<Probe />);
    await waitFor(() => expect(window.api.getSettingsSchema).toHaveBeenCalled());
    expect(window.api.getChallengeOverride).not.toHaveBeenCalled();
});

describe('unmount mid-reload drops the pending results', () => {
    const deferred = () => {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        return { promise, resolve };
    };

    test('after the schema read', async () => {
        const d = deferred();
        window.api.getSettingsSchema = jest.fn(() => d.promise);
        const { unmount } = render(<Probe />);
        unmount();
        await act(async () => d.resolve({ schema: { a: { perChallenge: true } } }));
        expect(window.api.getChallengeOverride).not.toHaveBeenCalled();
    });

    test('after the override reads', async () => {
        const d = deferred();
        window.api.getChallengeOverride = jest.fn(() => d.promise);
        const { unmount } = render(<Probe />);
        await waitFor(() => expect(window.api.getChallengeOverride).toHaveBeenCalled());
        unmount();
        await act(async () => d.resolve(null));
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
        expect(window.api.getEffectiveSetting.mock.calls.map((c) => c[0])).toEqual(['autoFill', 'compactCards']);
    });
});
