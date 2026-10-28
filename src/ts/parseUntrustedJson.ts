/**
 * The read the small ledgers make of their stored text: parse untrusted JSON,
 * keep it when it is an object, answer an empty one when it is not — and when
 * the text cannot be parsed at all, say so once in the caller's category with
 * the caller's words, then answer empty all the same. `readRaw` runs inside
 * the try, so a store whose read itself throws lands in the same warning.
 *
 * The module also holds the in-memory raw-JSON store the mock-mode ledgers sit on.
 */

import type { RawJsonStore } from './types/stores';
import * as logger from './logger';
import { isPlainObject } from './plainObject';

/**
 * @param readRaw - the store's raw read; called inside the try
 * @param category - the log category the caller's warnings use
 * @param unreadable - the warning line for a store that cannot be read, made from what was caught
 * @returns the parsed object, or an empty one when it cannot be trusted
 */
const parseUntrustedJsonObject = (
    readRaw: () => string | null,
    category: string,
    unreadable: (error: unknown) => string,
): Record<string, unknown> => {
    try {
        const parsed: unknown = JSON.parse(readRaw() || '{}');
        return isPlainObject(parsed) ? parsed : {};
    } catch (error) {
        logger.withCategory(category).warning(unreadable(error), null);
        return {};
    }
};

/**
 * A raw-JSON store over one string in memory — mock mode, tests. Every call
 * makes a store of its own, empty (null: never written) until written.
 * @returns the store ({readRaw, writeRaw}) over that string
 */
const createMemoryRawJsonStore = (): RawJsonStore => {
    let raw: string | null = null;
    return {
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
    };
};

export { createMemoryRawJsonStore, parseUntrustedJsonObject };
