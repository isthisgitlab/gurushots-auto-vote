/**
 * The logger's single console writer: every console line the logger emits goes
 * through here, so the console is written in exactly one place.
 */
const writeConsole = (stream: 'debug' | 'log' | 'error', ...args: unknown[]) => {
    switch (stream) {
        case 'debug':
            // aislop-ignore-next-line ai-slop/console-leftover -- the logger's console sink; writing to the console is this function's job
            console.debug(...args);
            return;
        case 'log':
            // aislop-ignore-next-line ai-slop/console-leftover -- the logger's console sink; writing to the console is this function's job
            console.log(...args);
            return;
        default:
            console.error(...args);
    }
};

export { writeConsole };
