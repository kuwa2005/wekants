import { bigint, boolean, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  homeBoardId: text("home_board_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  rank: bigint("rank", { mode: "number" }).notNull(),
  starred: boolean("starred").notNull().default(false),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const boards = pgTable("boards", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  archived: boolean("archived").notNull().default(false),
  ownerId: text("owner_id").notNull(),
  workspaceId: text("workspace_id"),
  rank: bigint("rank", { mode: "number" }).notNull(),
  isTemplate: boolean("is_template").notNull().default(false),
  isPublic: boolean("is_public").notNull().default(false),
  key: text("key").notNull().default(""),
  cardSeq: integer("card_seq").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const lists = pgTable("lists", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull(),
  title: text("title").notNull(),
  rank: bigint("rank", { mode: "number" }).notNull(),
  collapsed: boolean("collapsed").notNull().default(false),
  width: text("width").notNull().default("normal"),
  wipLimit: integer("wip_limit"),
  archived: boolean("archived").notNull().default(false),
  color: text("color").notNull().default(""),
  cardEdit: text("card_edit").notNull().default("allow"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const cardUnsaved = pgTable("card_unsaved", {
  userId: text("user_id").notNull(),
  cardId: text("card_id").notNull(),
  boardId: text("board_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const cardTemplates = pgTable("card_templates", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const cards = pgTable("cards", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull(),
  listId: text("list_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  archived: boolean("archived").notNull().default(false),
  archivedWithList: boolean("archived_with_list").notNull().default(false),
  number: integer("number").notNull().default(0),
  voteQuestion: text("vote_question").notNull().default(""),
  votePublic: boolean("vote_public").notNull().default(true),
  rank: bigint("rank", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const wipGroups = pgTable("wip_groups", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull(),
  title: text("title").notNull().default(""),
  limit: integer("limit_count").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const wipGroupLists = pgTable(
  "wip_group_lists",
  {
    groupId: text("group_id").notNull(),
    listId: text("list_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.listId] })],
);

export const cardBallots = pgTable(
  "card_ballots",
  {
    cardId: text("card_id").notNull(),
    userId: text("user_id").notNull(),
    choice: text("choice").notNull(),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.userId] })],
);
