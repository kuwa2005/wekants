import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase, type AppDb } from "../src/db.ts";
import type postgres from "postgres";
import { boardToMarkdown, markdownToBoardDraft } from "@wekants/shared";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required for API tests (start compose db)");
}

function cookie(res: Response): string {
  const raw = res.headers.getSetCookie?.().join(",") ?? res.headers.get("set-cookie") ?? "";
  const match = raw.match(/wekants_session=([^;]+)/);
  if (!match) {
    throw new Error(`no session cookie in ${raw}`);
  }
  return `wekants_session=${match[1]}`;
}

describe("auth, boards, markdown, workspaces", () => {
  let db: AppDb;
  let sql: postgres.Sql;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const opened = await openDatabase(url);
    db = opened.db;
    sql = opened.sql;
  });

  beforeEach(async () => {
    await sql.unsafe(
      "TRUNCATE cards, lists, boards, workspaces, sessions, users CASCADE",
    );
    app = createApp(db);
  });

  it("rejects unauthenticated board list", async () => {
    const res = await app.request("/api/workspaces");
    expect(res.status).toBe(401);
  });

  it("hides another user's board", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "password1" }),
    });
    expect(register.status).toBe(200);
    const aliceCookie = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aliceCookie },
      body: JSON.stringify({ title: "Shop floor" }),
    });
    expect(created.status).toBe(201);
    const snapshot = await created.json();
    const bob = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "password1" }),
    });
    const hidden = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: cookie(bob) },
    });
    expect(hidden.status).toBe(404);
  });

  it("moves a card onto another list", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "cara", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Move me" }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Cut steel" }),
    });
    const card = await cardRes.json();
    const movedRes = await app.request(
      `/api/boards/${snapshot.board.id}/cards/${card.id}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar },
        body: JSON.stringify({
          listId: snapshot.lists[1].id,
          prevRank: null,
          nextRank: null,
        }),
      },
    );
    expect(movedRes.status).toBe(200);
    expect((await movedRes.json()).listId).toBe(snapshot.lists[1].id);
  });

  it("imports and exports markdown boards", async () => {
    const md = `# Night notes

## Ready

### Cut plate

Use **3mm** steel.

## Doing
`;
    const draft = markdownToBoardDraft(md, "x");
    expect(draft.title).toBe("Night notes");
    expect(draft.lists[0].cards[0].description).toContain("3mm");

    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "dana", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ markdown: md }),
    });
    expect(created.status).toBe(201);
    const snapshot = await created.json();
    expect(snapshot.board.title).toBe("Night notes");
    expect(snapshot.lists.map((list: { title: string }) => list.title)).toEqual([
      "Ready",
      "Doing",
    ]);
    const exported = await app.request(`/api/boards/${snapshot.board.id}/markdown`, {
      headers: { cookie: jar },
    });
    expect(exported.status).toBe(200);
    const text = await exported.text();
    expect(text).toContain("# Night notes");
    expect(boardToMarkdown(snapshot)).toContain("### Cut plate");
  });

  it("moves a board between workspaces with rust ranks", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "erin", password: "password1" }),
    });
    const jar = cookie(register);
    const extra = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Bay 2" }),
    });
    expect(extra.status).toBe(201);
    const bay = await extra.json();
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Jig" }),
    });
    const snapshot = await created.json();
    const moved = await app.request(`/api/boards/${snapshot.board.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ workspaceId: bay.id, prevRank: null, nextRank: null }),
    });
    expect(moved.status).toBe(200);
    expect((await moved.json()).workspaceId).toBe(bay.id);
  });
});
