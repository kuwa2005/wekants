import { bigint, boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

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
  rank: bigint("rank", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
