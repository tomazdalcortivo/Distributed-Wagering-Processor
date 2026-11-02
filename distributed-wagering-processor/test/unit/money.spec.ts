import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../src/domain/shared/domain-errors';
import { Money } from '../../src/domain/value-objects/money';

describe('Money Value Object (Section 6.1)', () => {
  it('creates Money from valid 2-decimal string and serializes back to exact JSON', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.amount).toBe('25.00');
    expect(money.currency).toBe('BRL');
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(money.toString()).toBe('25.00 BRL');
    expect(money.isPositive()).toBe(true);
    expect(money.isZero()).toBe(false);
    expect(money.isNegative()).toBe(false);
  });

  it('creates zero Money via Money.zero', () => {
    const zero = Money.zero('BRL');
    expect(zero.amount).toBe('0.00');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  it('performs exact fixed-point addition, subtraction, negation, and comparisons without float drift', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    const sum = a.add(b);
    expect(sum.amount).toBe('0.30');

    const diff = sum.subtract(a);
    expect(diff.equals(b)).toBe(true);
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);

    const negated = a.negate();
    expect(negated.amount).toBe('-0.10');
    expect(negated.isNegative()).toBe(true);
  });

  it('rejects operations between different currencies with CurrencyMismatchError', () => {
    const brl = Money.from({ amount: '50.00', currency: 'BRL' });
    const usd = Money.from({ amount: '50.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });

  it('rejects invalid amounts: NaN, Infinity, scientific notation, empty, >2 decimals, <2 decimals, negative in input contract', () => {
    const invalidAmounts = [
      '',
      'NaN',
      'Infinity',
      '-Infinity',
      '1e2',
      '25.00e0',
      '25',
      '25.0',
      '25.000',
      '25.123',
      '-10.00',
      '-0.01',
      '-0.00',
      ' 25.00',
      '25.00 ',
      'abc',
    ];

    for (const invalid of invalidAmounts) {
      expect(() => Money.from({ amount: invalid, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects invalid ISO-4217 currency codes', () => {
    for (const badCurrency of ['', 'brl', 'BR', 'BRLX', '123']) {
      expect(() => Money.from({ amount: '10.00', currency: badCurrency })).toThrow(
        InvalidMoneyError,
      );
    }
  });
});
