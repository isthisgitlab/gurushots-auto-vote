/**
 * What the scenario handler modules (scenarios.handlers.ts, scenarioLifecycle.handlers.ts) share: the category log, the
 * runtime checks of a received argument, and the wrapper that turns a throw into a failure result so that a handler never
 * throws to the renderer.
 */

import * as logger from '../logger';
import { errorResult } from './errorResult';

const log = () => logger.withCategory('scenario');

const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** A count a caller sends: a generation, an epoch (a non-negative safe integer). */
const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// `issues?: undefined` keeps this arm distinct from the validation failures that
// do carry issues, so a renderer narrowing on `'issues' in result` keeps them.
const invalidArgs: { success: false; error: string; issues?: undefined } = { success: false, error: 'invalid-args' };

/**
 * Runs a handler body, turning a throw into an error result.
 */
const safely = async <T>(
    label: string,
    body: () => T | Promise<T>,
): Promise<T | { success: false; error: string; issues?: undefined }> => {
    try {
        return await body();
    } catch (error) {
        log().error(`Error handling ${label} request:`, error);
        return errorResult(error, `The ${label} request failed`);
    }
};

export { log, isName, isCount, invalidArgs, safely };
