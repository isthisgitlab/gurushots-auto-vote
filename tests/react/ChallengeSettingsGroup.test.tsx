/**
 * ChallengeSettingsGroup's "Saved on this device only." hint. The remote page keeps the view
 * preferences on the device, so its compactCards row carries the hint tied to the checkbox with
 * aria-describedby. The Profiles tab reuses this group with overriddenLabelKey set — a profile's
 * values are desktop-owned (saving one writes the desktop's settings), so the hint would be false
 * there and never shows; off the remote kind no context shows it.
 */

import { render as renderWithProviders } from '@testing-library/preact';
import { screen } from './helpers/test-utils';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { ChallengeSettingsGroup } from '@/components/app/ChallengeSettingsGroup';
import { markPlatformKind } from '../../src/ts/core/platform/kind';
import { resetPlatformKind } from '../helpers/platformKind';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

import type { ChallengeGroupContext } from '@/components/app/ChallengeSettingsGroup';
import type { SerializableSchemaEntry } from '../../src/ts/core/ipc/settings.handlers';

type Form = ChallengeGroupContext['form'];

const emptyForm = (): Form =>
    invalid<Form>({
        overrides: {},
        profileValues: {},
        inheritedOf: () => false,
        ruleSourceOf: () => undefined,
        changeOverride: () => undefined,
        clearOverride: () => undefined,
    });

// Rendered with the TranslationProvider only: the group reads no autovote state, and the shared
// wrapper's AutovoteProvider refuses to mount on the remote kind without a pairing transport.
const renderGroup = (props: { overriddenLabelKey?: string } = {}) =>
    renderWithProviders(
        <TranslationProvider>
            <ChallengeSettingsGroup
                id="display"
                label="app.groupDisplay"
                entries={[
                    [
                        'compactCards',
                        invalid<SerializableSchemaEntry>({
                            type: 'boolean',
                            default: false,
                            label: 'app.compactCards',
                            description: 'app.compactCardsDesc',
                            group: 'display',
                        }),
                    ],
                ]}
                challenge={null}
                defaults={invalid({ compactCards: false })}
                form={emptyForm()}
                hintsFor={() => []}
                {...props}
            />
        </TranslationProvider>,
    );

beforeEach(() => {
    window.api = invalid(mockApi);
});

describe('ChallengeSettingsGroup — the device-only hint', () => {
    afterEach(resetPlatformKind);

    test('the remote kind ties it to the compact checkbox', () => {
        markPlatformKind('remote');
        renderGroup();
        const hint = document.getElementById('challenge-setting-compactCards-device-hint');
        expect(hint).not.toBeNull();
        expect(hint!.textContent).toBe('app.savedOnThisDevice');
        expect(document.getElementById('challenge-setting-compactCards')!.getAttribute('aria-describedby')).toBe(
            'challenge-setting-compactCards-device-hint',
        );
    });

    test('the Profiles tab (overriddenLabelKey set) never shows it, even on the remote kind', () => {
        markPlatformKind('remote');
        renderGroup({ overriddenLabelKey: 'app.setInProfile' });
        expect(screen.queryByText('app.savedOnThisDevice')).toBeNull();
        expect(document.getElementById('challenge-setting-compactCards')!.getAttribute('aria-describedby')).toBeNull();
    });

    test('off the remote kind no context shows it', () => {
        renderGroup();
        expect(screen.queryByText('app.savedOnThisDevice')).toBeNull();
        expect(document.getElementById('challenge-setting-compactCards-device-hint')).toBeNull();
        expect(document.getElementById('challenge-setting-compactCards')!.getAttribute('aria-describedby')).toBeNull();
    });
});
