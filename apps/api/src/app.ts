import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { eq, and, asc, inArray, sql } from "drizzle-orm";
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
  isValidKey,
  markdownToBoardDraft,
  markdownToCardDraft,
  normalizeKey,
  suggestKey,
  type BoardSnapshot,
  type Card,
  type List,
  type WipGroup,
} from "@wekants/shared";
import type { AppDb } from "./db.ts";
import {
  boards,
  cardBallots,
  cardTemplates,
  cardUnsaved,
  cards,
  lists,
  sessions,
  users,
  wipGroupLists,
  wipGroups,
  workspaces,
} from "./schema.ts";
import { broadcast, broadcastToUser, closeGuests } from "./hub.ts";

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
    key: row.key,
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
    archivedWithList: Boolean(row.archivedWithList),
    number: row.number,
    vote: row.voteQuestion
      ? {
          question: row.voteQuestion,
          public: row.votePublic,
          positive: 0,
          negative: 0,
          positiveNames: [],
          negativeNames: [],
        }
      : null,
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
    const created = await one(db.select().from(users).where(eq(users.id, userId)).limit(1));
    return c.json(await publicUser(created!));
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
    return c.json(await publicUser(user));
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
    return c.json(await publicUser(user));
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
    const userId = await readSession(c);
    if (userId) {
      c.set("userId", userId);
      await next();
      return;
    }
    const path = c.req.path;
    const publicRead =
      c.req.method === "GET" &&
      (path === "/api/boards/public" ||
        /^\/api\/boards\/[^/]+$/.test(path) ||
        /^\/api\/boards\/[^/]+\/markdown$/.test(path));
    if (!publicRead) {
      throw new HTTPException(401, { message: "ログインが必要です" });
    }
    c.set("userId", "");
    await next();
  });

  async function publicUser(user: typeof users.$inferSelect) {
    let homeBoardId = user.homeBoardId;
    if (homeBoardId) {
      const board = await one(db.select().from(boards).where(eq(boards.id, homeBoardId)).limit(1));
      if (!board || board.ownerId !== user.id || board.archived) {
        homeBoardId = null;
      }
    }
    return { id: user.id, username: user.username, homeBoardId };
  }

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

  async function assertListAcceptsCard(listId: string, adding: boolean, movingCardId: string | null = null) {
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
    if (adding) {
      await assertSharedWip(listId, movingCardId, 1);
    }
  }

  async function loadWipGroups(boardId: string): Promise<WipGroup[]> {
    const groups = await db.select().from(wipGroups).where(eq(wipGroups.boardId, boardId));
    if (groups.length === 0) {
      return [];
    }
    const links = await db
      .select()
      .from(wipGroupLists)
      .where(
        inArray(
          wipGroupLists.groupId,
          groups.map((group) => group.id),
        ),
      );
    return groups
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((group) => ({
        id: group.id,
        boardId: group.boardId,
        title: group.title,
        limit: group.limit,
        enabled: group.enabled,
        listIds: links.filter((link) => link.groupId === group.id).map((link) => link.listId),
      }));
  }

  async function publishGroups(boardId: string, actorId: string): Promise<WipGroup[]> {
    const groups = await loadWipGroups(boardId);
    broadcast(boardId, { type: "wipGroups.updated", payload: groups, actorId });
    return groups;
  }

  async function assertSharedWip(listId: string, movingCardId: string | null, incoming: number): Promise<void> {
    if (incoming <= 0) {
      return;
    }
    const links = await db.select().from(wipGroupLists).where(eq(wipGroupLists.listId, listId));
    if (links.length === 0) {
      return;
    }
    const groups = await db
      .select()
      .from(wipGroups)
      .where(
        inArray(
          wipGroups.id,
          [...new Set(links.map((link) => link.groupId))],
        ),
      );
    for (const group of groups) {
      if (!group.enabled) {
        continue;
      }
      const members = await db.select().from(wipGroupLists).where(eq(wipGroupLists.groupId, group.id));
      const listIds = members.map((member) => member.listId);
      const sitting = await db
        .select({ id: cards.id, archived: cards.archived })
        .from(cards)
        .where(inArray(cards.listId, listIds));
      const already = Boolean(
        movingCardId && sitting.some((card) => card.id === movingCardId && !card.archived),
      );
      const open = sitting.filter((card) => !card.archived && card.id !== movingCardId).length;
      if (open + (already ? 0 : incoming) > group.limit) {
        throw new HTTPException(400, { message: "仕掛かりの共通上限に達しています" });
      }
    }
  }

  async function checkedGroupLists(boardId: string, listIds: unknown): Promise<string[]> {
    if (!Array.isArray(listIds) || listIds.some((item) => typeof item !== "string")) {
      throw new HTTPException(400, { message: "リストを2つ以上選んでください" });
    }
    const unique = [...new Set(listIds)];
    if (unique.length < 2) {
      throw new HTTPException(400, { message: "リストを2つ以上選んでください" });
    }
    const rows = await db.select({ id: lists.id }).from(lists).where(eq(lists.boardId, boardId));
    const known = new Set(rows.map((row) => row.id));
    if (unique.some((item) => !known.has(item))) {
      throw new HTTPException(400, { message: "このボードのリストではありません" });
    }
    return unique;
  }

  function checkedGroupLimit(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 999) {
      throw new HTTPException(400, { message: "上限は1から999です" });
    }
    return value;
  }

  function checkedGroupTitle(value: unknown): string {
    if (value === undefined) {
      return "";
    }
    if (typeof value !== "string") {
      throw new HTTPException(400, { message: "グループ名は80文字までです" });
    }
    const title = value.trim();
    if ([...title].length > 80) {
      throw new HTTPException(400, { message: "グループ名は80文字までです" });
    }
    return title;
  }

  async function replaceGroupLists(groupId: string, listIds: string[]): Promise<void> {
    await db.delete(wipGroupLists).where(eq(wipGroupLists.groupId, groupId));
    await db.insert(wipGroupLists).values(listIds.map((listId) => ({ groupId, listId })));
  }

  async function withCounts(items: Card[]): Promise<Card[]> {
    const pending = items.filter((card) => card.vote);
    if (pending.length === 0) {
      return items;
    }
    const ballots = await db
      .select()
      .from(cardBallots)
      .where(
        inArray(
          cardBallots.cardId,
          pending.map((card) => card.id),
        ),
      );
    const voterIds = [...new Set(ballots.map((row) => row.userId))];
    const people =
      voterIds.length === 0
        ? []
        : await db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(inArray(users.id, voterIds));
    const nameOf = new Map(people.map((row) => [row.id, row.username]));
    return items.map((card) => {
      if (!card.vote) {
        return card;
      }
      const rows = ballots.filter((row) => row.cardId === card.id);
      const positive = rows.filter((row) => row.choice === "positive");
      const negative = rows.filter((row) => row.choice === "negative");
      return {
        ...card,
        vote: {
          ...card.vote,
          positive: positive.length,
          negative: negative.length,
          positiveNames: card.vote.public ? positive.map((row) => nameOf.get(row.userId) ?? "") : [],
          negativeNames: card.vote.public ? negative.map((row) => nameOf.get(row.userId) ?? "") : [],
        },
      };
    });
  }

  async function present(card: Card): Promise<Card> {
    return (await withCounts([card]))[0] ?? card;
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
      cards: await withCounts(boardCards.map(mapCard)),
      wipGroups: await loadWipGroups(boardId),
    };
  }

  async function allocateKey(title: string): Promise<string> {
    const rows = await db.select({ key: boards.key }).from(boards);
    return suggestKey(title, new Set(rows.map((row) => row.key).filter((key) => key.length > 0)));
  }

  async function takeCardNumber(boardId: string): Promise<number> {
    const rows = await db
      .update(boards)
      .set({ cardSeq: sql`${boards.cardSeq} + 1` })
      .where(eq(boards.id, boardId))
      .returning({ cardSeq: boards.cardSeq });
    return rows[0]?.cardSeq ?? 1;
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
      homeBoardId: (await publicUser(
        (await one(db.select().from(users).where(eq(users.id, userId)).limit(1)))!,
      )).homeBoardId,
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
      key: await allocateKey(draft.title.trim()),
      cardSeq: 0,
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
            number: await takeCardNumber(boardId),
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
    const snap = await snapshot(boardId);
    const viewer = userId
      ? await one(db.select().from(users).where(eq(users.id, userId)).limit(1))
      : undefined;
    const drafts = userId
      ? await db
          .select()
          .from(cardUnsaved)
          .where(and(eq(cardUnsaved.userId, userId), eq(cardUnsaved.boardId, boardId)))
      : [];
    const votedIds = snap.cards.filter((card) => card.vote).map((card) => card.id);
    const mine =
      userId && votedIds.length > 0
        ? await db
            .select()
            .from(cardBallots)
            .where(and(eq(cardBallots.userId, userId), inArray(cardBallots.cardId, votedIds)))
        : [];
    return c.json({
      ...snap,
      home: viewer?.homeBoardId === boardId,
      unsaved: drafts.map((row) => ({
        cardId: row.cardId,
        title: row.title,
        description: row.description,
      })),
      myVotes: mine
        .filter((row) => row.choice === "positive" || row.choice === "negative")
        .map((row) => ({ cardId: row.cardId, choice: row.choice as "positive" | "negative" })),
    });
  });

  app.patch("/api/boards/:boardId", async (c) => {
    const userId = c.get("userId");
    const board = await ownedBoard(userId, c.req.param("boardId"));
    const body = await c.req.json<{
      title?: string;
      isTemplate?: boolean;
      isPublic?: boolean;
      home?: boolean;
      key?: string;
    }>();
    const patch: { title?: string; isTemplate?: boolean; isPublic?: boolean; key?: string } = {};
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
    if (typeof body.key === "string") {
      const key = normalizeKey(body.key);
      if (!isValidKey(key)) {
        throw new HTTPException(400, { message: "ボードキーは先頭が文字の2〜10文字です" });
      }
      const clash = await one(db.select().from(boards).where(eq(boards.key, key)).limit(1));
      if (clash && clash.id !== board.id) {
        throw new HTTPException(400, { message: "このボードキーは使われています" });
      }
      patch.key = key;
    }
    if (Object.keys(patch).length === 0 && typeof body.home !== "boolean") {
      throw new HTTPException(400, { message: "変更がありません" });
    }
    if (Object.keys(patch).length > 0) {
      await db.update(boards).set(patch).where(eq(boards.id, board.id));
    }
    if (body.home === true) {
      await db.update(users).set({ homeBoardId: board.id }).where(eq(users.id, userId));
    } else if (body.home === false) {
      await db
        .update(users)
        .set({ homeBoardId: null })
        .where(and(eq(users.id, userId), eq(users.homeBoardId, board.id)));
    }
    const updated = mapBoard(
      (await one(db.select().from(boards).where(eq(boards.id, board.id)).limit(1)))!,
    );
    if (Object.keys(patch).length > 0) {
      broadcast(board.id, { type: "board.updated", payload: updated, actorId: userId });
      if (updated.isPublic === false) {
        closeGuests(board.id, board.ownerId);
      }
    }
    return c.json(updated);
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
      key: await allocateKey(title),
      cardSeq: 0,
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
            number: await takeCardNumber(boardId),
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
        number: await takeCardNumber(targetBoardId),
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
    if (patch.archived === false) {
      const tied = await db
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.listId, listId), eq(cards.archivedWithList, true)));
      if (tied.length > 0) {
        await assertSharedWip(listId, null, tied.length);
      }
    }
    await db.update(lists).set(patch).where(eq(lists.id, listId));
    if (patch.archived === true) {
      const open = await db
        .select()
        .from(cards)
        .where(and(eq(cards.listId, listId), eq(cards.archived, false)));
      if (open.length > 0) {
        await db
          .update(cards)
          .set({ archived: true, archivedWithList: true })
          .where(and(eq(cards.listId, listId), eq(cards.archived, false)));
      }
      for (const card of open) {
        broadcast(boardId, {
          type: "card.upserted",
          payload: await present({ ...mapCard(card), archived: true, archivedWithList: true }),
          actorId: userId,
        });
      }
    } else if (patch.archived === false) {
      const tied = await db
        .select()
        .from(cards)
        .where(and(eq(cards.listId, listId), eq(cards.archivedWithList, true)));
      if (tied.length > 0) {
        await db
          .update(cards)
          .set({ archived: false, archivedWithList: false })
          .where(and(eq(cards.listId, listId), eq(cards.archivedWithList, true)));
      }
      for (const card of tied) {
        broadcast(boardId, {
          type: "card.upserted",
          payload: await present({ ...mapCard(card), archived: false, archivedWithList: false }),
          actorId: userId,
        });
      }
    }
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
    const doomed = await db.select({ id: cards.id }).from(cards).where(eq(cards.listId, listId));
    if (doomed.length > 0) {
      await db.delete(cardBallots).where(
        inArray(
          cardBallots.cardId,
          doomed.map((row) => row.id),
        ),
      );
    }
    await db.delete(cards).where(eq(cards.listId, listId));
    await db.delete(lists).where(eq(lists.id, listId));
    await db.delete(wipGroupLists).where(eq(wipGroupLists.listId, listId));
    const remaining = await loadWipGroups(boardId);
    for (const group of remaining) {
      if (group.listIds.length < 2) {
        await db.delete(wipGroupLists).where(eq(wipGroupLists.groupId, group.id));
        await db.delete(wipGroups).where(eq(wipGroups.id, group.id));
      }
    }
    await publishGroups(boardId, userId);
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
      templateId?: string;
    }>();
    const list = await one(
      db.select().from(lists).where(eq(lists.id, body.listId ?? "")).limit(1),
    );
    if (!list || list.boardId !== boardId) {
      throw new HTTPException(400, { message: "このボードのリストではありません" });
    }
    await assertListAcceptsCard(list.id, true);
    const template = body.templateId
      ? await one(
          db.select().from(cardTemplates).where(eq(cardTemplates.id, body.templateId)).limit(1),
        )
      : undefined;
    if (body.templateId && (!template || template.ownerId !== userId)) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const draft = template
      ? { title: template.title, description: template.description }
      : body.markdown
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
      number: await takeCardNumber(boardId),
      rank,
      createdAt: now(),
    });
    const card = await present(
      mapCard((await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!),
    );
    broadcast(boardId, { type: "card.upserted", payload: card, actorId: userId });
    return c.json(card, 201);
  });

  app.use("/api/card-templates", async (c, next) => {
    await attachUser(c);
    await next();
  });

  app.get("/api/card-templates", async (c) => {
    const userId = c.get("userId");
    const rows = await db
      .select()
      .from(cardTemplates)
      .where(eq(cardTemplates.ownerId, userId))
      .orderBy(asc(cardTemplates.createdAt));
    return c.json({
      templates: rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
      })),
    });
  });

  app.post("/api/boards/:boardId/cards/:cardId/template", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await ownedBoard(userId, boardId);
    const card = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!card || card.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const templateId = id();
    await db.insert(cardTemplates).values({
      id: templateId,
      ownerId: userId,
      title: card.title,
      description: card.description,
      createdAt: now(),
    });
    const kept = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    return c.json(
      {
        template: { id: templateId, title: card.title, description: card.description },
        card: await present(mapCard(kept!)),
      },
      201,
    );
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
      number: await takeCardNumber(targetBoardId),
      rank,
      createdAt: now(),
    });
    const copied = await present(
      mapCard((await one(db.select().from(cards).where(eq(cards.id, copiedId)).limit(1)))!),
    );
    broadcast(targetBoardId, { type: "card.upserted", payload: copied, actorId: userId });
    return c.json(copied, 201);
  });

  app.put("/api/boards/:boardId/cards/:cardId/unsaved", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await ownedBoard(userId, boardId);
    const card = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!card || card.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const body = await c.req.json<{ title?: string; description?: string }>();
    if (typeof body.title !== "string" || typeof body.description !== "string") {
      throw new HTTPException(400, { message: "タイトルと本文が必要です" });
    }
    try {
      validateTitle(body.title);
    } catch (err) {
      throw new HTTPException(400, { message: String(err) });
    }
    const title = body.title.trim();
    const description = body.description;
    const same = title === card.title && description === card.description;
    if (same) {
      await db
        .delete(cardUnsaved)
        .where(and(eq(cardUnsaved.userId, userId), eq(cardUnsaved.cardId, cardId)));
      broadcastToUser(boardId, userId, {
        type: "card.unsavedCleared",
        payload: { cardId, userId },
        actorId: userId,
      });
      return c.json({ unsaved: null });
    }
    const existing = await one(
      db
        .select()
        .from(cardUnsaved)
        .where(and(eq(cardUnsaved.userId, userId), eq(cardUnsaved.cardId, cardId)))
        .limit(1),
    );
    if (existing) {
      await db
        .update(cardUnsaved)
        .set({ title, description, updatedAt: now() })
        .where(and(eq(cardUnsaved.userId, userId), eq(cardUnsaved.cardId, cardId)));
    } else {
      await db.insert(cardUnsaved).values({
        userId,
        cardId,
        boardId,
        title,
        description,
        updatedAt: now(),
      });
    }
    const unsaved = { cardId, title, description };
    broadcastToUser(boardId, userId, {
      type: "card.unsaved",
      payload: { ...unsaved, userId },
      actorId: userId,
    });
    return c.json({ unsaved });
  });

  app.delete("/api/boards/:boardId/cards/:cardId/unsaved", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await ownedBoard(userId, boardId);
    const card = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!card || card.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    await db
      .delete(cardUnsaved)
      .where(and(eq(cardUnsaved.userId, userId), eq(cardUnsaved.cardId, cardId)));
    broadcastToUser(boardId, userId, {
      type: "card.unsavedCleared",
      payload: { cardId, userId },
      actorId: userId,
    });
    return c.json({ ok: true });
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
    if (body.archived === false && card.archived) {
      await assertListAcceptsCard(card.listId, true);
    }
    await db
      .update(cards)
      .set({
        title: title.trim(),
        description: body.description ?? card.description,
        ...(typeof body.archived === "boolean"
          ? { archived: body.archived, archivedWithList: false }
          : {}),
      })
      .where(eq(cards.id, cardId));
    const updated = await present(
      mapCard((await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!),
    );
    if (typeof body.title === "string" || typeof body.description === "string") {
      await db
        .delete(cardUnsaved)
        .where(and(eq(cardUnsaved.userId, userId), eq(cardUnsaved.cardId, cardId)));
      broadcastToUser(boardId, userId, {
        type: "card.unsavedCleared",
        payload: { cardId, userId },
        actorId: userId,
      });
    }
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
    await db.delete(cardBallots).where(eq(cardBallots.cardId, cardId));
    await db.delete(cards).where(eq(cards.id, cardId));
    await db.delete(cardUnsaved).where(eq(cardUnsaved.cardId, cardId));
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
      await assertListAcceptsCard(list.id, true, card.id);
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
    const updated = await present(
      mapCard((await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!),
    );
    broadcast(boardId, { type: "card.moved", payload: updated, actorId: userId });
    return c.json(updated);
  });

  app.put("/api/boards/:boardId/cards/:cardId/vote", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await ownedBoard(userId, boardId);
    const card = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!card || card.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const body = await c.req.json<{ question?: string; public?: boolean }>();
    const question = (body.question ?? "").trim();
    if (question.length > 300) {
      throw new HTTPException(400, { message: "投票の質問は300文字までです" });
    }
    if (body.public !== undefined && typeof body.public !== "boolean") {
      throw new HTTPException(400, { message: "公開の指定が不正です" });
    }
    const visible = body.public ?? true;
    await db
      .update(cards)
      .set({ voteQuestion: question, votePublic: visible })
      .where(eq(cards.id, cardId));
    if (!question) {
      await db.delete(cardBallots).where(eq(cardBallots.cardId, cardId));
    }
    const updated = await present(
      mapCard((await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!),
    );
    broadcast(boardId, { type: "card.upserted", payload: updated, actorId: userId });
    return c.json(updated);
  });

  app.post("/api/boards/:boardId/cards/:cardId/vote", async (c) => {
    const userId = c.get("userId");
    if (!userId) {
      throw new HTTPException(401, { message: "ログインが必要です" });
    }
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    await visibleBoard(userId, boardId);
    const card = await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1));
    if (!card || card.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    if (!card.voteQuestion) {
      throw new HTTPException(400, { message: "投票の質問がありません" });
    }
    const body = await c.req.json<{ choice?: string }>();
    if (body.choice !== "positive" && body.choice !== "negative") {
      throw new HTTPException(400, { message: "賛成か反対を選んでください" });
    }
    const existing = await one(
      db
        .select()
        .from(cardBallots)
        .where(and(eq(cardBallots.cardId, cardId), eq(cardBallots.userId, userId)))
        .limit(1),
    );
    const choice = existing?.choice === body.choice ? null : body.choice;
    await db
      .delete(cardBallots)
      .where(and(eq(cardBallots.cardId, cardId), eq(cardBallots.userId, userId)));
    if (choice) {
      await db.insert(cardBallots).values({ cardId, userId, choice });
    }
    const updated = await present(
      mapCard((await one(db.select().from(cards).where(eq(cards.id, cardId)).limit(1)))!),
    );
    broadcast(boardId, { type: "card.upserted", payload: updated, actorId: userId });
    broadcastToUser(boardId, userId, {
      type: "card.voted",
      payload: { cardId, choice, userId },
      actorId: userId,
    });
    return c.json({ card: updated, choice });
  });

  app.post("/api/boards/:boardId/wip-groups", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    await ownedBoard(userId, boardId);
    const body = await c.req.json<{ title?: string; listIds?: unknown; limit?: unknown }>();
    const listIds = await checkedGroupLists(boardId, body.listIds);
    const limit = checkedGroupLimit(body.limit);
    const title = checkedGroupTitle(body.title);
    const groupId = id();
    await db.insert(wipGroups).values({
      id: groupId,
      boardId,
      title,
      limit,
      enabled: true,
      createdAt: now(),
    });
    await replaceGroupLists(groupId, listIds);
    return c.json({ groups: await publishGroups(boardId, userId) }, 201);
  });

  app.patch("/api/boards/:boardId/wip-groups/:groupId", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const groupId = c.req.param("groupId");
    await ownedBoard(userId, boardId);
    const group = await one(db.select().from(wipGroups).where(eq(wipGroups.id, groupId)).limit(1));
    if (!group || group.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    const body = await c.req.json<{
      title?: unknown;
      listIds?: unknown;
      limit?: unknown;
      enabled?: unknown;
    }>();
    const patch: { title?: string; limit?: number; enabled?: boolean } = {};
    if (body.title !== undefined) {
      patch.title = checkedGroupTitle(body.title);
    }
    if (body.limit !== undefined) {
      patch.limit = checkedGroupLimit(body.limit);
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        throw new HTTPException(400, { message: "有効の指定が不正です" });
      }
      patch.enabled = body.enabled;
    }
    const listIds = body.listIds === undefined ? null : await checkedGroupLists(boardId, body.listIds);
    if (Object.keys(patch).length === 0 && !listIds) {
      throw new HTTPException(400, { message: "変更がありません" });
    }
    if (Object.keys(patch).length > 0) {
      await db.update(wipGroups).set(patch).where(eq(wipGroups.id, groupId));
    }
    if (listIds) {
      await replaceGroupLists(groupId, listIds);
    }
    return c.json({ groups: await publishGroups(boardId, userId) });
  });

  app.delete("/api/boards/:boardId/wip-groups/:groupId", async (c) => {
    const userId = c.get("userId");
    const boardId = c.req.param("boardId");
    const groupId = c.req.param("groupId");
    await ownedBoard(userId, boardId);
    const group = await one(db.select().from(wipGroups).where(eq(wipGroups.id, groupId)).limit(1));
    if (!group || group.boardId !== boardId) {
      throw new HTTPException(404, { message: "見つかりません" });
    }
    await db.delete(wipGroupLists).where(eq(wipGroupLists.groupId, groupId));
    await db.delete(wipGroups).where(eq(wipGroups.id, groupId));
    return c.json({ groups: await publishGroups(boardId, userId) });
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
