import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { planBoardKeys } from "@wekants/shared";
import * as schema from "./schema.ts";
import { boards, cards } from "./schema.ts";

export type AppDb = PostgresJsDatabase<typeof schema>;

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  home_board_id TEXT,
  created_at BIGINT NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_board_id TEXT;
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
  workspace_id TEXT,
  rank BIGINT NOT NULL,
  is_template BOOLEAN NOT NULL DEFAULT FALSE,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  key TEXT NOT NULL DEFAULT '',
  card_seq INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS key TEXT NOT NULL DEFAULT '';
ALTER TABLE boards ADD COLUMN IF NOT EXISTS card_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE boards ALTER COLUMN workspace_id DROP NOT NULL;
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
  archived_with_list BOOLEAN NOT NULL DEFAULT FALSE,
  number INTEGER NOT NULL DEFAULT 0,
  vote_question TEXT NOT NULL DEFAULT '',
  vote_public BOOLEAN NOT NULL DEFAULT TRUE,
  rank BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS archived_with_list BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS vote_question TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS vote_public BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS card_ballots (
  card_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  choice TEXT NOT NULL,
  PRIMARY KEY (card_id, user_id)
);
CREATE TABLE IF NOT EXISTS wip_groups (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  limit_count INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS wip_group_lists (
  group_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  PRIMARY KEY (group_id, list_id)
);
CREATE TABLE IF NOT EXISTS card_unsaved (
  user_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, card_id)
);
CREATE TABLE IF NOT EXISTS card_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
`;

export async function openDatabase(url: string): Promise<{ db: AppDb; sql: postgres.Sql }> {
  const sql = postgres(url, { max: 8, onnotice: () => {} });
  await sql.unsafe(DDL);
  const db = drizzle(sql, { schema });
  await assignMissingBoardKeys(db);
  return { db, sql };
}

async function assignMissingBoardKeys(db: AppDb): Promise<void> {
  const missing = await db.select().from(boards).where(eq(boards.key, ""));
  if (missing.length > 0) {
    const used = await db.select({ key: boards.key }).from(boards);
    const taken = new Set(used.map((row) => row.key).filter((key) => key.length > 0));
    for (const item of planBoardKeys(
      missing.map((row) => ({ id: row.id, title: row.title })),
      taken,
    )) {
      await db.update(boards).set({ key: item.key }).where(eq(boards.id, item.id));
    }
  }
  const rows = await db.select().from(cards).orderBy(asc(cards.createdAt));
  const byBoard = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byBoard.get(row.boardId) ?? [];
    list.push(row);
    byBoard.set(row.boardId, list);
  }
  for (const [boardId, list] of byBoard) {
    let seq = 0;
    for (const card of list) {
      if (card.number > seq) {
        seq = card.number;
      }
    }
    let changed = false;
    for (const card of list) {
      if (card.number > 0) {
        continue;
      }
      seq += 1;
      changed = true;
      await db.update(cards).set({ number: seq }).where(eq(cards.id, card.id));
    }
    if (changed) {
      await db
        .update(boards)
        .set({ cardSeq: seq })
        .where(and(eq(boards.id, boardId), sql`${boards.cardSeq} < ${seq}`));
    }
  }
}
