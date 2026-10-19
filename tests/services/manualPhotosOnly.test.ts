/**
 * isManualPhotosOnly: the shared gate of every automatic photo path. It reads the effective value through the
 * settings source it is handed, per challenge id, and answers true only for a stored `true`.
 */

import { isManualPhotosOnly } from '../../src/ts/services/manualPhotosOnly';
import { invalid } from '../helpers/invalid';

const sourceOf = (value: unknown) =>
    invalid<Parameters<typeof isManualPhotosOnly>[0]>({ getEffectiveSetting: jest.fn(() => value) });

describe('isManualPhotosOnly', () => {
    test('reads manualPhotosOnly for the challenge as a string id, from the source it is given', () => {
        const source = sourceOf(true);
        expect(isManualPhotosOnly(source, 42)).toBe(true);
        expect(source.getEffectiveSetting).toHaveBeenCalledWith('manualPhotosOnly', '42');
        expect(isManualPhotosOnly(source, 'c1')).toBe(true);
        expect(source.getEffectiveSetting).toHaveBeenLastCalledWith('manualPhotosOnly', 'c1');
    });

    test.each([[false], [undefined], [null], ['true'], [1]])('%p is not on', (value) => {
        expect(isManualPhotosOnly(sourceOf(value), 'c1')).toBe(false);
    });

    test.each([[undefined], [null]])('no challenge id (%p) is never on, and reads nothing', (id) => {
        const source = sourceOf(true);
        expect(isManualPhotosOnly(source, id)).toBe(false);
        expect(source.getEffectiveSetting).not.toHaveBeenCalled();
    });

    test('an empty-string id is still an id', () => {
        const source = sourceOf(true);
        expect(isManualPhotosOnly(source, '')).toBe(true);
    });
});
