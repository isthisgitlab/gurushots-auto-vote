/**
 * An in-memory RemoteTransport for the remote-access tests: two ends joined
 * directly, no WebRTC. `pair()` returns the two ends; every send on one is
 * delivered to the other's message listeners. Each end also exposes its
 * listener sets, so a test can fire the transport's own events (peer joins,
 * leaves, join errors) and simulate a lost connection.
 */

import type { RemoteTransport } from '../../src/ts/core/remote/relays';

type Handler<T extends unknown[]> = (...args: T) => void;

class TransportStub implements RemoteTransport {
    readonly peerId: string;
    sent: Array<{ message: unknown; target?: string }> = [];
    left = false;
    private other: TransportStub | null = null;
    private failNextSend = false;
    private readonly messageHandlers = new Set<Handler<[peerId: string, message: unknown]>>();
    private readonly joinHandlers = new Set<Handler<[peerId: string]>>();
    private readonly leaveHandlers = new Set<Handler<[peerId: string]>>();
    private readonly joinErrorHandlers = new Set<Handler<[details: { error: string }]>>();

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

    emitLeave(peerId: string): void {
        for (const handler of this.leaveHandlers) handler(peerId);
    }

    emitJoinError(error: string): void {
        for (const handler of this.joinErrorHandlers) handler({ error });
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

    onPeerLeave(handler: Handler<[peerId: string]>): () => void {
        this.leaveHandlers.add(handler);
        return () => this.leaveHandlers.delete(handler);
    }

    onJoinError(handler: Handler<[details: { error: string }]>): () => void {
        this.joinErrorHandlers.add(handler);
        return () => this.joinErrorHandlers.delete(handler);
    }

    async leave(): Promise<void> {
        this.left = true;
    }
}

/** The stub with its test-side surface (failNextSendOnce, emit*, sent, left). */
export { TransportStub };
