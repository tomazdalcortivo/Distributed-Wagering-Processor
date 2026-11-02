import { Decimal } from '../shared/decimal';
import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain-errors';

export interface MoneyProps {
  amount: string; // decimal string, e.g., "25.00"
  currency: string; // ISO-4217 3-letter uppercase code, e.g., "BRL"
}

/**
 * Immutable Value Object representing monetary amounts with exact fixed-point precision (scale = 2).
 *
 * Enforces Section 6.1 invariants:
 * - Never uses JS number/float/double internally.
 * - Rejects NaN, Infinity, scientific notation, empty strings, >2 decimal places, and negative amounts in input contracts.
 * - Enforces ISO-4217 currency format and asserts identical currencies on every arithmetic/comparison operation.
 */
export class Money {
  private static readonly ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Factory for input contracts: validates fixed 2-decimal string and rejects negative values.
   */
  static from(props: MoneyProps): Money {
    if (!props || typeof props !== 'object') {
      throw new InvalidMoneyError('Money props must be a valid object with amount and currency');
    }

    Money.validateCurrency(props.currency);

    let decimalValue: Decimal;
    try {
      decimalValue = Decimal.fromStrictString(props.amount, true);
    } catch (err) {
      throw new InvalidMoneyError(
        err instanceof Error ? err.message : `Invalid money amount: "${String(props.amount)}"`,
      );
    }

    if (decimalValue.isNegative()) {
      throw new InvalidMoneyError(
        `Money amount in input contract cannot be negative: received "${props.amount}"`,
      );
    }

    return new Money(decimalValue, props.currency);
  }

  /**
   * Rehydration factory from persistence or internal signed arithmetic.
   */
  static rehydrate(props: MoneyProps): Money {
    Money.validateCurrency(props.currency);
    let decimalValue: Decimal;
    try {
      decimalValue = Decimal.fromStrictString(props.amount, true);
    } catch (err) {
      throw new InvalidMoneyError(
        err instanceof Error ? err.message : `Invalid persisted money amount: "${String(props.amount)}"`,
      );
    }
    return new Money(decimalValue, props.currency);
  }

  static zero(currency: string): Money {
    Money.validateCurrency(currency);
    return new Money(Decimal.zero(), currency);
  }

  private static validateCurrency(currency: string): void {
    if (typeof currency !== 'string' || !Money.ISO_CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(
        `Invalid currency "${String(currency)}": must be a 3-letter uppercase ISO-4217 code (e.g. "BRL")`,
      );
    }
  }

  get amount(): string {
    return this.value.toFixed();
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.subtract(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negate(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.isLessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.isGreaterThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!other || this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other?.currency ?? 'UNDEFINED');
    }
  }
}
