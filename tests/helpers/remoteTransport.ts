/**
 * An in-memory RemoteTransport for the remote-access tests: two ends joined
 * directly, no WebRTC. `pair()` returns the two ends; every send on one is
 * delivered to the other's message listeners. Each end also exposes its
 * listener sets, so a test can fire the transport's own events (peer joins,
 * leaves, join errors) and simulate a lost connection.
 */

import type { RemotePath, RemoteTransport } from '../../src/ts/core/remote/relays';

type Handler<T extends unknown[]> = (...args: T) => void;

class TransportStub implements RemoteTransport {
    readonly peerId: string;
    sent: Array<{ message: unknown; target?: string }> = [];
    left = false;
    private other: TransportStub | null = null;
    private failNextSend = false;
    private readonly messageHandlers = new Set<Handler<[peerId: string, message: unknown]>>();
    private readonly joinHandlers = new Set<Handler<[peerId: string]>>();
    private readonly leaveHandlers = new Set<Handler<[peerId: string, unacked?: number]>>();
    /** The messages the double has queued for a peer and not started sending (what the relay link would hand back). */
    readonly unsent = new Map<string, unknown[]>();
    /** The messages the double has started sending a peer that are not acknowledged (what `startedMessages` answers; they stay). */
    readonly started = new Map<string, unknown[]>();
    /** The peers `redirect` was called for, with the handler it was given for messages that finish packing later. */
    readonly redirects = new Map<string, (message: unknown) => void>();
    /** The peers `stopRedirect` was called for, in order. */
    readonly stoppedRedirects: string[] = [];
    /** How many messages the double says are in flight to each peer. */
    readonly inFlightCounts = new Map<string, number>();
    /** The callbacks `whenIdle` is holding for each peer; a cancel removes its callback. */
    readonly idleWaiters = new Map<string, Set<() => void>>();
    private readonly pathHandlers = new Set<Handler<[peerId: string, path: RemotePath]>>();
    private readonly joinErrorHandlers = new Set<Handler<[details: { error: string; peerId: string }]>>();

    constructor(peerId: string) {
        this.peerId = peerId;
    }

    /** Joins two ends: sends on one arrive at the other. */
    static pair(hostId = 'host', phoneId = 'phone'): [TransportStub, TransportStub] {
        const host = new TransportStub(hostId);
        const phone = new TransportStub(phoneId);
        host.other = phone;
        phone.other = host;
        return [host, phone];
    }

    /** Drops the next send (the connection died mid-flight). */
    failNextSendOnce(): void {
        this.failNextSend = true;
    }

    /** Deliver a payload as if the peer had sent it. */
    receiveFromPeer(raw: unknown, from?: string): void {
        for (const handler of this.messageHandlers) handler(from ?? this.other?.peerId ?? '', raw);
    }

    emitJoin(peerId: string): void {
        for (const handler of this.joinHandlers) handler(peerId);
    }

    /** `unacked` is the relay link's count of messages it had sent the peer that were never acknowledged. */
    emitLeave(peerId: string, unacked?: number): void {
        for (const handler of this.leaveHandlers) handler(peerId, unacked);
    }

    /** The hybrid transport tells a joined peer moved to another path in place. */
    emitPathChange(peerId: string, path: RemotePath): void {
        for (const handler of this.pathHandlers) handler(peerId, path);
    }

    /** The failure is about `peerId` (the other end unless named) — a fellow phone's can be told apart from the desktop's. */
    emitJoinError(error: string, peerId?: string): void {
        for (const handler of this.joinErrorHandlers) handler({ error, peerId: peerId ?? this.other?.peerId ?? '' });
    }

    // The production sites carry a frame-guard disable comment; a test double needs no comment,
    // but oxlint sees this `send` too, hence the one here.
    // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- the in-memory double of the pairing transport
    async send(message: unknown, target?: string): Promise<void> {
        this.sent.push({ message, target });
        if (this.failNextSend) {
            this.failNextSend = false;
            throw new Error('connection gone');
        }
        this.other?.receiveFromPeer(message, this.peerId);
    }

    onMessage(handler: Handler<[peerId: string, message: unknown]>): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    onPeerJoin(handler: Handler<[peerId: string]>): () => void {
        this.joinHandlers.add(handler);
        return () => this.joinHandlers.delete(handler);
    }

    onPeerLeave(handler: Handler<[peerId: string, unacked?: number]>): () => void {
        this.leaveHandlers.add(handler);
        return () => this.leaveHandlers.delete(handler);
    }

    onPathChange(handler: Handler<[peerId: string, path: RemotePath]>): () => void {
        this.pathHandlers.add(handler);
        return () => this.pathHandlers.delete(handler);
    }

    onJoinError(handler: Handler<[details: { error: string; peerId: string }]>): () => void {
        this.joinErrorHandlers.add(handler);
        return () => this.joinErrorHandlers.delete(handler);
    }

    startedMessages(peerId: string): unknown[] {
        return this.started.get(peerId) ?? [];
    }

    redirect(peerId: string, late: (message: unknown) => void): void {
        this.redirects.set(peerId, late);
    }

    stopRedirect(peerId: string): void {
        this.stoppedRedirects.push(peerId);
        this.redirects.delete(peerId);
    }

    inFlight(peerId: string): number {
        return this.inFlightCounts.get(peerId) ?? 0;
    }

    whenIdle(peerId: string, callback: () => void): () => void {
        if (this.inFlight(peerId) === 0) {
            callback();
            return () => undefined;
        }
        const waiters = this.idleWaiters.get(peerId) ?? new Set<() => void>();
        waiters.add(callback);
        this.idleWaiters.set(peerId, waiters);
        return () => waiters.delete(callback);
    }

    /** Nothing is in flight to the peer any more: the callbacks still held are called. */
    becomeIdle(peerId: string): void {
        this.inFlightCounts.set(peerId, 0);
        const waiters = [...(this.idleWaiters.get(peerId) ?? [])];
        this.idleWaiters.delete(peerId);
        for (const callback of waiters) callback();
    }

    takeUnsent(peerId: string): unknown[] {
        const taken = this.unsent.get(peerId) ?? [];
        this.unsent.delete(peerId);
        return taken;
    }

    async leave(): Promise<void> {
        this.left = true;
    }
}

/** The stub with its test-side surface (failNextSendOnce, emit*, sent, left). */
export { TransportStub };
