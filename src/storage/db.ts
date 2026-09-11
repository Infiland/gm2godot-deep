import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Database = DatabaseSync;

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
];

/** Open (creating if needed) the workspace state database and bring its schema up to date. */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  for (const pragma of PRAGMAS) db.exec(pragma);
  migrate(db);
  return db;
}

export function schemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get();
  if (row === undefined) return 0;
  const value = row["user_version"];
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Apply every migration newer than `user_version`, each in its own transaction. */
export function migrate(db: Database, migrations = MIGRATIONS): void {
  let current = schemaVersion(db);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    current = migration.version;
  }
}

/** Run `body` inside one transaction; SQLite errors roll the whole thing back. */
export function transact<T>(db: Database, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = body();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}


