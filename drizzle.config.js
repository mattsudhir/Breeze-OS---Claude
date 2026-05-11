// drizzle-kit config — powers the db:generate / db:migrate / db:studio
// npm scripts. All migrations are written to lib/db/migrations and
// committed to git so production deploys apply a reviewed, deterministic
// schema rather than whatever `db:push` decides to do.

import 'dotenv/config';

export default {
  schema: './lib/db/schema/index.js',
  out: './lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      '',
  },
  verbose: true,
  strict: true,
};
