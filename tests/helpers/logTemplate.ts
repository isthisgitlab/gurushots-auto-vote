import { logMessages } from '../../src/ts/translations/logEnglish';

/**
 * Renders a log-catalog template the way the logger's T-methods do, so harness
 * sinks that record rendered lines (the level jest.fn mocks) can expose the
 * byte-identical message the real logger would write.
 */
export const renderLogTemplate = (key: string, params: unknown[]): string =>
    logMessages[key as keyof typeof logMessages].replace(/\{(\d+)\}/g, (_, index: string) =>
        String(params[Number(index)]),
    );
