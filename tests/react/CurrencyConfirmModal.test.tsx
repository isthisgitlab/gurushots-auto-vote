/**
 * Tests for CurrencyConfirmModal's balance line and outcome mapping.
 */

import { render, screen, fireEvent } from './helpers/test-utils';
import { CurrencyConfirmModal, currencyOutcomeText } from '@/components/app/CurrencyConfirmModal';
import { mockTranslator, fillTemplate } from './helpers/setup';
import type { Bankroll } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const STRINGS: Record<string, string> = {
    'app.currencyBalance': '{current} {currency} -> {resulting}',
    'app.currencyBalanceUnknown': 'unknown {currency}',
    'app.bankrollFills': 'fills',
};

beforeEach(() => {
    mockTranslator.t.mockImplementation((key, vars) => fillTemplate(STRINGS[key] ?? key, vars));
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

const renderModal = (bankroll: Bankroll | null) =>
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

test('spendHeld disables Spend and leaves Cancel enabled', () => {
    const onConfirm = jest.fn();
    render(
        <CurrencyConfirmModal
            isOpen
            onClose={jest.fn()}
            onConfirm={onConfirm}
            title="Spend"
            field="fills"
            bankroll={null}
            spending={false}
            spendHeld
        >
            body
        </CurrencyConfirmModal>,
    );
    const spend = screen.getByText('app.currencySpend').closest('button') as HTMLButtonElement;
    expect(spend.disabled).toBe(true);
    fireEvent.click(spend);
    expect(onConfirm).not.toHaveBeenCalled();
    expect((screen.getByText('app.cancel').closest('button') as HTMLButtonElement).disabled).toBe(false);
});

test('a known balance shows current -> resulting, floored at zero', () => {
    renderModal(invalid({ fills: 0 }));
    expect(screen.getByText('0 fills -> 0')).toBeTruthy();
});

test('a missing bankroll reads as an unknown balance', () => {
    renderModal(null);
    expect(screen.getByText('unknown fills')).toBeTruthy();
});

test('unmapped outcomes fall back to the generic failure message', () => {
    const t = (key: string) => key;
    expect(currencyOutcomeText(t, 'busy')).toBe('app.currencyOutcomeBusy');
    expect(currencyOutcomeText(t, 'unclear')).toBe('app.currencyOutcomeUnclear');
    expect(currencyOutcomeText(t, 'data-incomplete')).toBe('app.currencyOutcomeDataIncomplete');
    expect(currencyOutcomeText(t, 'HTTP 500')).toBe('app.currencyOutcomeFailed');
    expect(currencyOutcomeText(t, invalid(null))).toBe('app.currencyOutcomeFailed');
});
