/**
 * Pure, immutable, fixed-scale Decimal representation backed by native BigInt minor units.
 *
 * Guarantees:
 * - Zero usage of JavaScript `number`, `float`, or IEEE-754 floating point arithmetic.
 * - Strict validation of string representations: rejects NaN, Infinity, scientific notation (e/E),
 *   whitespace padding, empty strings, or > 2 decimal places.
 * - All arithmetic operations (`add`, `subtract`, `negate`, comparisons) operate on exact BigInt minor units (scale = 2).
 */
export class Decimal {
  private static readonly SCALE = 2;
  private static readonly SCALE_FACTOR = 100n;
  private static readonly STRICT_DECIMAL_REGEX = /^-?\d+(\.\d{1,2})?$/;
  private static readonly EXACT_TWO_DECIMAL_REGEX = /^-?\d+\.\d{2}$/;

  private constructor(private readonly minorUnits: bigint) {}

  /**
   * Parses a decimal string with exact scale of 2 decimal places (e.g. "25.00").
   * By default requires exact 2 decimal digits as specified in Section 6.1.
   */
  static fromStrictString(raw: string, requireExactTwoDecimals = true): Decimal {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error('Invalid decimal: value must be a non-empty string');
    }

    if (raw.trim() !== raw) {
      throw new Error(`Invalid decimal "${raw}": leading or trailing whitespace is not allowed`);
    }

    const pattern = requireExactTwoDecimals
      ? Decimal.EXACT_TWO_DECIMAL_REGEX
      : Decimal.STRICT_DECIMAL_REGEX;

    if (!pattern.test(raw)) {
      throw new Error(
        `Invalid decimal "${raw}": must be a fixed-point string with 2 decimal places (e.g. "25.00") without scientific notation`,
      );
    }

    const isNegative = raw.startsWith('-');
    const unsigned = isNegative ? raw.slice(1) : raw;
    const parts = unsigned.split('.');
    const wholePart = parts[0] ?? '0';
    const fracPart = (parts[1] ?? '').padEnd(Decimal.SCALE, '0');

    // Reject negative zero "-0.00" in input contracts
    const totalMinor = BigInt(wholePart) * Decimal.SCALE_FACTOR + BigInt(fracPart);
    if (isNegative && totalMinor === 0n) {
      throw new Error('Invalid decimal "-0.00": negative zero is not allowed');
    }

    return new Decimal(isNegative ? -totalMinor : totalMinor);
  }

  static fromMinorUnits(minorUnits: bigint): Decimal {
    return new Decimal(minorUnits);
  }

  static zero(): Decimal {
    return new Decimal(0n);
  }

  add(other: Decimal): Decimal {
    return new Decimal(this.minorUnits + other.minorUnits);
  }

  subtract(other: Decimal): Decimal {
    return new Decimal(this.minorUnits - other.minorUnits);
  }

  negate(): Decimal {
    return new Decimal(-this.minorUnits);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Decimal): boolean {
    return this.minorUnits < other.minorUnits;
  }

  isGreaterThan(other: Decimal): boolean {
    return this.minorUnits > other.minorUnits;
  }

  equals(other: Decimal): boolean {
    return this.minorUnits === other.minorUnits;
  }

  toMinorUnits(): bigint {
    return this.minorUnits;
  }

  /**
   * Formats back to canonical fixed 2-decimal string (e.g., "25.00", "0.05", "-10.50").
   */
  toFixed(): string {
    const isNegative = this.minorUnits < 0n;
    const absMinor = isNegative ? -this.minorUnits : this.minorUnits;
    const whole = absMinor / Decimal.SCALE_FACTOR;
    const fraction = absMinor % Decimal.SCALE_FACTOR;
    const fractionStr = fraction.toString().padStart(Decimal.SCALE, '0');
    return `${isNegative ? '-' : ''}${whole.toString()}.${fractionStr}`;
  }

  toString(): string {
    return this.toFixed();
  }
}
