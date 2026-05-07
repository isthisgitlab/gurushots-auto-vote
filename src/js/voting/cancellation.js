/**
 * Single source of truth for the voting-cancellation flag.
 *
 * Three modules used to each maintain their own copy (real-api, mock,
 * and the Electron main process) and rely on a manual fan-out in the
 * IPC handler to keep them in sync. That fan-out was a drift hazard:
 * if one site forgot to update, the user could press cancel and the
 * voting loop would keep running. The flag now lives here.
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
