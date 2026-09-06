/**
 * The only place that opens the database. Everything else imports `getDb()`
 * (or `createDb()` for tests) from here. Migrations from ./drizzle are
 * applied on open, so `npm run dev` works from a fresh clone.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;
/** The handle passed to a db.transaction() callback. */
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either the database or an open transaction; both expose the same query API. */
export type DbOrTx = Db | DbTransaction;

export const DEFAULT_DATABASE_PATH = "data/vendor-sourcing.db";

export function createDb(file: string): Db {
  const resolved =
    file === ":memory:" ? file : path.resolve(process.cwd(), file);
  if (resolved !== ":memory:") {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const sqlite = new Database(resolved);
  if (resolved !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  return db;
}

declare global {
  var __vendorSourcingDb: Db | undefined;
}

/** Process-wide singleton; survives Next.js dev-server module reloads. */
export function getDb(): Db {
  if (!globalThis.__vendorSourcingDb) {
    globalThis.__vendorSourcingDb = createDb(
      process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH,
    );
  }
  return globalThis.__vendorSourcingDb;
}

export const nowIso = () => new Date().toISOString();

export * from "./schema";
