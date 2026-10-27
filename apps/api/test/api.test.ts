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

  it("moves a workspace before another workspace", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "june", password: "password1" }),
    });
    const jar = cookie(register);
    const extra = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Bay 2" }),
    });
    const bay = await extra.json();
    const tree = await app.request("/api/workspaces", { headers: { cookie: jar } });
    const first = (await tree.json()).workspaces[0];
    const moved = await app.request(`/api/workspaces/${bay.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ prevRank: null, nextRank: first.rank }),
    });
    expect(moved.status).toBe(200);
    const again = await app.request("/api/workspaces", { headers: { cookie: jar } });
    expect((await again.json()).workspaces[0].id).toBe(bay.id);
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

  it("stores list width, color, WIP, archive, and edit lock", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ines", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Finish" }),
    });
    const snapshot = await created.json();
    const listId = snapshot.lists[0].id;
    const patched = await app.request(`/api/boards/${snapshot.board.id}/lists/${listId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({
        width: "wide",
        color: "moss",
        wipLimit: 0,
        cardEdit: "deny",
        archived: true,
      }),
    });
    expect(patched.status).toBe(200);
    const list = await patched.json();
    expect(list.width).toBe("wide");
    expect(list.color).toBe("moss");
    expect(list.wipLimit).toBe(0);
    expect(list.cardEdit).toBe("deny");
    expect(list.archived).toBe(true);
    const blocked = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId, title: "Nope" }),
    });
    expect(blocked.status).toBe(400);
  });

  it("moves a list before another list", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "hiro", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Order" }),
    });
    const snapshot = await created.json();
    const [first, second] = snapshot.lists;
    const moved = await app.request(`/api/boards/${snapshot.board.id}/lists/${second.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ prevRank: null, nextRank: first.rank }),
    });
    expect(moved.status).toBe(200);
    const again = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: jar },
    });
    const titles = (await again.json()).lists.map((list: { title: string }) => list.title);
    expect(titles[0]).toBe(second.title);
  });

  it("renames a list", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "gina", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Names" }),
    });
    const snapshot = await created.json();
    const renamed = await app.request(
      `/api/boards/${snapshot.board.id}/lists/${snapshot.lists[0].id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: jar },
        body: JSON.stringify({ title: "切断" }),
      },
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).title).toBe("切断");
    const folded = await app.request(
      `/api/boards/${snapshot.board.id}/lists/${snapshot.lists[0].id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: jar },
        body: JSON.stringify({ collapsed: true }),
      },
    );
    expect(folded.status).toBe(200);
    expect((await folded.json()).collapsed).toBe(true);
    const again = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: jar },
    });
    expect((await again.json()).lists[0].collapsed).toBe(true);
  });

  it("deletes a card and a list with its cards", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "faye", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Scrap" }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Offcut" }),
    });
    const card = await cardRes.json();
    const removed = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}`, {
      method: "DELETE",
      headers: { cookie: jar },
    });
    expect(removed.status).toBe(200);
    const afterCard = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: jar },
    });
    expect((await afterCard.json()).cards).toEqual([]);
    const dropped = await app.request(
      `/api/boards/${snapshot.board.id}/lists/${snapshot.lists[0].id}`,
      { method: "DELETE", headers: { cookie: jar } },
    );
    expect(dropped.status).toBe(200);
    const afterList = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: jar },
    });
    const body = await afterList.json();
    expect(body.lists.map((list: { id: string }) => list.id)).not.toContain(snapshot.lists[0].id);
  });

  it("renames a workspace, copies a template, and opens a public board", async () => {
    const ada = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "password1" }),
    });
    const adaJar = cookie(ada);
    const tree = await app.request("/api/workspaces", { headers: { cookie: adaJar } });
    const workspaceId = (await tree.json()).workspaces[0].id as string;
    const renamed = await app.request(`/api/workspaces/${workspaceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ title: "現場", starred: true }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ title: "現場", starred: true });

    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ title: "Lathe", workspaceId }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Chuck" }),
    });
    expect(cardRes.status).toBe(201);
    const flagged = await app.request(`/api/boards/${snapshot.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ isTemplate: true, isPublic: true }),
    });
    expect(flagged.status).toBe(200);

    const copied = await app.request(`/api/boards/${snapshot.board.id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ workspaceId }),
    });
    expect(copied.status).toBe(201);
    const copy = await copied.json();
    expect(copy.board.title).toBe("Lathe の複製");
    expect(copy.cards.map((card: { title: string }) => card.title)).toContain("Chuck");

    const bob = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "password1" }),
    });
    const bobJar = cookie(bob);
    const seen = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: bobJar } });
    expect(seen.status).toBe(200);
    const published = await app.request("/api/boards/public", { headers: { cookie: bobJar } });
    const publicIds = (await published.json()).boards.map((board: { id: string }) => board.id);
    expect(publicIds).toContain(snapshot.board.id);

    const hidden = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ title: "Private", workspaceId }),
    });
    const privateId = (await hidden.json()).board.id as string;
    const denied = await app.request(`/api/boards/${privateId}`, { headers: { cookie: bobJar } });
    expect(denied.status).toBe(404);

    const removed = await app.request(`/api/workspaces/${workspaceId}`, {
      method: "DELETE",
      headers: { cookie: adaJar },
    });
    expect(removed.status).toBe(200);
    const after = await app.request("/api/workspaces", { headers: { cookie: adaJar } });
    expect((await after.json()).workspaces).toEqual([]);
  });
});
