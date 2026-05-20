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
// jsdom-env globals occasionally lose it between test files. Pin it
// here so this suite is hermetic.
beforeEach(() => {
    window.api = mockApi;
});

const mockSchemaState = {
    schema: {
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

function readNumberInput() {
    // Schema has exactly one perChallenge entry (boostTime, type=number),
    // so there's a single number input to inspect.
    const inputs = document.querySelectorAll('input[type="number"]');
    return inputs.length ? inputs[inputs.length - 1].value : null;
}

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
