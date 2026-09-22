/**
 * Tests for CurrencyConfirmModal's balance line and outcome mapping.
 */

import { render, screen } from './helpers/test-utils';
import { CurrencyConfirmModal, currencyOutcomeText } from '@/components/app/CurrencyConfirmModal';

const STRINGS = {
    'app.currencyBalance': '{current} {currency} -> {resulting}',
    'app.currencyBalanceUnknown': 'unknown {currency}',
    'app.bankrollFills': 'fills',
};

beforeEach(() => {
    window.translationManager.t.mockImplementation((key) => STRINGS[key] ?? key);
});

afterEach(() => {
    window.translationManager.t.mockImplementation((key) => key);
});

const renderModal = (bankroll) =>
    render(
        <CurrencyConfirmModal
            isOpen
            onClose={jest.fn()}
            onConfirm={jest.fn()}
            title="Spend"
            field="fills"
            bankroll={bankroll}
            spending={false}
        >
            body
        </CurrencyConfirmModal>,
    );

test('a known balance shows current -> resulting, floored at zero', () => {
    renderModal({ fills: 0 });
    expect(screen.getByText('0 fills -> 0')).toBeTruthy();
});

test('a missing bankroll reads as an unknown balance', () => {
    renderModal(null);
    expect(screen.getByText('unknown fills')).toBeTruthy();
});

test('unmapped outcomes fall back to the generic failure message', () => {
    const t = (key) => key;
    expect(currencyOutcomeText(t, 'busy')).toBe('app.currencyOutcomeBusy');
    expect(currencyOutcomeText(t, 'HTTP 500')).toBe('app.currencyOutcomeFailed');
    expect(currencyOutcomeText(t, null)).toBe('app.currencyOutcomeFailed');
});
