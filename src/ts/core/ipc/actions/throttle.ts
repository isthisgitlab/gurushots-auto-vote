/**
 * The single-flight queue the library walk and the photo-stats reads share a
 * pattern from: one job of a queue runs at a time, with a minimum gap between
 * the end of one job and the start of the next, and a job that arrives while
 * another is already waiting replaces it. Each handler owns its own instance,
 * so a slow walk never delays a stats answer and the other way round.
 */

/** What a throttled request resolves to when a newer request took its place in the queue. */
const SUPERSEDED = Symbol('superseded');

// `run` settles the caller's promise itself and never rejects.
type Pending = { run: () => Promise<void>; drop: () => void };

/**
 * @param minIntervalMs - the minimum gap between two jobs of this queue
 */
const createThrottle = (minIntervalMs: number) => {
    let pending: Pending | null = null;
    let running = false;
    let lastEndedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pump = (): void => {
        if (running || !pending || timer !== undefined) return;
        const delay = lastEndedAt + minIntervalMs - Date.now();
        if (delay > 0) {
            timer = setTimeout(() => {
                timer = undefined;
                pump();
            }, delay);
            return;
        }
        const next = pending;
        pending = null;
        running = true;
        void next.run().finally(() => {
            running = false;
            lastEndedAt = Date.now();
            pump();
        });
    };

    return {
        /**
         * Run `job` as the only job in flight: it starts at once when none is
         * running and the minimum gap has passed, otherwise it waits — and a
         * job that arrives while another is already waiting replaces it (the
         * older caller gets SUPERSEDED), because only the newest request is
         * still wanted.
         */
        run: <T>(job: () => Promise<T>): Promise<T | typeof SUPERSEDED> =>
            new Promise((resolve, reject) => {
                pending?.drop();
                pending = {
                    run: () => job().then(resolve, reject),
                    drop: () => resolve(SUPERSEDED),
                };
                pump();
            }),
        /** Test-only: forget the queue state between cases. */
        reset: (): void => {
            clearTimeout(timer);
            timer = undefined;
            pending = null;
            running = false;
            lastEndedAt = 0;
        },
    };
};

export { SUPERSEDED, createThrottle };
