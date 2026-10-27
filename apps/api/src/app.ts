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
    starred: Boolean(row.starred),
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
    isTemplate: Boolean(row.isTemplate),
    isPublic: Boolean(row.isPublic),
  };
}

function mapList(row: typeof lists.$inferSelect): List {
  return {
    id: row.id,
    boardId: row.boardId,
    title: row.title,
    rank: Number(row.rank),
    collapsed: row.collapsed,
    width: row.width === "narrow" || row.width === "wide" ? row.width : "normal",
    wipLimit: row.wipLimit,
    archived: row.archived,
    color: row.color === "rust" || row.color === "moss" || row.color === "rivet" ? row.color : "",
    cardEdit: row.cardEdit === "deny" ? "deny" : "allow",
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
    archived: Boolean(row.archived),
  };
}

async function one<T>(rows: Promise<T[]>): Promise<T | undefined> {
  return (await rows)[0];
}

function placeRank(prev: number | null, next: number | null): { rank: number; needsRebalance: boolean } {
  return moveCard(prev, next);
}

function copyTitle(source: string): string {
  return [...`${source} の複製`].slice(0, 200).join("");
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

  app.post("/api/auth/password", async (c) => {
    const userId = await attachUser(c);
    const body = await c.req.json<{ currentPassword?: string; nextPassword?: string }>();
    const user = await one(db.select().from(users).where(eq(users.id, userId)).limit(1));
    if (!user || !verifyPassword(body.currentPassword ?? "", user.passwordHash)) {
      throw new HTTPException(400, { message: "今のパスワードが違います" });
    }
    const nextPassword = body.nextPassword ?? "";
    if (nextPassword.length < 8) {
      throw new HTTPException(400, { message: "パスワードは8文字以上にしてください" });
    }
    await db.update(users).set({ passwordHash: hashPassword(nextPassword) }).where(eq(users.id, userId));
    return c.json({ ok: true });
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

  async function visibleBoard(userId: string, boardId: string) {
    const board = await one(db.select().from(boards).where(eq(boards.id, boardId)).limit(1));
    if (!board || (board.ownerId !== userId && !board.isPublic)) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    return board;
  }

  async function assertListAcceptsCard(listId: string, adding: boolean) {
    const list = await one(db.select().from(lists).where(eq(lists.id, listId)).limit(1));
    if (!list) {
      throw new HTTPException(400, { message: "このボードのリストではありません" });
    }
    if (list.cardEdit === "deny") {
      throw new HTTPException(400, { message: "このリストは編集できません" });
    }
    if (adding && list.wipLimit != null) {
      const sitting = await db.select().from(cards).where(eq(cards.listId, list.id));
      if (sitting.filter((card) => !card.archived).length >= list.wipLimit) {
        throw new HTTPException(400, { message: "WIP の上限に達しています" });
      }
    }
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

  async function placeAmong(
    rows: Array<{ id: string; rank: number }>,
    at: "start" | "end",
    write: (id: string, rank: number) => Promise<void>,
  ): Promise<number> {
    const ordered = rows.slice().sort((a, b) => a.rank - b.rank);
    const prev = at === "end" ? (ordered.at(-1)?.rank ?? null) : null;
    const next = at === "start" ? (ordered[0]?.rank ?? null) : null;
    const placed = placeRank(prev, next);
    if (!placed.needsRebalance) {
      return placed.rank;
    }
    const ranks = rebalanceRanks(ordered.length + 1);
    const offset = at === "start" ? 1 : 0;
    for (const [index, row] of ordered.entries()) {
      await write(row.id, ranks[index + offset] ?? 0);
    }
    return ranks[at === "start" ? 0 : ordered.length] ?? 0;
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
      looseBoards: boardRows.filter((board) => board.workspaceId == null).map(mapBoard),
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

  app.post("/api/workspaces/:workspaceId/move", async (c) => {
    const userId = c.get("userId");
    const workspaceId = c.req.param("workspaceId");
    const workspace = await ownedWorkspace(userId, workspaceId);
    const body = await c.req.json<{ prevRank?: number | null; nextRank?: number | null }>();
    const prevRank = body.prevRank ?? null;
    const nextRank = body.nextRank ?? null;
    const placed = placeRank(prevRank, nextRank);
    const owned = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId))
      .orderBy(asc(workspaces.rank));
    if (placed.needsRebalance) {
      const siblings = owned.filter((row) => row.id !== workspace.id);
      const insertAt =
        prevRank == null ? 0 : siblings.findIndex((row) => Number(row.rank) === prevRank) + 1;
      const ordered = [...siblings.slice(0, insertAt), workspace, ...siblings.slice(insertAt)];
      const ranks = rebalanceRanks(ordered.length);
      for (const [index, row] of ordered.entries()) {
        await db.update(workspaces).set({ rank: ranks[index] ?? 0 }).where(eq(workspaces.id, row.id));
      }
    } else {
      await db.update(workspaces).set({ rank: placed.rank }).where(eq(workspaces.id, workspace.id));
    }
    const moved = await one(
      db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1),
    );
    return c.json(mapWorkspace(moved!));
  });

  app.patch("/api/workspaces/:workspaceId", async (c) => {
    const userId = c.get("userId");
    const workspace = await ownedWorkspace(userId, c.req.param("workspaceId"));
    const body = await c.req.json<{ title?: string; starred?: boolean }>();
    const patch: { title?: string; starred?: boolean } = {};
    if (typeof body.title === "string") {
      try {
        validateTitle(body.title);
      } catch (err) {
        throw new HTTPException(400, { message: String(err) });
      }
      patch.title = body.title.trim();
    }
    if (typeof body.starred === "boolean") {
      patch.starred = body.starred;
    }
    if (Object.keys(patch).length === 0) {
      throw new HTTPException(400, { message: "変更がありません" });
    }
    await db.update(workspaces).set(patch).where(eq(workspaces.id, workspace.id));
    const updated = await one(
      db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1),
    );
    return c.json(mapWorkspace(updated!));
  });

  app.delete("/api/workspaces/:workspaceId", async (c) => {
    const userId = c.get("userId");
    const workspace = await ownedWorkspace(userId, c.req.param("workspaceId"));
    await db
      .update(boards)
      .set({ workspaceId: null })
      .where(eq(boards.workspaceId, workspace.id));
    await db.delete(workspaces).where(eq(workspaces.id, workspace.id));
    return c.json({ ok: true });
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

  app.get("/api/boards/public", async (c) => {
    const userId = c.get("userId");
    const rows = await db
      .select()
      .from(boards)
      .where(and(eq(boards.isPublic, true), eq(boards.archived, false)))
      .orderBy(asc(boards.createdAt));
    return c.json({
      boards: rows.filter((board) => board.ownerId !== userId).map(mapBoard),
    });
  });

  app.get("/api/boards/:boardId", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    await visibleBoard(userId, boardId);
    return c.json(await snapshot(boardId));
  });

  app.patch("/api/boards/:boardId", async (c) => {
    const userId = c.get("userId");
    const board = await ownedBoard(userId, c.req.param("boardId"));
    const body = await c.req.json<{ title?: string; isTemplate?: boolean; isPublic?: boolean }>();
    const patch: { title?: string; isTemplate?: boolean; isPublic?: boolean } = {};
    if (typeof body.title === "string") {
      try {
        validateTitle(body.title);
      } catch (err) {
        throw new HTTPException(400, { message: String(err) });
      }
      patch.title = body.title.trim();
    }
    if (typeof body.isTemplate === "boolean") {
      patch.isTemplate = body.isTemplate;
    }
    if (typeof body.isPublic === "boolean") {
      patch.isPublic = body.isPublic;
    }
    if (Object.keys(patch).length === 0) {
      throw new HTTPException(400, { message: "変更がありません" });
    }
    await db.update(boards).set(patch).where(eq(boards.id, board.id));
    const updated = await one(db.select().from(boards).where(eq(boards.id, board.id)).limit(1));
    return c.json(mapBoard(updated!));
  });

  app.post("/api/boards/:boardId/copy", async (c) => {
    const userId = c.get("userId");
    const source = await ownedBoard(userId, c.req.param("boardId"));
    const body = await c.req.json<{ workspaceId?: string; cards?: boolean }>();
    if (!body.workspaceId) {
      throw new HTTPException(400, { message: "ワークスペースを指定してください" });
    }
    const includeCards = body.cards !== false;
    await ownedWorkspace(userId, body.workspaceId);
    const title = copyTitle(source.title);
    const siblings = await db
      .select()
      .from(boards)
      .where(eq(boards.workspaceId, body.workspaceId))
      .orderBy(asc(boards.rank));
    const placed = placeRank(siblings.at(-1)?.rank ?? null, null);
    let rank = placed.rank;
    if (placed.needsRebalance) {
      const ranks = rebalanceRanks(siblings.length + 1);
      for (const [index, row] of siblings.entries()) {
        await db.update(boards).set({ rank: ranks[index] ?? 0 }).where(eq(boards.id, row.id));
      }
      rank = ranks[siblings.length] ?? siblings.length * 1024;
    }
    const boardId = id();
    await db.insert(boards).values({
      id: boardId,
      title,
      archived: false,
      ownerId: userId,
      workspaceId: body.workspaceId,
      rank,
      isTemplate: false,
      isPublic: false,
      createdAt: now(),
    });
    const sourceLists = await db
      .select()
      .from(lists)
      .where(eq(lists.boardId, source.id))
      .orderBy(asc(lists.rank));
    const listRanks = rebalanceRanks(sourceLists.length);
    const listIds = new Map<string, string>();
    for (const [index, list] of sourceLists.entries()) {
      const listId = id();
      listIds.set(list.id, listId);
      await db.insert(lists).values({
        id: listId,
        boardId,
        title: list.title,
        rank: listRanks[index] ?? index * 1024,
        collapsed: list.collapsed,
        width: list.width,
        wipLimit: list.wipLimit,
        archived: list.archived,
        color: list.color,
        cardEdit: list.cardEdit,
        createdAt: now(),
      });
    }
    if (includeCards) {
      const sourceCards = await db
        .select()
        .from(cards)
        .where(eq(cards.boardId, source.id))
        .orderBy(asc(cards.rank));
      const cardsByList = new Map<string, typeof sourceCards>();
      for (const card of sourceCards) {
        const bucket = cardsByList.get(card.listId) ?? [];
        bucket.push(card);
        cardsByList.set(card.listId, bucket);
      }
      for (const [sourceListId, copied] of cardsByList) {
        const listId = listIds.get(sourceListId);
        if (!listId) {
          continue;
        }
        const cardRanks = rebalanceRanks(copied.length);
        for (const [index, card] of copied.entries()) {
          await db.insert(cards).values({
            id: id(),
            boardId,
            listId,
            title: card.title,
            description: card.description,
            archived: card.archived,
            rank: cardRanks[index] ?? index * 1024,
            createdAt: now(),
          });
        }
      }
    }
    return c.json(await snapshot(boardId), 201);
  });

  app.get("/api/boards/:boardId/markdown", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    await visibleBoard(userId, boardId);
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
    if (!workspaceId) {
      throw new HTTPException(400, { message: "ワークスペースを指定してください" });
    }
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

  app.post("/api/boards/:boardId/lists/:listId/copy", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const listId = c.req.param("listId");
    await ownedBoard(userId, boardId);
    const source = await one(db.select().from(lists).where(eq(lists.id, listId)).limit(1));
    if (!source || source.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    let body: { targetBoardId?: string; title?: string } = {};
    try {
      body = await c.req.json<{ targetBoardId?: string; title?: string }>();
    } catch {
      body = {};
    }
    const targetBoardId = body.targetBoardId ?? boardId;
    await ownedBoard(userId, targetBoardId);
    const title = body.title ?? copyTitle(source.title);
    try {
      validateTitle(title);
    } catch (err) {
      throw new HTTPException(400, { message: String(err) });
    }
    const siblings = await db
      .select()
      .from(lists)
      .where(eq(lists.boardId, targetBoardId))
      .orderBy(asc(lists.rank));
    const rank = await placeAmong(siblings, "end", async (id, nextRank) => {
      await db.update(lists).set({ rank: nextRank }).where(eq(lists.id, id));
    });
    const copiedListId = id();
    await db.insert(lists).values({
      id: copiedListId,
      boardId: targetBoardId,
      title: title.trim(),
      rank,
      collapsed: false,
      width: source.width,
      wipLimit: source.wipLimit,
      archived: false,
      color: source.color,
      cardEdit: source.cardEdit,
      createdAt: now(),
    });
    const sourceCards = await db
      .select()
      .from(cards)
      .where(and(eq(cards.listId, source.id), eq(cards.archived, false)))
      .orderBy(asc(cards.rank));
    const cardRanks = rebalanceRanks(sourceCards.length);
    const copiedCards = [];
    for (const [index, card] of sourceCards.entries()) {
      const cardId = id();
      await db.insert(cards).values({
        id: cardId,
        boardId: targetBoardId,
        listId: copiedListId,
        title: card.title,
        description: card.description,
        archived: false,
        rank: cardRanks[index] ?? index * 1024,
        createdAt: now(),
      });
      const stored = mapCard(
        (await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!,
      );
      copiedCards.push(stored);
      broadcast(targetBoardId, { type: "card.upserted", payload: stored, actorId: userId });
    }
    const copiedList = mapList(
      (await one(db.select().from(lists).where(eq(lists.id, copiedListId)).limit(1)))!,
    );
    broadcast(targetBoardId, { type: "list.upserted", payload: copiedList, actorId: userId });
    return c.json({ list: copiedList, cards: copiedCards }, 201);
  });

  app.patch("/api/boards/:boardId/lists/:listId", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const listId = c.req.param("listId");
    await ownedBoard(userId, boardId);
    const list = await one(db.select().from(lists).where(eq(lists.id, listId)).limit(1));
    if (!list || list.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const body = await c.req.json<{
      title?: string;
      collapsed?: boolean;
      width?: string;
      wipLimit?: number | null;
      archived?: boolean;
      color?: string;
      cardEdit?: string;
    }>();
    const patch: {
      title?: string;
      collapsed?: boolean;
      width?: string;
      wipLimit?: number | null;
      archived?: boolean;
      color?: string;
      cardEdit?: string;
    } = {};
    if (typeof body.title === "string") {
      try {
        validateTitle(body.title);
      } catch (err) {
        throw new HTTPException(400, { message: String(err) });
      }
      patch.title = body.title.trim();
    }
    if (typeof body.collapsed === "boolean") {
      patch.collapsed = body.collapsed;
    }
    if (body.width !== undefined) {
      if (body.width !== "narrow" && body.width !== "normal" && body.width !== "wide") {
        throw new HTTPException(400, { message: "幅が不正です" });
      }
      patch.width = body.width;
    }
    if (body.wipLimit !== undefined) {
      if (body.wipLimit !== null && (!Number.isInteger(body.wipLimit) || body.wipLimit < 0)) {
        throw new HTTPException(400, { message: "WIP の上限が不正です" });
      }
      patch.wipLimit = body.wipLimit;
    }
    if (typeof body.archived === "boolean") {
      patch.archived = body.archived;
    }
    if (body.color !== undefined) {
      if (body.color !== "" && body.color !== "rust" && body.color !== "moss" && body.color !== "rivet") {
        throw new HTTPException(400, { message: "色が不正です" });
      }
      patch.color = body.color;
    }
    if (body.cardEdit !== undefined) {
      if (body.cardEdit !== "allow" && body.cardEdit !== "deny") {
        throw new HTTPException(400, { message: "権限が不正です" });
      }
      patch.cardEdit = body.cardEdit;
    }
    if (Object.keys(patch).length === 0) {
      throw new HTTPException(400, { message: "変更がありません" });
    }
    await db.update(lists).set(patch).where(eq(lists.id, listId));
    const updated = mapList(
      (await one(db.select().from(lists).where(eq(lists.id, listId)).limit(1)))!,
    );
    broadcast(boardId, { type: "list.upserted", payload: updated, actorId: userId });
    return c.json(updated);
  });

  app.post("/api/boards/:boardId/lists/:listId/move", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const listId = c.req.param("listId");
    await ownedBoard(userId, boardId);
    const list = await one(db.select().from(lists).where(eq(lists.id, listId)).limit(1));
    if (!list || list.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const body = await c.req.json<{ prevRank?: number | null; nextRank?: number | null }>();
    const prevRank = body.prevRank ?? null;
    const nextRank = body.nextRank ?? null;
    const placed = placeRank(prevRank, nextRank);
    if (placed.needsRebalance) {
      const siblings = (
        await db.select().from(lists).where(eq(lists.boardId, boardId)).orderBy(asc(lists.rank))
      ).filter((row) => row.id !== listId);
      const insertAt =
        prevRank == null ? 0 : siblings.findIndex((row) => Number(row.rank) === prevRank) + 1;
      const ordered = [...siblings.slice(0, insertAt), list, ...siblings.slice(insertAt)];
      const ranks = rebalanceRanks(ordered.length);
      for (const [index, row] of ordered.entries()) {
        await db
          .update(lists)
          .set({ rank: ranks[index] ?? 0 })
          .where(eq(lists.id, row.id));
      }
    } else {
      await db.update(lists).set({ rank: placed.rank }).where(eq(lists.id, listId));
    }
    const moved = mapList(
      (await one(db.select().from(lists).where(eq(lists.id, listId)).limit(1)))!,
    );
    broadcast(boardId, { type: "list.upserted", payload: moved, actorId: userId });
    return c.json(moved);
  });

  app.delete("/api/boards/:boardId/lists/:listId", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const listId = c.req.param("listId");
    await ownedBoard(userId, boardId);
    const list = await one(db.select().from(lists).where(eq(lists.id, listId)).limit(1));
    if (!list || list.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    await db.delete(cards).where(eq(cards.listId, listId));
    await db.delete(lists).where(eq(lists.id, listId));
    broadcast(boardId, { type: "list.deleted", payload: { id: listId }, actorId: userId });
    return c.json({ ok: true });
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
    await assertListAcceptsCard(list.id, true);
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

  app.post("/api/boards/:boardId/cards/:cardId/copy", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await ownedBoard(userId, boardId);
    const source = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!source || source.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const body = await c.req.json<{
      targetBoardId?: string;
      targetListId?: string;
      title?: string;
      at?: string;
    }>();
    if (!body.targetListId) {
      throw new HTTPException(400, { message: "複製先のリストを指定してください" });
    }
    if (body.at !== undefined && body.at !== "start" && body.at !== "end") {
      throw new HTTPException(400, { message: "複製位置が不正です" });
    }
    const targetBoardId = body.targetBoardId ?? boardId;
    await ownedBoard(userId, targetBoardId);
    const targetList = await one(db.select().from(lists).where(eq(lists.id, body.targetListId)).limit(1));
    if (!targetList || targetList.boardId !== targetBoardId) {
      throw new HTTPException(400, { message: "このボードのリストではありません" });
    }
    await assertListAcceptsCard(targetList.id, true);
    const title = body.title ?? copyTitle(source.title);
    try {
      validateTitle(title);
    } catch (err) {
      throw new HTTPException(400, { message: String(err) });
    }
    const siblings = await db
      .select()
      .from(cards)
      .where(and(eq(cards.listId, targetList.id), eq(cards.archived, false)))
      .orderBy(asc(cards.rank));
    const at = body.at === "start" ? "start" : "end";
    const rank = await placeAmong(siblings, at, async (id, nextRank) => {
      await db.update(cards).set({ rank: nextRank }).where(eq(cards.id, id));
    });
    const copiedId = id();
    await db.insert(cards).values({
      id: copiedId,
      boardId: targetBoardId,
      listId: targetList.id,
      title: title.trim(),
      description: source.description,
      archived: false,
      rank,
      createdAt: now(),
    });
    const copied = mapCard(
      (await one(db.select().from(cards).where(eq(cards.id, copiedId)).limit(1)))!,
    );
    broadcast(targetBoardId, { type: "card.upserted", payload: copied, actorId: userId });
    return c.json(copied, 201);
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
    const body = await c.req.json<{ title?: string; description?: string; archived?: boolean }>();
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
        ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
      })
      .where(eq(cards.id, cardId));
    const updated = mapCard(
      (await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!,
    );
    broadcast(boardId, { type: "card.upserted", payload: updated, actorId: userId });
    return c.json(updated);
  });

  app.delete("/api/boards/:boardId/cards/:cardId", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await ownedBoard(userId, boardId);
    const card = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!card || card.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    await db.delete(cards).where(eq(cards.id, cardId));
    broadcast(boardId, { type: "card.deleted", payload: { id: cardId }, actorId: userId });
    return c.json({ ok: true });
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
    if (card.listId !== list.id) {
      const source = await one(db.select().from(lists).where(eq(lists.id, card.listId)).limit(1));
      if (source?.cardEdit === "deny") {
        throw new HTTPException(400, { message: "このリストは編集できません" });
      }
      await assertListAcceptsCard(list.id, true);
    } else if (list.cardEdit === "deny") {
      throw new HTTPException(400, { message: "このリストは編集できません" });
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
