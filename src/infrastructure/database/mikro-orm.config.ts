import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import {
  InboxMessageEntitySchema,
  OutboxMessageEntitySchema,
  WagerTransactionEntitySchema,
  WalletEntitySchema,
  WalletLedgerEntryEntitySchema,
} from './entities/orm-entities';
import { Migration20261101000001_InitialWageringSchema } from './migrations/Migration20261101000001_InitialWageringSchema';

export function buildMikroOrmConfig() {
  return defineConfig({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    dbName: process.env.DB_NAME ?? 'jungle_wagering',
    user: process.env.DB_USER ?? 'jungle',
    password: process.env.DB_PASSWORD ?? 'jungle_secret',
    pool: {
      min: Number(process.env.DB_POOL_MIN ?? 2),
      max: Number(process.env.DB_POOL_MAX ?? 60),
    },
    entities: [
      WalletEntitySchema,
      WagerTransactionEntitySchema,
      WalletLedgerEntryEntitySchema,
      InboxMessageEntitySchema,
      OutboxMessageEntitySchema,
    ],
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      migrationsList: [
        {
          name: 'Migration20261101000001_InitialWageringSchema',
          class: Migration20261101000001_InitialWageringSchema,
        },
      ],
    },
    debug: false,
  });
}

export default buildMikroOrmConfig();
