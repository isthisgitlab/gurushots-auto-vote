/**
 * src/ts/index/session.ts — the one in-memory partition the app windows use, and the best-effort removal of the
 * on-disk partition directory a persistent partition of that name would have left under the user-data directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as loggerModule from '../../src/ts/logger';
import type * as sessionModule from '../../src/ts/index/session';
import type { CategoryLogger } from '../../src/ts/logger';

// A partial mock of the real fs, so a failing delete can be injected.
jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => cat), cat };
});

const { APP_PARTITION, removeStalePartitionData } = require('../../src/ts/index/session') as typeof sessionModule;
const cat = jest.mocked((require('../../src/ts/logger') as typeof loggerModule & { cat: CategoryLogger }).cat);

let userData: string;

beforeEach(() => {
    jest.clearAllMocks();
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
});

afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
});

describe('APP_PARTITION', () => {
    it('names an in-memory partition: no persist: prefix', () => {
        expect(APP_PARTITION).toBe('gurushots');
        expect(APP_PARTITION.startsWith('persist:')).toBe(false);
    });
});

describe('removeStalePartitionData', () => {
    it('deletes Partitions/gurushots under the user-data directory and leaves the other partitions', () => {
        const stale = path.join(userData, 'Partitions', 'gurushots');
        const other = path.join(userData, 'Partitions', 'other');
        fs.mkdirSync(path.join(stale, 'Local Storage'), { recursive: true });
        fs.writeFileSync(path.join(stale, 'Local Storage', 'leveldb'), 'x');
        fs.mkdirSync(other, { recursive: true });

        removeStalePartitionData(() => userData);

        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(other)).toBe(true);
        expect(cat.info).toHaveBeenCalledWith('Removed stale on-disk browser session data', null);
    });

    it('does nothing, and says nothing, when there is no such directory', () => {
        removeStalePartitionData(() => userData);

        expect(cat.info).not.toHaveBeenCalled();
        expect(cat.warning).not.toHaveBeenCalled();
    });

    it('logs a failure instead of throwing, whether the path or the removal fails', () => {
        const boom = new Error('no userData');
        expect(() =>
            removeStalePartitionData(() => {
                throw boom;
            }),
        ).not.toThrow();
        expect(cat.warning).toHaveBeenCalledWith(
            'Could not remove stale on-disk browser session data (non-fatal):',
            boom,
        );

        const stale = path.join(userData, 'Partitions', 'gurushots');
        fs.mkdirSync(stale, { recursive: true });
        const removal = new Error('busy');
        jest.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
            throw removal;
        });
        removeStalePartitionData(() => userData);
        expect(cat.warning).toHaveBeenCalledWith(
            'Could not remove stale on-disk browser session data (non-fatal):',
            removal,
        );
    });
});
