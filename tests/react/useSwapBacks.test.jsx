/**
 * Tests for useSwapBacks — reads the swap-back offers for a challenge and
 * refetches only when the challenge's entry ids change.
 */

import { render, screen, waitFor } from './helpers/test-utils';
import { useSwapBacks } from '@/api/useSwapBacks';

function Probe({ challenge }) {
    const items = useSwapBacks(challenge);
    return <div data-testid="count">{items.length}</div>;
}

const challengeWith = (ids) => ({ id: 9, member: { ranking: { entries: ids.map((id) => ({ id })) } } });

beforeEach(() => {
    window.api.getSwapBacks = jest
        .fn()
        .mockResolvedValue({ success: true, items: [{ currentId: 'b', previousId: 'a', kind: 'boost' }] });
});

test('returns the ledger items for the challenge', async () => {
    render(<Probe challenge={challengeWith(['b'])} />);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
    expect(window.api.getSwapBacks).toHaveBeenCalledWith('9');
});

test('refetches when the entries change, not on a same-slots re-render', async () => {
    const { rerender } = render(<Probe challenge={challengeWith(['b'])} />);
    await waitFor(() => expect(window.api.getSwapBacks).toHaveBeenCalledTimes(1));
    rerender(<Probe challenge={challengeWith(['b'])} />);
    rerender(<Probe challenge={challengeWith(['c'])} />);
    await waitFor(() => expect(window.api.getSwapBacks).toHaveBeenCalledTimes(2));
});

test('a failed read means no offers', async () => {
    window.api.getSwapBacks = jest.fn().mockResolvedValue({ success: false });
    render(<Probe challenge={challengeWith(['b'])} />);
    await waitFor(() => expect(window.api.getSwapBacks).toHaveBeenCalled());
    expect(screen.getByTestId('count').textContent).toBe('0');
});
