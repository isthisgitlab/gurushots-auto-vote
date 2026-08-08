/**
 * useAuth — the two-channel error model introduced when authenticate moved
 * onto the shared useAsyncIpcAction envelope. authError (from the envelope)
 * and flowError (login/logout transitions) merge as `authError ?? flowError`,
 * with explicit cross-channel clears at each transition so a stale value
 * from one channel can never shadow the other. These tests pin exactly that
 * contract, which previously had no coverage at all.
 */

import { render, act } from '@testing-library/preact';
import { useAuth } from '@/api/useAuth';
import { mockApi } from '../../src/js/react/test/setup';

describe('useAuth error channels', () => {
    let hook;

    function Capture() {
        hook = useAuth();
        return null;
    }

    beforeEach(() => {
        window.api = mockApi;
        jest.clearAllMocks();
        render(<Capture />);
    });

    it('starts with no error and not loading', () => {
        expect(hook.error).toBeNull();
        expect(hook.loading).toBe(false);
    });

    it('authenticate failure surfaces the auth-channel error', async () => {
        window.api.authenticate.mockResolvedValue({ success: false, error: 'bad credentials' });
        await act(async () => {
            await hook.authenticate('user', 'pw');
        });
        expect(hook.error).toBe('bad credentials');
    });

    it('authenticate rejection falls back to the generic auth message', async () => {
        window.api.authenticate.mockRejectedValue(new Error('boom'));
        await act(async () => {
            await hook.authenticate('user', 'pw');
        });
        expect(hook.error).toBe('boom');
    });

    it('login failure after a successful authenticate surfaces the flow error', async () => {
        window.api.authenticate.mockResolvedValue({ success: true, token: 't' });
        window.api.login.mockRejectedValue(new Error('window transition died'));
        await act(async () => {
            await hook.authenticate('user', 'pw');
            await hook.login();
        });
        expect(hook.error).toBe('window transition died');
    });

    it('a flow error is not shadowed by a stale auth error (auth channel cleared first)', async () => {
        window.api.authenticate.mockResolvedValue({ success: false, error: 'bad credentials' });
        await act(async () => {
            await hook.authenticate('user', 'pw');
        });
        expect(hook.error).toBe('bad credentials');

        window.api.logout.mockRejectedValue(new Error('logout died'));
        await act(async () => {
            await hook.logout();
        });
        // The transition clears the auth channel so the newer flow error wins.
        expect(hook.error).toBe('logout died');
    });

    it('a new authenticate clears a previous flow error', async () => {
        window.api.login.mockRejectedValue(new Error('transition died'));
        await act(async () => {
            await hook.login();
        });
        expect(hook.error).toBe('transition died');

        window.api.authenticate.mockResolvedValue({ success: true, token: 't' });
        await act(async () => {
            await hook.authenticate('user', 'pw');
        });
        expect(hook.error).toBeNull();
    });

    it('clearError resets both channels', async () => {
        window.api.authenticate.mockResolvedValue({ success: false, error: 'bad credentials' });
        window.api.login.mockRejectedValue(new Error('transition died'));
        await act(async () => {
            await hook.authenticate('user', 'pw');
        });
        await act(async () => {
            hook.clearError();
        });
        expect(hook.error).toBeNull();

        await act(async () => {
            await hook.login();
        });
        await act(async () => {
            hook.clearError();
        });
        expect(hook.error).toBeNull();
    });
});
