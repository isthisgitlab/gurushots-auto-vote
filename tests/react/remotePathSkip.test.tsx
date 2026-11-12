/** A modern mismatched page returns the peer's checked version to the root loader. */

import { installPeerBridge } from '../../src/ts/shells/remote/bridge/peer';
import { TransportStub } from '../helpers/remoteTransport';
import { APP_VERSION, PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';

describe('a versioned remote page mismatch', () => {
    test('redirects with the desktop version as an explicit fragment hint', () => {
        const transport = new TransportStub('phone');
        const replace = jest.spyOn(window.location, 'replace').mockImplementation(() => undefined);
        try {
            installPeerBridge(transport, 'https://site.test/remote/index.html#k=the-key&v=2');
            transport.receiveFromPeer(
                { t: 'hello', version: APP_VERSION, protocolVersion: PROTOCOL_VERSION, host: true, linkVersion: 1 },
                'host',
            );
            expect(replace).toHaveBeenCalledWith('https://site.test/remote/index.html#k=the-key&v=1');
        } finally {
            replace.mockRestore();
        }
    });
});
