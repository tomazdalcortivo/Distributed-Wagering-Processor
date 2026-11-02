import { Platform, Type } from '@mikro-orm/core';
import { Decimal } from '../../../domain/shared/decimal';

/**
 * Custom MikroORM Type that maps PostgreSQL `NUMERIC(20, 2)` strictly to a canonical
 * 2-decimal string (e.g. "25.00") without ever coercing through JavaScript `number` / float.
 */
export class DecimalStringType extends Type<string, string> {
  override convertToDatabaseValue(value: string, _platform: Platform): string {
    if (value === null || value === undefined) {
      return value;
    }
    return Decimal.fromStrictString(String(value), false).toFixed();
  }

  override convertToJSValue(value: string, _platform: Platform): string {
    if (value === null || value === undefined) {
      return value;
    }
    return Decimal.fromStrictString(String(value), false).toFixed();
  }

  override getColumnType(): string {
    return 'numeric(20, 2)';
  }
}
