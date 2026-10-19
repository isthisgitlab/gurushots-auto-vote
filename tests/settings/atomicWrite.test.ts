/**
 * The atomic replace of a JSON store's file: a rename that is refused as busy (what
 * Windows answers while another process holds the target open) is tried again a few
 * times, briefly apart; any other failure, and a busy one that does not clear, throws.
 */

jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeAtomicOwnerOnly } from '../../src/ts/settings/atomicWrite';

describe('writeAtomicOwnerOnly rename retry', () => {
    let root: string;
    let file: string;
    let waits: number[];

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-atomic-'));
        file = path.join(root, 'store.json');
        waits = [];
        jest.spyOn(Atomics, 'wait').mockImplementation((_view, _index, _value, timeout) => {
            waits.push(timeout ?? 0);
            return 'timed-out';
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const busy = (code: string) => () => {
        throw Object.assign(new Error(`${code}: resource busy or locked`), { code });
    };

    test.each(['EPERM', 'EBUSY'])('a rename refused with %s is tried again, and lands', (code) => {
        const realRename = fs.renameSync;
        const rename = jest
            .spyOn(fs, 'renameSync')
            .mockImplementationOnce(busy(code))
            .mockImplementationOnce(busy(code))
            .mockImplementation(realRename);

        writeAtomicOwnerOnly(file, '{"a":1}');

        expect(rename).toHaveBeenCalledTimes(3);
        expect(waits).toEqual([10, 25]);
        expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
        expect(fs.readdirSync(root)).toEqual(['store.json']);
    });

    test('a rename that stays busy gives up after a bounded number of tries, throws, and leaves no temp file', () => {
        const rename = jest.spyOn(fs, 'renameSync').mockImplementation(busy('EBUSY'));

        expect(() => writeAtomicOwnerOnly(file, '{}')).toThrow('EBUSY');

        expect(rename).toHaveBeenCalledTimes(6);
        expect(waits).toEqual([10, 25, 50, 100, 200]);
        expect(fs.readdirSync(root)).toEqual([]);
    });

    test('any other rename failure throws at once', () => {
        const rename = jest.spyOn(fs, 'renameSync').mockImplementation(busy('EACCES'));

        expect(() => writeAtomicOwnerOnly(file, '{}')).toThrow('EACCES');

        expect(rename).toHaveBeenCalledTimes(1);
        expect(waits).toEqual([]);
    });

    test('a thrown value that is not an error is not retried either', () => {
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
            throw 'odd';
        });

        expect(() => writeAtomicOwnerOnly(file, '{}')).toThrow('odd');
        expect(waits).toEqual([]);
    });
});
