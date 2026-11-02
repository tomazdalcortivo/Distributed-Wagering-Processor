import { MikroORM } from '@mikro-orm/postgresql';
import { buildMikroOrmConfig } from '../mikro-orm.config';

async function runMigrations(): Promise<void> {
  const direction = process.argv[2] ?? 'up';
  const orm = await MikroORM.init(buildMikroOrmConfig());

  try {
    const migrator = orm.getMigrator();
    if (direction === 'down') {
      console.log('Reverting last database migration (down)...');
      await migrator.down();
      console.log('Migration reverted.');
    } else {
      console.log('Applying pending database migrations (up)...');
      await migrator.up();
      console.log('Migrations applied.');
    }
  } finally {
    await orm.close(true);
  }
}

runMigrations().catch((err) => {
  console.error('Migration execution failed:', err);
  process.exit(1);
});
