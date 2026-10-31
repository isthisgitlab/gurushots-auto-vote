/**
 * Whether a voting pass is under way in this process, for the work that must not run beneath one (deleting the local
 * data). A count, not a flag: a manual pass can overlap an automatic one.
 */

let running = 0;

/**
 * Marks a pass as started.
 *
 * @returns end: marks it finished (once)
 */
const beginVotingPass = (): (() => void) => {
    running++;
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        running--;
    };
};

const isVotingPassRunning = (): boolean => running > 0;

export { beginVotingPass, isVotingPassRunning };
