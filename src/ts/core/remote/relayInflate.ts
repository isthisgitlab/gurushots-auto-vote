/**
 * The queue a finished message waits in before it is unzipped and parsed. A batch event can finish
 * many messages at once, and each is inflated to as much as `MAX_PEER_MESSAGE_BYTES`, so at most
 * `MAX_CONCURRENT_INFLATES` run at a time, whatever the finished-message burst: the memory that
 * inflation holds at once stays bounded. The messages above that wait in order, up to
 * `MAX_QUEUED_INFLATES`; past that the caller drops the next one unread. A message that is queued or
 * running is in progress: the caller asks `has` before it queues a message that arrives again.
 * Dependency-free.
 */

/** At most this many messages are unzipped and parsed at the same time. */
export const MAX_CONCURRENT_INFLATES = 4;

/** At most this many finished messages wait for an inflation slot. */
export const MAX_QUEUED_INFLATES = 512;

export type InflateQueue = {
    /** Whether the key is queued or running. */
    has: (key: string) => boolean;
    /** Whether no more messages can wait. */
    isFull: () => boolean;
    /** Queues a job; it starts, in the order queued, when fewer than MAX_CONCURRENT_INFLATES run. */
    add: (key: string, run: () => Promise<void>) => void;
    /** Drops what waits and starts nothing more; a job already running ends on its own. */
    close: () => void;
};

type Job = { key: string; run: () => Promise<void> };

export const createInflateQueue = (): InflateQueue => {
    const inProgress = new Set<string>();
    const waiting: Job[] = [];
    let running = 0;
    let closed = false;

    const start = (): void => {
        while (!closed && running < MAX_CONCURRENT_INFLATES && waiting.length > 0) {
            const job = waiting.shift() as Job;
            running += 1;
            const finished = (): void => {
                running -= 1;
                inProgress.delete(job.key);
                start();
            };
            void job.run().then(finished, finished);
        }
    };

    return {
        has: (key) => inProgress.has(key),
        isFull: () => waiting.length >= MAX_QUEUED_INFLATES,
        add: (key, run) => {
            inProgress.add(key);
            waiting.push({ key, run });
            start();
        },
        close: () => {
            closed = true;
            waiting.length = 0;
            inProgress.clear();
        },
    };
};
