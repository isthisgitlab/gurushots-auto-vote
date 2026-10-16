import { errorMessage, fileErrorMessage } from '../src/ts/errorMessage';

describe('errorMessage', () => {
    test.each<[string, unknown, string | undefined]>([
        ['an Error', new Error('boom'), 'boom'],
        ['a plain object with a message', { message: 'plain' }, 'plain'],
        ['an empty message', new Error(''), undefined],
        ['a non-string message', { message: 42 }, '42'],
        ['a falsy message', { message: 0 }, undefined],
        ['an object without a message', { code: 1 }, undefined],
        ['a string', 'text', undefined],
        ['null', null, undefined],
        ['undefined', undefined, undefined],
    ])('%s', (_label, error, expected) => {
        expect(errorMessage(error)).toBe(expected);
    });
});

describe('fileErrorMessage', () => {
    test.each<[string, unknown, string | undefined]>([
        [
            'a quoted path is cut to its file name',
            new Error("EACCES: permission denied, open '/Users/jane/data/a.json'"),
            "EACCES: permission denied, open 'a.json'",
        ],
        [
            'each path of a rename',
            new Error("ENOENT: rename 'C:\\Users\\jane\\a.tmp' -> '/home/jane/a.json'"),
            "ENOENT: rename 'a.tmp' -> 'a.json'",
        ],
        ['a message with no path is as it was', new Error('disk full'), 'disk full'],
        [
            'an apostrophe inside a path does not end it',
            new Error("EACCES: permission denied, open 'C:\\Users\\O'Brien\\x.json'"),
            "EACCES: permission denied, open 'x.json'",
        ],
        [
            'an apostrophe inside either path of a rename',
            new Error("ENOENT: rename '/home/o'neil/a.tmp' -> 'C:\\Users\\O'Brien\\a.json'"),
            "ENOENT: rename 'a.tmp' -> 'a.json'",
        ],
        ['text after the path is kept', new Error("open '/Users/jane/a.json' failed"), "open 'a.json' failed"],
        ['a lone quote is kept', new Error("it's broken"), "it's broken"],
        ['a quoted word that is not a path is kept', new Error("bad 'value'"), "bad 'value'"],
        ['no message', null, undefined],
    ])('%s', (_label, error, expected) => {
        expect(fileErrorMessage(error)).toBe(expected);
    });
});
