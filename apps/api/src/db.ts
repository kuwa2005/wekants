import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type AppDb = PostgresJsDatabase<typeof schema>;

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  rank BIGINT NOT NULL,
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  rank BIGINT NOT NULL,
  is_template BOOLEAN NOT NULL DEFAULT FALSE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  title TEXT NOT NULL,
  rank BIGINT NOT NULL,
  collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  width TEXT NOT NULL DEFAULT 'normal',
  wip_limit INTEGER,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  color TEXT NOT NULL DEFAULT '',
  card_edit TEXT NOT NULL DEFAULT 'allow',
  created_at BIGINT NOT NULL
);
ALTER TABLE lists ADD COLUMN IF NOT EXISTS collapsed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lists ADD COLUMN IF NOT EXISTS width TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE lists ADD COLUMN IF NOT EXISTS wip_limit INTEGER;
ALTER TABLE lists ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lists ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '';
ALTER TABLE lists ADD COLUMN IF NOT EXISTS card_edit TEXT NOT NULL DEFAULT 'allow';
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  rank BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
`;

export async function openDatabase(url: string): Promise<{ db: AppDb; sql: postgres.Sql }> {
  const sql = postgres(url, { max: 8, onnotice: () => {} });
  await sql.unsafe(DDL);
  const db = drizzle(sql, { schema });
  return { db, sql };
}
