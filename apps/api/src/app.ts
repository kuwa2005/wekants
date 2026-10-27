import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { eq, and, asc } from "drizzle-orm";
import {
  assertBoardAccess,
  hashPassword,
  moveCard,
  rebalanceRanks,
  validateTitle,
  verifyPassword,
} from "@wekants/wekan-core-node";
import {
  boardToMarkdown,
  markdownToBoardDraft,
  markdownToCardDraft,
  type BoardSnapshot,
  type Card,
  type List,
} from "@wekants/shared";
import type { AppDb } from "./db.ts";
import { boards, cards, lists, sessions, users, workspaces } from "./schema.ts";
import { broadcast } from "./hub.ts";

export type Env = {
  Variables: {
    db: AppDb;
    userId: string;
  };
};

const SESSION = "wekants_session";
const DAY = 1000 * 60 * 60 * 24 * 14;
const DEFAULT_LISTS = ["未着手", "着手中", "完了"];

function now(): number {
  return Date.now();
}

function id(): string {
  return crypto.randomUUID();
}

function mapWorkspace(row: typeof workspaces.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    rank: Number(row.rank),
    ownerId: row.ownerId,
  };
}

function mapBoard(row: typeof boards.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    archived: Boolean(row.archived),
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    rank: Number(row.rank),
  };
}

function mapList(row: typeof lists.$inferSelect): List {
  return {
    id: row.id,
    boardId: row.boardId,
    title: row.title,
    rank: Number(row.rank),
  };
}

function mapCard(row: typeof cards.$inferSelect): Card {
  return {
    id: row.id,
    boardId: row.boardId,
    listId: row.listId,
    title: row.title,
    description: row.description,
    rank: Number(row.rank),
  };
}

async function one<T>(rows: Promise<T[]>): Promise<T | undefined> {
  return (await rows)[0];
}

function placeRank(prev: number | null, next: number | null): { rank: number; needsRebalance: boolean } {
  return moveCard(prev, next);
}

export function createApp(db: AppDb): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  async function readSession(c: { req: { raw: Request } }): Promise<string | null> {
    const token = getCookie(c as never, SESSION);
    if (!token) {
      return null;
    }
    const session = await one(
      db.select().from(sessions).where(eq(sessions.id, token)).limit(1),
    );
    if (!session || session.expiresAt < now()) {
      if (session) {
        await db.delete(sessions).where(eq(sessions.id, token));
      }
      return null;
    }
    return session.userId;
  }

  async function attachUser(c: { set: (k: "userId", v: string) => void; req: { raw: Request } }): Promise<string> {
    const userId = await readSession(c);
    if (!userId) {
      throw new HTTPException(401, { message: "ログインが必要です" });
    }
    c.set("userId", userId);
    return userId;
  }

  async function issueSession(c: Parameters<typeof setCookie>[0], userId: string) {
    const sessionId = id();
    await db.insert(sessions).values({
      id: sessionId,
      userId,
      expiresAt: now() + DAY,
    });
    setCookie(c, SESSION, sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: DAY / 1000,
    });
  }

  app.post("/api/auth/register", async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>();
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      throw new HTTPException(400, {
        message: "ユーザー名は3〜32文字の英数字か _ です",
      });
    }
    if (password.length < 8) {
      throw new HTTPException(400, {
        message: "パスワードは8文字以上にしてください",
      });
    }
    const existing = await one(
      db.select().from(users).where(eq(users.username, username)).limit(1),
    );
    if (existing) {
      throw new HTTPException(409, { message: "そのユーザー名は使われています" });
    }
    const userId = id();
    await db.insert(users).values({
      id: userId,
      username,
      passwordHash: hashPassword(password),
      createdAt: now(),
    });
    await db.insert(workspaces).values({
      id: id(),
      ownerId: userId,
      title: "作業場",
      rank: 0,
      createdAt: now(),
    });
    await issueSession(c, userId);
    return c.json({ id: userId, username });
  });

  app.post("/api/auth/login", async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>();
    const user = await one(
      db.select().from(users).where(eq(users.username, (body.username ?? "").trim())).limit(1),
    );
    if (!user || !verifyPassword(body.password ?? "", user.passwordHash)) {
      throw new HTTPException(401, { message: "ユーザー名かパスワードが違います" });
    }
    await issueSession(c, user.id);
    return c.json({ id: user.id, username: user.username });
  });

  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, SESSION);
    if (token) {
      await db.delete(sessions).where(eq(sessions.id, token));
    }
    deleteCookie(c, SESSION, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => {
    const userId = await readSession(c);
    if (!userId) {
      throw new HTTPException(401, { message: "ログインが必要です" });
    }
    const user = await one(db.select().from(users).where(eq(users.id, userId)).limit(1));
    if (!user) {
      throw new HTTPException(401, { message: "ログインが必要です" });
    }
    return c.json({ id: user.id, username: user.username });
  });

  app.use("/api/workspaces", async (c, next) => {
    await attachUser(c);
    await next();
  });
  app.use("/api/workspaces/*", async (c, next) => {
    await attachUser(c);
    await next();
  });
  app.use("/api/boards", async (c, next) => {
    await attachUser(c);
    await next();
  });
  app.use("/api/boards/*", async (c, next) => {
    await attachUser(c);
    await next();
  });

  async function ownedWorkspace(userId: string, workspaceId: string) {
    const workspace = await one(
      db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
    );
    if (!workspace) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    try {
      assertBoardAccess(workspace.ownerId, userId);
    } catch {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    return workspace;
  }

  async function ownedBoard(userId: string, boardId: string) {
    const board = await one(db.select().from(boards).where(eq(boards.id, boardId)).limit(1));
    if (!board) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    try {
      assertBoardAccess(board.ownerId, userId);
    } catch {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    return board;
  }

  async function snapshot(boardId: string): Promise<BoardSnapshot> {
    const board = await one(db.select().from(boards).where(eq(boards.id, boardId)).limit(1));
    if (!board) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const boardLists = await db
      .select()
      .from(lists)
      .where(eq(lists.boardId, boardId))
      .orderBy(asc(lists.rank));
    const boardCards = await db
      .select()
      .from(cards)
      .where(eq(cards.boardId, boardId))
      .orderBy(asc(cards.rank));
    return {
      board: mapBoard(board),
      lists: boardLists.map(mapList),
      cards: boardCards.map(mapCard),
    };
  }

  async function seedLists(boardId: string, titles: string[]) {
    const ranks = rebalanceRanks(titles.length);
    for (const [index, title] of titles.entries()) {
      await db.insert(lists).values({
        id: id(),
        boardId,
        title,
        rank: ranks[index] ?? index * 1024,
        createdAt: now(),
      });
    }
  }

  async function appendRank(
    existingRanks: number[],
  ): Promise<number> {
    const last = existingRanks.at(-1) ?? null;
    const placed = placeRank(last, null);
    if (!placed.needsRebalance) {
      return placed.rank;
    }
    return (existingRanks.length) * 1024;
  }

  app.get("/api/workspaces", async (c) => {
    const userId = c.get("userId");
    const rows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId))
      .orderBy(asc(workspaces.rank));
    const boardRows = await db
      .select()
      .from(boards)
      .where(and(eq(boards.ownerId, userId), eq(boards.archived, false)))
      .orderBy(asc(boards.rank));
    return c.json({
      workspaces: rows.map((workspace) => ({
        ...mapWorkspace(workspace),
        boards: boardRows
          .filter((board) => board.workspaceId === workspace.id)
          .map(mapBoard),
      })),
    });
  });

  app.post("/api/workspaces", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ title?: string }>();
    try {
      validateTitle(body.title ?? "");
    } catch (err) {
      throw new HTTPException(400, { message: String(err) });
    }
    const existing = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId))
      .orderBy(asc(workspaces.rank));
    const rank = await appendRank(existing.map((row) => Number(row.rank)));
    if (placeRank(existing.at(-1)?.rank ?? null, null).needsRebalance) {
      const ranks = rebalanceRanks(existing.length + 1);
      for (const [index, row] of existing.entries()) {
        await db.update(workspaces).set({ rank: ranks[index] ?? 0 }).where(eq(workspaces.id, row.id));
      }
    }
    const workspaceId = id();
    await db.insert(workspaces).values({
      id: workspaceId,
      ownerId: userId,
      title: (body.title ?? "").trim(),
      rank,
      createdAt: now(),
    });
    const workspace = await one(
      db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
    );
    return c.json(mapWorkspace(workspace!), 201);
  });

  app.post("/api/boards", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ title?: string; workspaceId?: string; markdown?: string }>();
    const ownerSpaces = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId))
      .orderBy(asc(workspaces.rank));
    const workspaceId = body.workspaceId ?? ownerSpaces[0]?.id;
    if (!workspaceId) {
      throw new HTTPException(400, { message: "先にワークスペースを作ってください" });
    }
    await ownedWorkspace(userId, workspaceId);
    const draft = body.markdown
      ? markdownToBoardDraft(body.markdown, body.title ?? "Imported")
      : { title: body.title ?? "", lists: DEFAULT_LISTS.map((title) => ({ title, cards: [] })) };
    try {
      validateTitle(draft.title);
    } catch (err) {
      throw new HTTPException(400, { message: String(err) });
    }
    const siblings = await db
      .select()
      .from(boards)
      .where(eq(boards.workspaceId, workspaceId))
      .orderBy(asc(boards.rank));
    let rank = (await appendRank(siblings.map((row) => Number(row.rank))));
    const placed = placeRank(siblings.at(-1)?.rank ?? null, null);
    if (placed.needsRebalance) {
      const ranks = rebalanceRanks(siblings.length + 1);
      for (const [index, row] of siblings.entries()) {
        await db.update(boards).set({ rank: ranks[index] ?? 0 }).where(eq(boards.id, row.id));
      }
      rank = ranks[siblings.length] ?? siblings.length * 1024;
    } else {
      rank = placed.rank;
    }
    const boardId = id();
    await db.insert(boards).values({
      id: boardId,
      title: draft.title.trim(),
      archived: false,
      ownerId: userId,
      workspaceId,
      rank,
      createdAt: now(),
    });
    if (body.markdown) {
      const listRanks = rebalanceRanks(draft.lists.length);
      for (const [listIndex, listDraft] of draft.lists.entries()) {
        const listId = id();
        await db.insert(lists).values({
          id: listId,
          boardId,
          title: listDraft.title,
          rank: listRanks[listIndex] ?? listIndex * 1024,
          createdAt: now(),
        });
        const cardRanks = rebalanceRanks(listDraft.cards.length);
        for (const [cardIndex, cardDraft] of listDraft.cards.entries()) {
          await db.insert(cards).values({
            id: id(),
            boardId,
            listId,
            title: cardDraft.title,
            description: cardDraft.description,
            rank: cardRanks[cardIndex] ?? cardIndex * 1024,
            createdAt: now(),
          });
        }
      }
    } else {
      await seedLists(boardId, DEFAULT_LISTS);
    }
    return c.json(await snapshot(boardId), 201);
  });

  app.get("/api/boards/:boardId", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    await ownedBoard(userId, boardId);
    return c.json(await snapshot(boardId));
  });

  app.get("/api/boards/:boardId/markdown", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    await ownedBoard(userId, boardId);
    const md = boardToMarkdown(await snapshot(boardId));
    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${boardId}.md"`,
      },
    });
  });

  app.post("/api/boards/:boardId/move", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const board = await ownedBoard(userId, boardId);
    const body = await c.req.json<{
      workspaceId?: string;
      prevRank?: number | null;
      nextRank?: number | null;
    }>();
    const workspaceId = body.workspaceId ?? board.workspaceId;
    await ownedWorkspace(userId, workspaceId);
    const prevRank = body.prevRank ?? null;
    const nextRank = body.nextRank ?? null;
    const placed = placeRank(prevRank, nextRank);
    if (placed.needsRebalance) {
      const siblings = (
        await db
          .select()
          .from(boards)
          .where(eq(boards.workspaceId, workspaceId))
          .orderBy(asc(boards.rank))
      ).filter((row) => row.id !== boardId);
      const insertAt =
        prevRank == null ? 0 : siblings.findIndex((row) => Number(row.rank) === prevRank) + 1;
      const ordered = [
        ...siblings.slice(0, insertAt),
        { ...board, workspaceId },
        ...siblings.slice(insertAt),
      ];
      const ranks = rebalanceRanks(ordered.length);
      for (const [index, row] of ordered.entries()) {
        await db
          .update(boards)
          .set({ workspaceId, rank: ranks[index] ?? 0 })
          .where(eq(boards.id, row.id));
      }
    } else {
      await db
        .update(boards)
        .set({ workspaceId, rank: placed.rank })
        .where(eq(boards.id, boardId));
    }
    const updated = mapBoard(
      (await one(db.select().from(boards).where(eq(boards.id, boardId)).limit(1)))!,
    );
    broadcast(boardId, { type: "workspace.moved", payload: updated, actorId: userId });
    return c.json(updated);
  });

  app.post("/api/boards/:boardId/lists", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    await ownedBoard(userId, boardId);
    const body = await c.req.json<{ title?: string }>();
    try {
      validateTitle(body.title ?? "");
    } catch (err) {
      throw new HTTPException(400, { message: String(err) });
    }
    const existing = await db
      .select()
      .from(lists)
      .where(eq(lists.boardId, boardId))
      .orderBy(asc(lists.rank));
    const placed = placeRank(existing.at(-1)?.rank ?? null, null);
    let rank = placed.rank;
    if (placed.needsRebalance) {
      const ranks = rebalanceRanks(existing.length + 1);
      for (const [index, row] of existing.entries()) {
        await db.update(lists).set({ rank: ranks[index] ?? 0 }).where(eq(lists.id, row.id));
      }
      rank = ranks[existing.length] ?? existing.length * 1024;
    }
    const listId = id();
    await db.insert(lists).values({
      id: listId,
      boardId,
      title: (body.title ?? "").trim(),
      rank,
      createdAt: now(),
    });
    const list = mapList(
      (await one(db.select().from(lists).where(eq(lists.id, listId)).limit(1)))!,
    );
    broadcast(boardId, { type: "list.upserted", payload: list, actorId: userId });
    return c.json(list, 201);
  });

  app.post("/api/boards/:boardId/cards", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    await ownedBoard(userId, boardId);
    const body = await c.req.json<{
      listId?: string;
      title?: string;
      description?: string;
      markdown?: string;
      filename?: string;
    }>();
    const list = await one(
      db.select().from(lists).where(eq(lists.id, body.listId ?? "")).limit(1),
    );
    if (!list || list.boardId !== boardId) {
      throw new HTTPException(400, { message: "このボードのリストではありません" });
    }
    const draft = body.markdown
      ? markdownToCardDraft(
          body.markdown,
          (body.filename ?? "note.md").replace(/\.md$/i, ""),
        )
      : { title: body.title ?? "", description: body.description ?? "" };
    try {
      validateTitle(draft.title);
    } catch (err) {
      throw new HTTPException(400, { message: String(err) });
    }
    const existing = await db
      .select()
      .from(cards)
      .where(eq(cards.listId, list.id))
      .orderBy(asc(cards.rank));
    const placed = placeRank(existing.at(-1)?.rank ?? null, null);
    let rank = placed.rank;
    if (placed.needsRebalance) {
      const ranks = rebalanceRanks(existing.length + 1);
      for (const [index, row] of existing.entries()) {
        await db.update(cards).set({ rank: ranks[index] ?? 0 }).where(eq(cards.id, row.id));
      }
      rank = ranks[existing.length] ?? existing.length * 1024;
    }
    const cardId = id();
    await db.insert(cards).values({
      id: cardId,
      boardId,
      listId: list.id,
      title: draft.title.trim(),
      description: draft.description,
      rank,
      createdAt: now(),
    });
    const card = mapCard(
      (await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!,
    );
    broadcast(boardId, { type: "card.upserted", payload: card, actorId: userId });
    return c.json(card, 201);
  });

  app.patch("/api/boards/:boardId/cards/:cardId", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await ownedBoard(userId, boardId);
    const card = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!card || card.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const body = await c.req.json<{ title?: string; description?: string }>();
    const title = body.title ?? card.title;
    try {
      validateTitle(title);
    } catch (err) {
      throw new HTTPException(400, { message: String(err) });
    }
    await db
      .update(cards)
      .set({
        title: title.trim(),
        description: body.description ?? card.description,
      })
      .where(eq(cards.id, cardId));
    const updated = mapCard(
      (await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!,
    );
    broadcast(boardId, { type: "card.upserted", payload: updated, actorId: userId });
    return c.json(updated);
  });

  app.post("/api/boards/:boardId/cards/:cardId/move", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await ownedBoard(userId, boardId);
    const card = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!card || card.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const body = await c.req.json<{
      listId?: string;
      prevRank?: number | null;
      nextRank?: number | null;
    }>();
    const list = await one(
      db.select().from(lists).where(eq(lists.id, body.listId ?? "")).limit(1),
    );
    if (!list || list.boardId !== boardId) {
      throw new HTTPException(400, { message: "このボードのリストではありません" });
    }
    const prevRank = body.prevRank ?? null;
    const nextRank = body.nextRank ?? null;
    const placed = placeRank(prevRank, nextRank);
    if (placed.needsRebalance) {
      const siblings = (
        await db.select().from(cards).where(eq(cards.listId, list.id)).orderBy(asc(cards.rank))
      ).filter((row) => row.id !== cardId);
      const insertAt =
        prevRank == null ? 0 : siblings.findIndex((row) => Number(row.rank) === prevRank) + 1;
      const ordered = [
        ...siblings.slice(0, insertAt),
        { ...card, listId: list.id },
        ...siblings.slice(insertAt),
      ];
      const ranks = rebalanceRanks(ordered.length);
      for (const [index, row] of ordered.entries()) {
        await db
          .update(cards)
          .set({ listId: list.id, rank: ranks[index] ?? 0 })
          .where(eq(cards.id, row.id));
      }
    } else {
      await db
        .update(cards)
        .set({ listId: list.id, rank: placed.rank })
        .where(eq(cards.id, cardId));
    }
    const updated = mapCard(
      (await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!,
    );
    broadcast(boardId, { type: "card.moved", payload: updated, actorId: userId });
    return c.json(updated);
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error(err);
    return c.json({ error: "内部エラー" }, 500);
  });

  return app;
}
