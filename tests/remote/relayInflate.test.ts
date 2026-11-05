/**
 * The queue finished messages wait in before they are unzipped: at most four run at once, the rest
 * wait in order up to a cap, a message queued or running is in progress, and closing drops the queue.
 */

import {
    MAX_CONCURRENT_INFLATES,
    MAX_QUEUED_INFLATES,
    createInflateQueue,
} from '../../src/ts/core/remote/relayInflate';

type Gate = { started: boolean; finish: () => void; run: () => Promise<void> };

/** A job that starts when the queue runs it and ends when the test lets it. */
const gate = (log: string[], name: string): Gate => {
    let finish!: () => void;
    const released = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const job: Gate = {
        started: false,
        finish,
        run: async () => {
            job.started = true;
            log.push(name);
            await released;
        },
    };
    return job;
};

const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('createInflateQueue', () => {
    test('at most four jobs run at once; the others start in the order queued as slots free', async () => {
        const queue = createInflateQueue();
        const log: string[] = [];
        const jobs = Array.from({ length: 7 }, (_v, i) => gate(log, `j${i}`));
        jobs.forEach((job, i) => queue.add(`k${i}`, job.run));
        expect(MAX_CONCURRENT_INFLATES).toBe(4);
        expect(log).toEqual(['j0', 'j1', 'j2', 'j3']);
        jobs[2].finish();
        await settle();
        expect(log).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
        jobs[0].finish();
        jobs[1].finish();
        await settle();
        expect(log).toEqual(['j0', 'j1', 'j2', 'j3', 'j4', 'j5', 'j6']);
        jobs.forEach((job) => job.finish());
        await settle();
    });

    test('a job queued or running is in progress until it ends', async () => {
        const queue = createInflateQueue();
        const log: string[] = [];
        const jobs = Array.from({ length: 5 }, (_v, i) => gate(log, `j${i}`));
        jobs.forEach((job, i) => queue.add(`k${i}`, job.run));
        expect(queue.has('k0')).toBe(true); // running
        expect(queue.has('k4')).toBe(true); // waiting
        expect(queue.has('other')).toBe(false);
        jobs[0].finish();
        await settle();
        expect(queue.has('k0')).toBe(false);
        expect(queue.has('k4')).toBe(true);
        jobs.forEach((job) => job.finish());
        await settle();
        expect(queue.has('k4')).toBe(false);
    });

    test('a job that fails frees its slot and ends being in progress', async () => {
        const queue = createInflateQueue();
        const log: string[] = [];
        for (let i = 0; i < MAX_CONCURRENT_INFLATES; i++) {
            queue.add(`k${i}`, () => Promise.reject(new Error('boom')));
        }
        const next = gate(log, 'next');
        queue.add('next', next.run);
        await settle();
        expect(log).toEqual(['next']);
        expect(queue.has('k0')).toBe(false);
        next.finish();
    });

    test('the queue is full when the waiting jobs reach the cap; running jobs do not count', async () => {
        const queue = createInflateQueue();
        const log: string[] = [];
        const jobs = Array.from({ length: MAX_CONCURRENT_INFLATES + MAX_QUEUED_INFLATES }, (_v, i) =>
            gate(log, `j${i}`),
        );
        jobs.forEach((job, i) => {
            expect(queue.isFull()).toBe(false);
            queue.add(`k${i}`, job.run);
        });
        expect(MAX_QUEUED_INFLATES).toBe(512);
        expect(queue.isFull()).toBe(true);
        jobs[0].finish();
        await settle();
        expect(queue.isFull()).toBe(false); // one waiting job started
        jobs.forEach((job) => job.finish());
        await settle();
    });

    test('closing drops what waits, forgets what is in progress and starts nothing more; running jobs end on their own', async () => {
        const queue = createInflateQueue();
        const log: string[] = [];
        const jobs = Array.from({ length: 6 }, (_v, i) => gate(log, `j${i}`));
        jobs.forEach((job, i) => queue.add(`k${i}`, job.run));
        queue.close();
        expect(queue.has('k0')).toBe(false);
        expect(queue.has('k5')).toBe(false);
        jobs.slice(0, 4).forEach((job) => job.finish());
        await settle();
        expect(log).toEqual(['j0', 'j1', 'j2', 'j3']);
        expect(jobs[4].started).toBe(false);
    });

    test('closing a full queue empties it', () => {
        const queue = createInflateQueue();
        const log: string[] = [];
        for (let i = 0; i < MAX_CONCURRENT_INFLATES + MAX_QUEUED_INFLATES; i++) {
            queue.add(`k${i}`, gate(log, `j${i}`).run);
        }
        expect(queue.isFull()).toBe(true);
        queue.close();
        expect(queue.isFull()).toBe(false);
    });
});
