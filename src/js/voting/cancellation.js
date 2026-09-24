/**
 * Single source of truth for the voting-cancellation flag, shared by
 * real-api, mock, and the Electron main process.
 *
 * One flag rather than per-module copies kept in sync by a fan-out in the
 * IPC handler: that fan-out is a drift hazard — if one site missed the
 * update, the user could press cancel and the voting loop would keep
 * running.
 */

let cancelled = false;

const isCancelled = () => cancelled;

const setCancelled = (value) => {
    cancelled = !!value;
};

const reset = () => {
    cancelled = false;
};

module.exports = {
    isCancelled,
    setCancelled,
    reset,
};
