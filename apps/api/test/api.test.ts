import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { createApp } from "../src/app.ts";
import { openDatabase, type AppDb } from "../src/db.ts";
import { joinBoard, leaveBoard } from "../src/hub.ts";
import type postgres from "postgres";
import { boardToMarkdown, markdownToBoardDraft, rankSimilarCards, titlesFromInput } from "@wekants/shared";

function listen() {
  const messages: string[] = [];
  let closed = 0;
  const socket = {
    readyState: 1,
    OPEN: 1,
    send(data: string) {
      messages.push(data);
    },
    close() {
      closed += 1;
      this.readyState = 3;
    },
  };
  return {
    socket: socket as unknown as WebSocket,
    messages,
    closed: () => closed,
  };
}

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
      "TRUNCATE card_ballots, wip_group_lists, wip_groups, card_unsaved, card_templates, cards, lists, boards, workspaces, sessions, users CASCADE",
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
    const afterTree = await after.json();
    expect(afterTree.workspaces).toEqual([]);
    expect(afterTree.looseBoards.map((board: { title: string }) => board.title)).toEqual(
      expect.arrayContaining(["Lathe", "Lathe の複製", "Private"]),
    );
    const still = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: adaJar },
    });
    expect(still.status).toBe(200);
  });

  it("keeps lists and cards when a workspace is deleted", async () => {
    const nia = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nia", password: "password1" }),
    });
    const jar = cookie(nia);
    const tree = await app.request("/api/workspaces", { headers: { cookie: jar } });
    const homeId = (await tree.json()).workspaces[0].id as string;
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Kept", workspaceId: homeId }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Bolt" }),
    });
    const card = await cardRes.json();
    const described = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ description: "そのまま" }),
    });
    expect(described.status).toBe(200);

    const empty = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "空" }),
    });
    const emptyId = (await empty.json()).id as string;
    const other = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "noa", password: "password1" }),
    });
    const otherJar = cookie(other);
    const denied = await app.request(`/api/workspaces/${homeId}`, {
      method: "DELETE",
      headers: { cookie: otherJar },
    });
    expect(denied.status).toBe(404);

    const dropped = await app.request(`/api/workspaces/${emptyId}`, {
      method: "DELETE",
      headers: { cookie: jar },
    });
    expect(dropped.status).toBe(200);
    const mid = await app.request("/api/workspaces", { headers: { cookie: jar } });
    const midTree = await mid.json();
    expect(midTree.workspaces.map((space: { id: string }) => space.id)).toEqual([homeId]);
    expect(midTree.workspaces[0].boards.map((board: { id: string }) => board.id)).toEqual([
      snapshot.board.id,
    ]);

    const removed = await app.request(`/api/workspaces/${homeId}`, {
      method: "DELETE",
      headers: { cookie: jar },
    });
    expect(removed.status).toBe(200);
    const after = await app.request("/api/workspaces", { headers: { cookie: jar } });
    const afterTree = await after.json();
    expect(afterTree.workspaces).toEqual([]);
    expect(afterTree.looseBoards.map((board: { id: string }) => board.id)).toEqual([
      snapshot.board.id,
    ]);

    const opened = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: jar },
    });
    expect(opened.status).toBe(200);
    const body = await opened.json();
    expect(body.lists.map((list: { title: string; rank: number }) => [list.title, list.rank])).toEqual(
      snapshot.lists.map((list: { title: string; rank: number }) => [list.title, list.rank]),
    );
    expect(body.cards).toEqual([
      expect.objectContaining({ title: "Bolt", description: "そのまま", rank: card.rank }),
    ]);

    const again = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: jar },
    });
    expect((await again.json()).board.title).toBe("Kept");
  });

  it("copies an owned board with or without cards and refuses other people", async () => {
    const owen = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owen", password: "password1" }),
    });
    const jar = cookie(owen);
    const tree = await app.request("/api/workspaces", { headers: { cookie: jar } });
    const workspaceId = (await tree.json()).workspaces[0].id as string;
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Plain", workspaceId }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Bolt" }),
    });
    expect(cardRes.status).toBe(201);

    const copied = await app.request(`/api/boards/${snapshot.board.id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ workspaceId }),
    });
    expect(copied.status).toBe(201);
    const copy = await copied.json();
    expect(copy.board.id).not.toBe(snapshot.board.id);
    expect(copy.board).toMatchObject({
      title: "Plain の複製",
      isTemplate: false,
      isPublic: false,
    });
    expect(copy.lists.map((list: { title: string }) => list.title)).toEqual(
      snapshot.lists.map((list: { title: string }) => list.title),
    );
    expect(copy.cards.map((card: { title: string }) => card.title)).toEqual(["Bolt"]);

    const source = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: jar },
    });
    const sourceBody = await source.json();
    expect(sourceBody.board.title).toBe("Plain");
    expect(sourceBody.cards.map((card: { title: string }) => card.title)).toEqual(["Bolt"]);

    const listsOnly = await app.request(`/api/boards/${snapshot.board.id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ workspaceId, cards: false }),
    });
    expect(listsOnly.status).toBe(201);
    const empty = await listsOnly.json();
    expect(empty.lists.map((list: { title: string }) => list.title)).toEqual(
      snapshot.lists.map((list: { title: string }) => list.title),
    );
    expect(empty.cards).toEqual([]);

    const flagged = await app.request(`/api/boards/${snapshot.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(flagged.status).toBe(200);
    const pia = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "pia", password: "password1" }),
    });
    const piaJar = cookie(pia);
    const piaTree = await app.request("/api/workspaces", { headers: { cookie: piaJar } });
    const piaWorkspaceId = (await piaTree.json()).workspaces[0].id as string;
    const readable = await app.request(`/api/boards/${snapshot.board.id}`, {
      headers: { cookie: piaJar },
    });
    expect(readable.status).toBe(200);
    const denied = await app.request(`/api/boards/${snapshot.board.id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: piaJar },
      body: JSON.stringify({ workspaceId: piaWorkspaceId }),
    });
    expect(denied.status).toBe(404);
  });

  it("archives a card and restores it without deleting the row", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nell", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Drawer" }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Spare" }),
    });
    const card = await cardRes.json();
    const archived = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    expect((await archived.json()).archived).toBe(true);
    const hidden = await app.request(`/api/boards/${snapshot.board.id}/markdown`, {
      headers: { cookie: jar },
    });
    expect(await hidden.text()).not.toContain("Spare");
    const restored = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ archived: false }),
    });
    expect((await restored.json()).archived).toBe(false);
    const shown = await app.request(`/api/boards/${snapshot.board.id}/markdown`, {
      headers: { cookie: jar },
    });
    expect(await shown.text()).toContain("Spare");
  });

  it("copies a card onto another board and a list with its open cards", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "cleo", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Source" }),
    });
    const source = await created.json();
    const cardRes = await app.request(`/api/boards/${source.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({
        listId: source.lists[0].id,
        title: "Pattern",
        description: "Keep the jig",
      }),
    });
    const card = await cardRes.json();
    const hiddenRes = await app.request(`/api/boards/${source.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: source.lists[0].id, title: "Hidden" }),
    });
    const hidden = await hiddenRes.json();
    await app.request(`/api/boards/${source.board.id}/cards/${hidden.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ archived: true }),
    });
    const other = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Destination" }),
    });
    const destination = await other.json();
    const copiedCard = await app.request(`/api/boards/${source.board.id}/cards/${card.id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({
        targetBoardId: destination.board.id,
        targetListId: destination.lists[0].id,
        at: "start",
      }),
    });
    expect(copiedCard.status).toBe(201);
    const copy = await copiedCard.json();
    expect(copy).toMatchObject({
      title: "Pattern の複製",
      description: "Keep the jig",
      boardId: destination.board.id,
      listId: destination.lists[0].id,
      archived: false,
    });

    const copiedList = await app.request(
      `/api/boards/${source.board.id}/lists/${source.lists[0].id}/copy`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar },
        body: JSON.stringify({ targetBoardId: destination.board.id }),
      },
    );
    expect(copiedList.status).toBe(201);
    const listCopy = await copiedList.json();
    expect(listCopy.list.title).toBe("未着手 の複製");
    expect(listCopy.list.boardId).toBe(destination.board.id);
    expect(listCopy.cards.map((row: { title: string }) => row.title)).toEqual(["Pattern"]);

    const stranger = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "cleo2", password: "password1" }),
    });
    const denied = await app.request(`/api/boards/${source.board.id}/cards/${card.id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie(stranger) },
      body: JSON.stringify({ targetListId: destination.lists[0].id }),
    });
    expect(denied.status).toBe(404);
  });

  it("keeps a multiline title as one card and splits lines only when asked", async () => {
    expect(titlesFromInput("Plan\n\nBuild\n", "one")).toEqual(["Plan\n\nBuild"]);
    expect(titlesFromInput("Plan\r\n\r\nBuild\n", "many")).toEqual(["Plan", "Build"]);
    expect(titlesFromInput("   \n  ", "many")).toEqual([]);

    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "lines", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Lines" }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Plan\nBuild" }),
    });
    expect(cardRes.status).toBe(201);
    expect((await cardRes.json()).title).toBe("Plan\nBuild");
  });

  it("moves a card to the start and then the end of its list", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ends", password: "password1" }),
    });
    const jar = cookie(register);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Ends" }),
    });
    const snapshot = await created.json();
    const listId = snapshot.lists[0].id as string;
    const titles = ["Alpha", "Beta", "Gamma"];
    const made = [];
    for (const title of titles) {
      const res = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar },
        body: JSON.stringify({ listId, title }),
      });
      made.push(await res.json());
    }
    const toStart = await app.request(`/api/boards/${snapshot.board.id}/cards/${made[2].id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId, prevRank: null, nextRank: made[0].rank }),
    });
    expect(toStart.status).toBe(200);
    const afterStart = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    const startOrder = (await afterStart.json()).cards
      .filter((card: { listId: string }) => card.listId === listId)
      .sort((a: { rank: number }, b: { rank: number }) => a.rank - b.rank)
      .map((card: { title: string; rank: number }) => card);
    expect(startOrder.map((card: { title: string }) => card.title)).toEqual(["Gamma", "Alpha", "Beta"]);
    const last = startOrder[startOrder.length - 1];
    const toEnd = await app.request(`/api/boards/${snapshot.board.id}/cards/${made[2].id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId, prevRank: last.rank, nextRank: null }),
    });
    expect(toEnd.status).toBe(200);
    const afterEnd = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    const endOrder = (await afterEnd.json()).cards
      .filter((card: { listId: string }) => card.listId === listId)
      .sort((a: { rank: number }, b: { rank: number }) => a.rank - b.rank)
      .map((card: { title: string }) => card.title);
    expect(endOrder).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("replaces the signed-in user's password and keeps the session", async () => {
    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "lock", password: "password1" }),
    });
    const jar = cookie(register);
    const wrong = await app.request("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ currentPassword: "nope-nope", nextPassword: "password2" }),
    });
    expect(wrong.status).toBe(400);
    const short = await app.request("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ currentPassword: "password1", nextPassword: "short" }),
    });
    expect(short.status).toBe(400);
    const changed = await app.request("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ currentPassword: "password1", nextPassword: "password2" }),
    });
    expect(changed.status).toBe(200);
    const still = await app.request("/api/auth/me", { headers: { cookie: jar } });
    expect(still.status).toBe(200);
    const oldLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "lock", password: "password1" }),
    });
    expect(oldLogin.status).toBe(401);
    const nextLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "lock", password: "password2" }),
    });
    expect(nextLogin.status).toBe(200);
  });

  it("pushes a board rename to open viewers and hides it when unpublished", async () => {
    const ada = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada2", password: "password1" }),
    });
    const adaJar = cookie(ada);
    const adaId = (await ada.json()).id as string;
    const bob = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob2", password: "password1" }),
    });
    const bobJar = cookie(bob);
    const bobId = (await bob.json()).id as string;
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ title: "Lathe" }),
    });
    const boardId = (await created.json()).board.id as string;
    const published = await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(published.status).toBe(200);

    const owner = listen();
    const otherTab = listen();
    const guest = listen();
    joinBoard(boardId, owner.socket, adaId);
    joinBoard(boardId, otherTab.socket, adaId);
    joinBoard(boardId, guest.socket, bobId);

    const renamed = await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ title: "Mill" }),
    });
    expect(renamed.status).toBe(200);
    for (const viewer of [owner, otherTab, guest]) {
      const event = JSON.parse(viewer.messages.at(-1) ?? "{}") as {
        type?: string;
        payload?: { title?: string; isPublic?: boolean };
      };
      expect(event.type).toBe("board.updated");
      expect(event.payload).toMatchObject({ title: "Mill", isPublic: true });
      expect(viewer.closed()).toBe(0);
    }

    const hidden = await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ isPublic: false }),
    });
    expect(hidden.status).toBe(200);
    expect(guest.closed()).toBe(1);
    expect(owner.closed()).toBe(0);
    expect(otherTab.closed()).toBe(0);
    const denied = await app.request(`/api/boards/${boardId}`, { headers: { cookie: bobJar } });
    expect(denied.status).toBe(404);
    const guestWrite = await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: bobJar },
      body: JSON.stringify({ title: "Stolen", isPublic: true }),
    });
    expect(guestWrite.status).toBe(404);
    const kept = await app.request(`/api/boards/${boardId}`, { headers: { cookie: adaJar } });
    expect((await kept.json()).board).toMatchObject({ title: "Mill", isPublic: false });
    leaveBoard(boardId, owner.socket);
    leaveBoard(boardId, otherTab.socket);
  });

  it("lets an anonymous visitor read a public board and hides a private one", async () => {
    const ada = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada3", password: "password1" }),
    });
    const jar = cookie(ada);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Open" }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Shown" }),
    });
    expect(cardRes.status).toBe(201);
    const published = await app.request(`/api/boards/${snapshot.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(published.status).toBe(200);

    const list = await app.request("/api/boards/public");
    expect(list.status).toBe(200);
    expect((await list.json()).boards.map((board: { title: string }) => board.title)).toContain(
      "Open",
    );
    const seen = await app.request(`/api/boards/${snapshot.board.id}`);
    expect(seen.status).toBe(200);
    const body = await seen.json();
    expect(body.lists.map((item: { title: string }) => item.title)).toEqual(
      snapshot.lists.map((item: { title: string }) => item.title),
    );
    expect(body.cards.map((card: { title: string }) => card.title)).toEqual(["Shown"]);
    const again = await app.request(`/api/boards/${snapshot.board.id}`);
    expect(again.status).toBe(200);

    const write = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Nope" }),
    });
    expect(write.status).toBe(401);

    const hidden = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Closed" }),
    });
    const hiddenBody = await hidden.json();
    const privateId = hiddenBody.board.id as string;
    const secret = await app.request(`/api/boards/${privateId}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: hiddenBody.lists[0].id, title: "Secret" }),
    });
    expect(secret.status).toBe(201);
    const denied = await app.request(`/api/boards/${privateId}`);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("Secret");

    const withdrawn = await app.request(`/api/boards/${snapshot.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ isPublic: false }),
    });
    expect(withdrawn.status).toBe(200);
    const gone = await app.request(`/api/boards/${snapshot.board.id}`);
    expect(gone.status).toBe(404);
    const catalog = await app.request("/api/boards/public");
    expect((await catalog.json()).boards.map((board: { id: string }) => board.id)).not.toContain(
      snapshot.board.id,
    );
  });

  it("remembers one home board and leaves it in its workspace", async () => {
    const kim = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "kim", password: "password1" }),
    });
    const jar = cookie(kim);
    expect((await kim.json()).homeBoardId).toBeNull();
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Daily" }),
    });
    const snapshot = await created.json();
    const boardId = snapshot.board.id as string;
    const workspaceId = snapshot.board.workspaceId as string;
    const marked = await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ home: true }),
    });
    expect(marked.status).toBe(200);
    const me = await app.request("/api/auth/me", { headers: { cookie: jar } });
    expect((await me.json()).homeBoardId).toBe(boardId);
    const opened = await app.request(`/api/boards/${boardId}`, { headers: { cookie: jar } });
    expect((await opened.json()).home).toBe(true);
    const tree = await app.request("/api/workspaces", { headers: { cookie: jar } });
    const listed = await tree.json();
    expect(listed.homeBoardId).toBe(boardId);
    expect(listed.workspaces[0].id).toBe(workspaceId);
    expect(listed.workspaces[0].boards.map((board: { id: string }) => board.id)).toContain(boardId);

    const other = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Other", workspaceId }),
    });
    const otherId = (await other.json()).board.id as string;
    const replaced = await app.request(`/api/boards/${otherId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ home: true }),
    });
    expect(replaced.status).toBe(200);
    const after = await app.request("/api/auth/me", { headers: { cookie: jar } });
    expect((await after.json()).homeBoardId).toBe(otherId);
    const cleared = await app.request(`/api/boards/${otherId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ home: false }),
    });
    expect(cleared.status).toBe(200);
    const none = await app.request("/api/auth/me", { headers: { cookie: jar } });
    expect((await none.json()).homeBoardId).toBeNull();

    const stranger = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "kai", password: "password1" }),
    });
    const strangerJar = cookie(stranger);
    const denied = await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: strangerJar },
      body: JSON.stringify({ home: true }),
    });
    expect(denied.status).toBe(404);

    await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ home: true }),
    });
    await app.request("/api/auth/logout", { method: "POST", headers: { cookie: jar } });
    const logged = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "kim", password: "password1" }),
    });
    expect(logged.status).toBe(200);
    expect((await logged.json()).homeBoardId).toBe(boardId);
  });

  it("saves a card as a template and creates another card from it", async () => {
    const ira = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ira", password: "password1" }),
    });
    const jar = cookie(ira);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Patterns" }),
    });
    const snapshot = await created.json();
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[0].id, title: "Standup" }),
    });
    const card = await cardRes.json();
    const described = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ description: "毎朝" }),
    });
    expect(described.status).toBe(200);
    const saved = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}/template`, {
      method: "POST",
      headers: { cookie: jar },
    });
    expect(saved.status).toBe(201);
    const savedBody = await saved.json();
    expect(savedBody.template).toMatchObject({ title: "Standup", description: "毎朝" });
    expect(savedBody.card).toMatchObject({ id: card.id, title: "Standup", description: "毎朝" });
    const listed = await app.request("/api/card-templates", { headers: { cookie: jar } });
    expect((await listed.json()).templates).toEqual([
      expect.objectContaining({ id: savedBody.template.id, title: "Standup" }),
    ]);
    const made = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId: snapshot.lists[1].id, templateId: savedBody.template.id }),
    });
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({
      listId: snapshot.lists[1].id,
      title: "Standup",
      description: "毎朝",
    });
    const board = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    const titles = (await board.json()).cards.map((item: { title: string }) => item.title);
    expect(titles).toEqual(["Standup", "Standup"]);

    const stranger = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ivo", password: "password1" }),
    });
    const strangerJar = cookie(stranger);
    const own = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: strangerJar },
      body: JSON.stringify({ title: "Mine" }),
    });
    const ownBody = await own.json();
    const stolen = await app.request(`/api/boards/${ownBody.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: strangerJar },
      body: JSON.stringify({
        listId: ownBody.lists[0].id,
        templateId: savedBody.template.id,
      }),
    });
    expect(stolen.status).toBe(404);
    const theirs = await app.request("/api/card-templates", { headers: { cookie: strangerJar } });
    expect((await theirs.json()).templates).toEqual([]);
  });

  it("archives open cards with a list and restores only those", async () => {
    const nora = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nora", password: "password1" }),
    });
    const jar = cookie(nora);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Shelf" }),
    });
    const snapshot = await created.json();
    const listId = snapshot.lists[0].id as string;
    for (const title of ["One", "Two", "Three"]) {
      const res = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar },
        body: JSON.stringify({ listId, title }),
      });
      expect(res.status).toBe(201);
    }
    const held = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId, title: "Kept" }),
    });
    const kept = await held.json();
    const alone = await app.request(`/api/boards/${snapshot.board.id}/cards/${kept.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ archived: true }),
    });
    expect((await alone.json()).archivedWithList).toBe(false);

    const archived = await app.request(`/api/boards/${snapshot.board.id}/lists/${listId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    const hidden = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    const hiddenCards = (await hidden.json()).cards as Array<{
      title: string;
      archived: boolean;
      archivedWithList: boolean;
    }>;
    expect(hiddenCards.filter((card) => card.title !== "Kept").every((card) => card.archived && card.archivedWithList)).toBe(true);
    expect(hiddenCards.find((card) => card.title === "Kept")).toMatchObject({
      archived: true,
      archivedWithList: false,
    });

    const restored = await app.request(`/api/boards/${snapshot.board.id}/lists/${listId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ archived: false }),
    });
    expect(restored.status).toBe(200);
    const shown = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    const shownCards = (await shown.json()).cards as Array<{
      title: string;
      archived: boolean;
    }>;
    expect(shownCards.filter((card) => !card.archived).map((card) => card.title).sort()).toEqual([
      "One",
      "Three",
      "Two",
    ]);
    expect(shownCards.find((card) => card.title === "Kept")?.archived).toBe(true);
  });

  it("keeps an unsaved card draft apart from the saved card", async () => {
    const nora = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nora", password: "password1" }),
    });
    const jar = cookie(nora);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Notes", isPublic: true }),
    });
    const snapshot = await created.json();
    const listId = snapshot.lists[0].id as string;
    const cardRes = await app.request(`/api/boards/${snapshot.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId, title: "Cut plate", description: "saved body" }),
    });
    const card = await cardRes.json();
    const draft = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}/unsaved`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Cut plate", description: "rough notes" }),
    });
    expect(draft.status).toBe(200);
    const loaded = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    const body = await loaded.json();
    expect(body.cards.find((row: { id: string }) => row.id === card.id).description).toBe("saved body");
    expect(body.unsaved).toEqual([
      { cardId: card.id, title: "Cut plate", description: "rough notes" },
    ]);

    const published = await app.request(`/api/boards/${snapshot.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(published.status).toBe(200);

    const guest = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "guest", password: "password2" }),
    });
    const guestJar = cookie(guest);
    const theirs = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: guestJar } });
    expect((await theirs.json()).unsaved).toEqual([]);

    const same = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}/unsaved`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Cut plate", description: "saved body" }),
    });
    expect((await same.json()).unsaved).toBeNull();
    const cleared = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    expect((await cleared.json()).unsaved).toEqual([]);

    await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}/unsaved`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Cut plate", description: "rough notes" }),
    });
    const discarded = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}/unsaved`, {
      method: "DELETE",
      headers: { cookie: jar },
    });
    expect(discarded.status).toBe(200);
    const afterDiscard = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    const after = await afterDiscard.json();
    expect(after.unsaved).toEqual([]);
    expect(after.cards.find((row: { id: string }) => row.id === card.id).description).toBe("saved body");

    await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}/unsaved`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Cut plate", description: "rough notes" }),
    });
    const saved = await app.request(`/api/boards/${snapshot.board.id}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Cut plate", description: "final notes" }),
    });
    expect((await saved.json()).description).toBe("final notes");
    const afterSave = await app.request(`/api/boards/${snapshot.board.id}`, { headers: { cookie: jar } });
    const savedBody = await afterSave.json();
    expect(savedBody.unsaved).toEqual([]);
    expect(savedBody.cards.find((row: { id: string }) => row.id === card.id).description).toBe("final notes");
  });

  it("assigns a board key and keeps card numbers when the key changes", async () => {
    const nora = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nora", password: "password1" }),
    });
    const jar = cookie(nora);
    const first = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Development Team" }),
    });
    const dev = await first.json();
    expect(dev.board.key).toBe("DT");
    const second = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "Development Team" }),
    });
    expect((await second.json()).board.key).toBe("DT2");
    const plain = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ title: "作業" }),
    });
    expect((await plain.json()).board.key).toBe("BOARD");

    const listId = dev.lists[0].id as string;
    const one = await app.request(`/api/boards/${dev.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId, title: "Cut plate" }),
    });
    const two = await app.request(`/api/boards/${dev.board.id}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ listId, title: "Weld seam" }),
    });
    expect((await one.json()).number).toBe(1);
    expect((await two.json()).number).toBe(2);

    const renamed = await app.request(`/api/boards/${dev.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ key: "ops" }),
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).key).toBe("OPS");
    const loaded = await app.request(`/api/boards/${dev.board.id}`, { headers: { cookie: jar } });
    const cards = (await loaded.json()).cards as Array<{ title: string; number: number }>;
    expect(cards.find((card) => card.title === "Cut plate")?.number).toBe(1);
    expect(cards.find((card) => card.title === "Weld seam")?.number).toBe(2);

    const taken = await app.request(`/api/boards/${dev.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ key: "DT2" }),
    });
    expect(taken.status).toBe(400);
    const short = await app.request(`/api/boards/${dev.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ key: "A" }),
    });
    expect(short.status).toBe(400);
    const digit = await app.request(`/api/boards/${dev.board.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: jar },
      body: JSON.stringify({ key: "1DEV" }),
    });
    expect(digit.status).toBe(400);
  });

  it("does not send an unsaved draft to other viewers", async () => {
    const ada = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "password1" }),
    });
    const adaJar = cookie(ada);
    const adaId = (await ada.json()).id as string;
    const bob = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "password1" }),
    });
    const bobJar = cookie(bob);
    const bobId = (await bob.json()).id as string;
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ title: "Open" }),
    });
    const snapshot = await created.json();
    const boardId = snapshot.board.id as string;
    const listId = snapshot.lists[0].id as string;
    await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ isPublic: true }),
    });
    const cardRes = await app.request(`/api/boards/${boardId}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ listId, title: "Cut plate", description: "saved body" }),
    });
    const cardId = (await cardRes.json()).id as string;

    const owner = listen();
    const otherTab = listen();
    const guest = listen();
    const anon = listen();
    joinBoard(boardId, owner.socket, adaId);
    joinBoard(boardId, otherTab.socket, adaId);
    joinBoard(boardId, guest.socket, bobId);
    joinBoard(boardId, anon.socket, "");
    try {
      const draft = await app.request(`/api/boards/${boardId}/cards/${cardId}/unsaved`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: adaJar },
        body: JSON.stringify({ title: "Cut plate", description: "secret draft" }),
      });
      expect(draft.status).toBe(200);
      for (const viewer of [owner, otherTab]) {
        const event = JSON.parse(viewer.messages.at(-1) ?? "{}") as {
          type?: string;
          payload?: { description?: string };
        };
        expect(event.type).toBe("card.unsaved");
        expect(event.payload?.description).toBe("secret draft");
      }
      for (const viewer of [guest, anon]) {
        expect(viewer.messages.join("\n")).not.toContain("secret draft");
      }
      const bobView = await app.request(`/api/boards/${boardId}`, { headers: { cookie: bobJar } });
      const anonView = await app.request(`/api/boards/${boardId}`);
      expect((await bobView.json()).unsaved).toEqual([]);
      expect((await anonView.json()).unsaved).toEqual([]);

      const saved = await app.request(`/api/boards/${boardId}/cards/${cardId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: adaJar },
        body: JSON.stringify({ title: "Cut plate", description: "published body" }),
      });
      expect(saved.status).toBe(200);
      const seen = JSON.parse(guest.messages.at(-1) ?? "{}") as {
        type?: string;
        payload?: { description?: string };
      };
      expect(seen.type).toBe("card.upserted");
      expect(seen.payload?.description).toBe("published body");
      expect(guest.messages.join("\n")).not.toContain("secret draft");
      expect(anon.messages.join("\n")).not.toContain("secret draft");
    } finally {
      leaveBoard(boardId, owner.socket);
      leaveBoard(boardId, otherTab.socket);
      leaveBoard(boardId, guest.socket);
      leaveBoard(boardId, anon.socket);
    }
  });

  it("keeps a card vote with the caller and hides names when the question is private", async () => {
    const ada = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "password1" }),
    });
    const adaJar = cookie(ada);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ title: "Ballot" }),
    });
    const snapshot = await created.json();
    const boardId = snapshot.board.id as string;
    const listId = snapshot.lists[0].id as string;
    const made = await app.request(`/api/boards/${boardId}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ listId, title: "Ship" }),
    });
    const cardId = (await made.json()).id as string;
    const asked = await app.request(`/api/boards/${boardId}/cards/${cardId}/vote`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ question: "Ship it?", public: true }),
    });
    expect(asked.status).toBe(200);
    expect((await asked.json()).vote).toMatchObject({ question: "Ship it?", positive: 0, negative: 0 });

    const bob = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "password1" }),
    });
    const bobJar = cookie(bob);
    const hidden = await app.request(`/api/boards/${boardId}/cards/${cardId}/vote`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: bobJar },
      body: JSON.stringify({ choice: "positive" }),
    });
    expect(hidden.status).toBe(404);

    const published = await app.request(`/api/boards/${boardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ isPublic: true }),
    });
    expect(published.status).toBe(200);

    const adaSocket = listen();
    const bobSocket = listen();
    joinBoard(boardId, adaSocket.socket, (await (await app.request("/api/auth/me", { headers: { cookie: adaJar } })).json()).id);
    const bobUser = await (await app.request("/api/auth/me", { headers: { cookie: bobJar } })).json();
    joinBoard(boardId, bobSocket.socket, bobUser.id);
    try {
      const yes = await app.request(`/api/boards/${boardId}/cards/${cardId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adaJar },
        body: JSON.stringify({ choice: "positive", userId: bobUser.id }),
      });
      expect(yes.status).toBe(200);
      const yesBody = await yes.json();
      expect(yesBody.choice).toBe("positive");
      expect(yesBody.card.vote.positive).toBe(1);
      expect(yesBody.card.vote.positiveNames).toEqual(["ada"]);
      const adaEvent = JSON.parse(adaSocket.messages.at(-1) ?? "{}") as { type?: string };
      expect(adaEvent.type).toBe("card.voted");
      const bobEvent = JSON.parse(bobSocket.messages.at(-1) ?? "{}") as {
        type?: string;
        payload?: { vote?: { positive?: number; positiveNames?: string[] } };
      };
      expect(bobEvent.type).toBe("card.upserted");
      expect(bobEvent.payload?.vote?.positive).toBe(1);
      expect(bobSocket.messages.join("\n")).not.toContain("card.voted");

      const no = await app.request(`/api/boards/${boardId}/cards/${cardId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: bobJar },
        body: JSON.stringify({ choice: "negative" }),
      });
      expect((await no.json()).card.vote).toMatchObject({ positive: 1, negative: 1 });

      const again = await app.request(`/api/boards/${boardId}/cards/${cardId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adaJar },
        body: JSON.stringify({ choice: "positive" }),
      });
      const againBody = await again.json();
      expect(againBody.choice).toBeNull();
      expect(againBody.card.vote.positive).toBe(0);

      const adaView = await app.request(`/api/boards/${boardId}`, { headers: { cookie: adaJar } });
      expect((await adaView.json()).myVotes).toEqual([]);
      const bobView = await app.request(`/api/boards/${boardId}`, { headers: { cookie: bobJar } });
      expect((await bobView.json()).myVotes).toEqual([{ cardId, choice: "negative" }]);

      const quiet = await app.request(`/api/boards/${boardId}/cards/${cardId}/vote`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: adaJar },
        body: JSON.stringify({ question: "Ship it?", public: false }),
      });
      const quietBody = await quiet.json();
      expect(quietBody.vote.positiveNames).toEqual([]);
      expect(quietBody.vote.negativeNames).toEqual([]);
      expect(quietBody.vote.negative).toBe(1);

      const cleared = await app.request(`/api/boards/${boardId}/cards/${cardId}/vote`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: adaJar },
        body: JSON.stringify({ question: "  " }),
      });
      expect((await cleared.json()).vote).toBeNull();
      const after = await app.request(`/api/boards/${boardId}`, { headers: { cookie: bobJar } });
      expect((await after.json()).myVotes).toEqual([]);

      const anon = await app.request(`/api/boards/${boardId}/cards/${cardId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choice: "positive" }),
      });
      expect(anon.status).toBe(401);
    } finally {
      leaveBoard(boardId, adaSocket.socket);
      leaveBoard(boardId, bobSocket.socket);
    }
  });

  it("caps open cards across a WIP group without replacing each list limit", async () => {
    const ada = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "password1" }),
    });
    const adaJar = cookie(ada);
    const created = await app.request("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adaJar },
      body: JSON.stringify({ title: "Flow" }),
    });
    const snapshot = await created.json();
    const boardId = snapshot.board.id as string;
    const doing = snapshot.lists[1].id as string;
    const review = snapshot.lists[2].id as string;
    const headers = { "content-type": "application/json", cookie: adaJar };

    const tooSmall = await app.request(`/api/boards/${boardId}/wip-groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "thin", listIds: [doing], limit: 1 }),
    });
    expect(tooSmall.status).toBe(400);

    const added = await app.request(`/api/boards/${boardId}/wip-groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "進行", listIds: [doing, review], limit: 1 }),
    });
    expect(added.status).toBe(201);
    const groupId = (await added.json()).groups[0].id as string;

    const first = await app.request(`/api/boards/${boardId}/cards`, {
      method: "POST",
      headers,
      body: JSON.stringify({ listId: doing, title: "One" }),
    });
    expect(first.status).toBe(201);
    const cardId = (await first.json()).id as string;

    const blocked = await app.request(`/api/boards/${boardId}/cards`, {
      method: "POST",
      headers,
      body: JSON.stringify({ listId: review, title: "Two" }),
    });
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toEqual({ error: "仕掛かりの共通上限に達しています" });

    const shifted = await app.request(`/api/boards/${boardId}/cards/${cardId}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ listId: review, prevRank: null, nextRank: null }),
    });
    expect(shifted.status).toBe(200);

    const paused = await app.request(`/api/boards/${boardId}/wip-groups/${groupId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(paused.status).toBe(200);
    const second = await app.request(`/api/boards/${boardId}/cards`, {
      method: "POST",
      headers,
      body: JSON.stringify({ listId: doing, title: "Two" }),
    });
    expect(second.status).toBe(201);

    const own = await app.request(`/api/boards/${boardId}/lists/${doing}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ wipLimit: 1 }),
    });
    expect(own.status).toBe(200);
    const ownBlock = await app.request(`/api/boards/${boardId}/cards`, {
      method: "POST",
      headers,
      body: JSON.stringify({ listId: doing, title: "Three" }),
    });
    expect(ownBlock.status).toBe(400);
    expect(await ownBlock.json()).toEqual({ error: "WIP の上限に達しています" });

    const removed = await app.request(`/api/boards/${boardId}/wip-groups/${groupId}`, {
      method: "DELETE",
      headers: { cookie: adaJar },
    });
    expect(removed.status).toBe(200);
    expect((await removed.json()).groups).toEqual([]);
  });

  it("ranks near titles as duplicates and leaves distant or archived cards out", () => {
    const cards = [
      { id: "a", title: "Printer maintenance", listId: "l", description: "Replace the roller" },
      { id: "b", title: "Printer maintanance", listId: "l", description: "" },
      { id: "c", title: "予算会議", listId: "m", description: "" },
      { id: "d", title: "Buy paint", listId: "l", archived: true },
    ];
    const ranked = rankSimilarCards({ title: "Printer maintenance", description: "Replace the roller" }, cards, {
      excludeId: "a",
    });
    expect(ranked.map((card) => card.id)).toEqual(["b"]);
    expect(ranked[0]?.duplicate).toBe(true);
    const japanese = rankSimilarCards({ title: "予算の会議" }, [{ id: "c", title: "予算会議", listId: "m" }]);
    expect(japanese.map((card) => card.id)).toEqual(["c"]);
    expect(rankSimilarCards({ title: "Zebra" }, cards)).toEqual([]);
  });
});
