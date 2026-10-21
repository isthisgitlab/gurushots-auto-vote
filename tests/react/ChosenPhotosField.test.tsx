/**
 * The `photos` setting input and the chosen-photos control it is built on:
 * chosen photos as text chips (their ids are not sent anywhere on their own, so
 * they read as themselves), a Choose button that opens the chooser, Clear, the
 * rule-row "Inherit" variant, and the challenge context the chooser reads
 * eligibility through.
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { SettingInput } from '@/components/app/SettingInput';
import { ChosenPhotosControl } from '@/components/app/ChosenPhotosField';
import { SettingsChallengeProvider } from '@/contexts/SettingsChallengeContext';
import type { SerializableSchemaEntry } from '../../src/ts/ipc/settings.handlers';
import { invalid } from '../helpers/invalid';

const MEMBER = 'c'.repeat(32);
const idOf = (n: number) => `${String(n).padStart(8, '0')}${'a'.repeat(24)}`;

const config = invalid<SerializableSchemaEntry>({ type: 'photos', default: [], perChallenge: true });

const libraryOf = (...numbers: number[]) => ({
    success: true,
    photos: numbers.map((n) => ({ id: idOf(n), labels: [`tag${n}`], allowed: true, message: null, uploadDate: 1 })),
    memberId: MEMBER,
    truncated: false,
    wonIds: [],
    wonCount: 0,
    preview: false,
    readAtMs: 1_700_000_000_000,
    allowedKnown: true,
});

const renderInput = (value: unknown, over: Record<string, unknown> = {}) => {
    const props = { settingKey: 'chosenPhotos', config, value, onChange: jest.fn(), onReset: jest.fn(), ...over };
    return { ...props, ...render(<SettingInput {...props} />) };
};

beforeEach(() => {
    window.api.getLibraryPhotos = jest.fn().mockResolvedValue(libraryOf(1, 2));
});

describe('the photos setting input', () => {
    test('an empty list reads "none" and Clear still stores an explicit empty list', () => {
        const { onChange } = renderInput([]);
        expect(screen.getByText('app.none')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'app.photosClear' }));
        expect(onChange).toHaveBeenCalledWith('chosenPhotos', []);
    });

    test('with no value and no default it renders the empty list', () => {
        renderInput(undefined, { config: invalid({ type: 'photos', perChallenge: true }) });
        expect(screen.getByText('app.none')).toBeTruthy();
    });

    test('a corrupted stored value renders as an empty list, and non-string ids are ignored', () => {
        renderInput('nonsense');
        expect(screen.getByText('app.none')).toBeTruthy();
        renderInput([idOf(1), 5, null]);
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });

    test('chips are numbered in the saved order, each reading its number and id start', () => {
        renderInput([idOf(3), idOf(1), idOf(2)]);
        const chips = screen.getAllByRole('listitem').map((item) => item.textContent);
        expect(chips).toEqual(['100000003', '200000001', '300000002']);
        expect(document.querySelector('img')).toBeNull();
    });

    test('Choose photos opens the chooser idle, and using the selection reports the new list', async () => {
        const { onChange } = renderInput([]);
        fireEvent.click(screen.getByRole('button', { name: 'app.choosePhotos' }));
        // Nothing is read on open: the library is asked for only by Load all.
        await screen.findByRole('dialog');
        expect(window.api.getLibraryPhotos).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'app.pickLoadPhotos' }));
        // Translations echo their key here, so every tile has the same name; the second is photo 2.
        await screen.findAllByRole('button', { name: 'app.photoChooserTileLabel' });
        fireEvent.click(screen.getAllByRole('button', { name: 'app.photoChooserTileLabel' })[1]);
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
        await waitFor(() => expect(onChange).toHaveBeenCalledWith('chosenPhotos', [idOf(2)]));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    test('Cancel closes the chooser without reporting anything', async () => {
        const { onChange } = renderInput([]);
        fireEvent.click(screen.getByRole('button', { name: 'app.choosePhotos' }));
        await screen.findByRole('dialog');
        fireEvent.click(screen.getByRole('button', { name: 'app.cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onChange).not.toHaveBeenCalled();
    });

    test('is named by its caption and disabled with the rest of the row', () => {
        renderInput([idOf(1)], { disabled: true });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.choosePhotos' }).disabled).toBe(true);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.photosClear' }).disabled).toBe(true);
    });

    test('the reset button hands the key to onReset', () => {
        const { onReset } = renderInput([idOf(1)]);
        fireEvent.click(document.querySelector('button[title^="app.resetToDefaultNotSaved"]')!);
        expect(onReset).toHaveBeenCalledWith('chosenPhotos');
    });
});

describe('challenge context', () => {
    test('inside a per-challenge editor the chooser reads the library through that challenge, on demand', async () => {
        render(
            <SettingsChallengeProvider value={77}>
                <SettingInput settingKey="chosenPhotos" config={config} value={[]} onChange={jest.fn()} />
            </SettingsChallengeProvider>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.choosePhotos' }));
        await screen.findByRole('dialog');
        expect(window.api.getLibraryPhotos).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'app.pickLoadPhotos' }));
        await waitFor(() =>
            expect(window.api.getLibraryPhotos).toHaveBeenCalledWith(77, undefined, 'cached', 'submit', 0, 100),
        );
    });

    test('inside a per-challenge editor Clear is "Use none", described by a hint that the reset button brings the inherited list back', () => {
        const onChange = jest.fn();
        render(
            <SettingsChallengeProvider value={77}>
                <SettingInput settingKey="chosenPhotos" config={config} value={[idOf(1)]} onChange={onChange} />
            </SettingsChallengeProvider>,
        );
        expect(screen.queryByRole('button', { name: 'app.photosClear' })).toBeNull();
        const none = screen.getByRole('button', { name: 'app.photosUseNone' });
        const hint = screen.getByText('app.photosUseNoneHint');
        expect(none.getAttribute('aria-describedby')).toBe(hint.id);
        fireEvent.click(none);
        expect(onChange).toHaveBeenCalledWith('chosenPhotos', []);
    });

    test('outside one it keeps Clear, with no hint', () => {
        renderInput([idOf(1)]);
        expect(screen.getByRole('button', { name: 'app.photosClear' }).getAttribute('aria-describedby')).toBeNull();
        expect(screen.queryByText('app.photosUseNoneHint')).toBeNull();
    });

    test('outside one it asks with no challenge, again only on demand', async () => {
        renderInput([]);
        fireEvent.click(screen.getByRole('button', { name: 'app.choosePhotos' }));
        await screen.findByRole('dialog');
        expect(window.api.getLibraryPhotos).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'app.pickLoadPhotos' }));
        await waitFor(() =>
            expect(window.api.getLibraryPhotos).toHaveBeenCalledWith(null, undefined, 'cached', 'submit', 0, 100),
        );
    });
});

describe('ChosenPhotosControl as a rule row', () => {
    test('nothing set reads Inherit and offers no Clear', () => {
        render(
            <ChosenPhotosControl
                value={null}
                onChange={jest.fn()}
                onClear={jest.fn()}
                clearLabel="app.titleRuleInherit"
            />,
        );
        expect(screen.getByText('app.titleRuleInherit')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'app.titleRuleInherit' })).toBeNull();
    });

    test('an explicit list can be reset to inherit', async () => {
        const onClear = jest.fn();
        const onChange = jest.fn();
        render(
            <ChosenPhotosControl
                value={[idOf(1)]}
                onChange={onChange}
                onClear={onClear}
                clearLabel="app.titleRuleInherit"
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.titleRuleInherit' }));
        expect(onClear).toHaveBeenCalledTimes(1);
        await act(async () => undefined);
    });
});
