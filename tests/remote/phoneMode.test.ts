/**
 * The entries the Android remote mode's shells install for the React app: nothing is installed
 * until a shell does, and the later install replaces the earlier (each document installs its own).
 */

describe('phoneRemoteMode', () => {
    test('is null until a shell installs an entry, then answers what was installed', () => {
        jest.isolateModules(() => {
            const mode =
                require('../../src/ts/core/remote/phoneMode') as typeof import('../../src/ts/core/remote/phoneMode');
            expect(mode.phoneRemoteMode()).toBeNull();
            const disconnect = jest.fn().mockResolvedValue(undefined);
            mode.installPhoneRemoteMode({ disconnect });
            expect(mode.phoneRemoteMode()).toEqual({ disconnect });
        });
    });
});
