/**
 * ChallengeSettingsModal load-cancellation tests.
 *
 * When the modal's challengeId changes (or the modal closes) while an
 * in-flight loadOverrides sequence is still resolving IPC calls, the
 * stale setOverrides must NOT land — otherwise the modal can render
 * challenge B's title with challenge A's loaded overrides, and rapid
 * open/close cycles can blank the page.
 */
import { act, render, waitFor } from '@/test/test-utils';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { mockApi } from '../../src/js/react/test/setup';

// Belt-and-suspenders: the global setup wires window.api, but the
// test-env globals occasionally lose it between test files. Pin it
// here so this suite is hermetic.
beforeEach(() => {
    window.api = mockApi;
});

const mockSchemaState = {
    schema: {
        // Production declares boostTime as type:'time' (rendered as an
        // hours+minutes pair of number inputs) and has a second perChallenge
        // boost field (boostImageIndex). This mock intentionally collapses the
        // group to a single type:'number' input so the value/disabled assertions
        // stay simple. The number-input queries below use querySelectorAll +
        // .every(), so they remain correct if this mock later grows more fields.
        boostTime: {
            type: 'number',
            default: 30,
            perChallenge: true,
            group: 'boost',
            label: 'app.boostTime',
            description: 'app.boostTimeDesc',
        },
    },
    defaults: { boostTime: 30 },
    groups: [{ id: 'boost', label: 'app.groupBoost' }],
    refetch: jest.fn(),
    loading: false,
};

jest.mock('@/api/useSettingsSchema', () => ({
    useSettingsSchema: () => mockSchemaState,
}));

// All currently-rendered number inputs. Assert across the whole set rather
// than a single querySelector so the tests stay correct if the mocked schema
// gains another perChallenge field (see mockSchemaState note).
const numberInputs = () => Array.from(document.querySelectorAll('input[type="number"]'));

function readNumberInput() {
    const inputs = numberInputs();
    return inputs.length ? inputs[inputs.length - 1].value : null;
}

// The per-field reset button in SettingInput is identified by its title.
const resetButton = () => document.querySelector('button[title="app.resetToDefaultNotSaved"]');

describe('ChallengeSettingsModal load cancellation', () => {
    test('discards a stale load when challengeId changes mid-fetch', async () => {
        // Two pending promises: the first call (for challenge "1") never
        // resolves until we say so; the second (for challenge "2") likewise.
        let resolveForOne;
        let resolveForTwo;
        mockApi.getChallengeOverride
            .mockImplementationOnce(
                () =>
                    new Promise((r) => {
                        resolveForOne = r;
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise((r) => {
                        resolveForTwo = r;
                    }),
            );

        const { rerender } = render(
            <ChallengeSettingsModal isOpen={true} onClose={jest.fn()} challengeId="1" challengeTitle="Challenge 1" />,
        );

        // Swap to challenge "2" while challenge "1"'s load is still pending —
        // this is the cleanup that flips cancelled=true on the first run.
        rerender(
            <ChallengeSettingsModal isOpen={true} onClose={jest.fn()} challengeId="2" challengeTitle="Challenge 2" />,
        );

        // Now land challenge 1's late response. Because the first run is
        // cancelled, this value must not show up in the modal.
        await act(async () => {
            resolveForOne(999);
        });

        // Land challenge 2's response — this is the one that should win.
        await act(async () => {
            resolveForTwo(7);
        });

        await waitFor(() => {
            // SettingInput for a number type renders the value into a
            // number input — the most-recent one corresponds to boostTime.
            expect(readNumberInput()).toBe('7');
        });

        // And critically, the stale value never appears.
        expect(document.body.textContent).not.toMatch(/999/);
    });

    test('discards a stale load when the modal closes mid-fetch', async () => {
        let resolveForOne;
        mockApi.getChallengeOverride.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolveForOne = r;
                }),
        );

        const onClose = jest.fn();
        const { rerender } = render(
            <ChallengeSettingsModal isOpen={true} onClose={onClose} challengeId="1" challengeTitle="Challenge 1" />,
        );

        // Close the modal before the in-flight IPC resolves.
        rerender(
            <ChallengeSettingsModal isOpen={false} onClose={onClose} challengeId="1" challengeTitle="Challenge 1" />,
        );

        // Late response arrives. With cancellation in place this is a
        // no-op; without it, setOverrides + setLoading would fire on a
        // closed modal and produce a console warning.
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        await act(async () => {
            resolveForOne(42);
        });
        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });
});

describe('ChallengeSettingsModal group applicability', () => {
    // Drain any leftover one-shot impls from the cancellation suite so loads
    // resolve to "no override" and the inputs render.
    beforeEach(() => {
        mockApi.getChallengeOverride.mockReset().mockResolvedValue(null);
    });

    const renderWithChallenge = (challenge) =>
        render(
            <ChallengeSettingsModal
                isOpen={true}
                onClose={jest.fn()}
                challengeId="1"
                challengeTitle="Challenge 1"
                challenge={challenge}
            />,
        );

    test('disables a group whose action is already used (boost USED)', async () => {
        renderWithChallenge({ member: { boost: { state: 'USED' } } });

        await waitFor(() => {
            expect(numberInputs().length).toBeGreaterThan(0);
        });

        // boostTime is the lone perChallenge entry, in the 'boost' group.
        expect(numberInputs().every((i) => i.disabled)).toBe(true);
        expect(document.body.textContent).toContain('app.naBoostUsed');
        expect(document.body.textContent).toContain('app.notApplicable');
    });

    test('leaves a group editable when its action can still apply (boost AVAILABLE)', async () => {
        renderWithChallenge({ member: { boost: { state: 'AVAILABLE' } } });

        await waitFor(() => {
            expect(numberInputs().length).toBeGreaterThan(0);
        });

        expect(numberInputs().every((i) => !i.disabled)).toBe(true);
        expect(document.body.textContent).not.toContain('app.naBoostUsed');
        expect(document.body.textContent).not.toContain('app.notApplicable');
    });

    test('re-enables a group when the challenge state clears (live hint, not sticky)', async () => {
        const { rerender } = renderWithChallenge({ member: { boost: { state: 'USED' } } });

        await waitFor(() => {
            expect(numberInputs().length).toBeGreaterThan(0);
        });
        expect(numberInputs().every((i) => i.disabled)).toBe(true);

        // Same modal instance + challengeId, but a fresh challenge prop (e.g. the
        // 60s refetch now shows boost is no longer used). The group must re-enable
        // — proving the disable is a render-time hint derived from live state, not
        // persisted or sticky.
        rerender(
            <ChallengeSettingsModal
                isOpen={true}
                onClose={jest.fn()}
                challengeId="1"
                challengeTitle="Challenge 1"
                challenge={{ member: { boost: { state: 'AVAILABLE' } } }}
            />,
        );

        await waitFor(() => {
            expect(numberInputs().every((i) => !i.disabled)).toBe(true);
        });
        expect(document.body.textContent).not.toContain('app.naBoostUsed');
    });

    test('disables boost on a single-photo challenge and shows the single-photo reason + preserved-values hint', async () => {
        // Realistic single-photo shape: boost present but LOCKED (it never unlocks).
        renderWithChallenge({ type: 'default', max_photo_submits: 1, member: { boost: { state: 'LOCKED' } } });

        await waitFor(() => {
            expect(numberInputs().length).toBeGreaterThan(0);
        });

        expect(numberInputs().every((i) => i.disabled)).toBe(true);
        expect(document.body.textContent).toContain('app.naBoostSinglePhoto');
        expect(document.body.textContent).toContain('app.notApplicableHint');
    });

    test('no challenge prop → group editable (no applicability data)', async () => {
        render(
            <ChallengeSettingsModal isOpen={true} onClose={jest.fn()} challengeId="1" challengeTitle="Challenge 1" />,
        );

        await waitFor(() => {
            expect(numberInputs().length).toBeGreaterThan(0);
        });

        expect(numberInputs().every((i) => !i.disabled)).toBe(true);
        expect(document.body.textContent).not.toContain('app.notApplicable');
    });

    test('applicable group with a stored override → per-field reset button is shown', async () => {
        // A stored override on boostTime (load returns a non-null value).
        mockApi.getChallengeOverride.mockResolvedValue(45);
        renderWithChallenge({ member: { boost: { state: 'AVAILABLE' } } });

        await waitFor(() => {
            expect(numberInputs().length).toBeGreaterThan(0);
        });

        // Override present + group applicable → onReset is wired → reset button rendered.
        expect(document.body.textContent).toContain('app.overridden');
        expect(numberInputs().every((i) => !i.disabled)).toBe(true);
        expect(resetButton()).not.toBeNull();
    });

    test('not-applicable group with a stored override → reset button hidden, override preserved', async () => {
        // Same stored override, but the group is now inert (boost USED). The
        // onReset gate (`applicable && hasOverride`) must drop the reset button
        // while the override itself stays loaded (the "Overridden" badge proves it).
        mockApi.getChallengeOverride.mockResolvedValue(45);
        renderWithChallenge({ member: { boost: { state: 'USED' } } });

        await waitFor(() => {
            expect(numberInputs().length).toBeGreaterThan(0);
        });

        expect(numberInputs().every((i) => i.disabled)).toBe(true);
        // Override is retained (not cleared by the disable) ...
        expect(document.body.textContent).toContain('app.overridden');
        // ... but the per-field reset is suppressed while the group is inert.
        expect(resetButton()).toBeNull();
    });
});
