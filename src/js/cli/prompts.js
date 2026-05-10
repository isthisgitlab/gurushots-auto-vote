/**
 * Readline-based interactive prompts for the CLI host. Pure I/O —
 * no settings, no auth, no business logic. Each helper takes the
 * readline interface as an argument so the caller controls its
 * lifecycle (open in handleLogin, close in finally).
 *
 * The askSecret muting trick relies on readline's internal
 * `_writeToOutput` hook and is documented inline.
 */

const readline = require('readline');

const createReadlineInterface = () =>
    readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

const askYesNo = async (question, rl) =>
    new Promise((resolve) => {
        rl.question(`${question} (y/n): `, (answer) => {
            const normalized = answer.toLowerCase().trim();
            resolve(normalized === 'y' || normalized === 'yes');
        });
    });

const askInput = async (question, rl) =>
    new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });

/**
 * Ask for a secret. Mutes terminal echo while the user types so the
 * password is not visible on screen / scrollback / shoulder-surf.
 *
 * The mute uses readline's `_writeToOutput` hook (the standard pattern).
 * It only works on an interactive TTY — `_writeToOutput` is a no-op when
 * readline runs in non-terminal mode (piped stdin, CI). Callers must
 * gate on `process.stdin.isTTY` and refuse non-interactive invocation
 * for any prompt that handles credentials.
 *
 * Known limitation: while muted, backspace ANSI redraw sequences are
 * also suppressed, so a user correcting a typo sees the prompt blank
 * out. The submitted password is unaffected; correcting + re-typing
 * still produces the right value. Acceptable trade for "no echo at all"
 * vs. the more complex stty-style raw-mode path.
 */
const askSecret = async (question, rl) =>
    new Promise((resolve) => {
        const originalWriteToOutput = rl._writeToOutput;
        rl.question(question, (answer) => {
            rl.output.write('\n');
            rl.stdoutMuted = false;
            rl._writeToOutput = originalWriteToOutput;
            resolve(answer.trim());
        });
        rl.stdoutMuted = true;
        rl._writeToOutput = (s) => {
            if (rl.stdoutMuted) {
                if (s.includes('\n') || s.includes('\r')) rl.output.write(s);
            } else if (originalWriteToOutput) {
                originalWriteToOutput.call(rl, s);
            } else {
                rl.output.write(s);
            }
        };
    });

module.exports = { createReadlineInterface, askYesNo, askInput, askSecret };
