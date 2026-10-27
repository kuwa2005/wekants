import type {
  Board,
  BoardSnapshot,
  Card,
  List,
  UserPublic,
  Workspace,
  WorkspaceTree,
} from "@wekants/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? res.statusText);
  }
  if (res.headers.get("content-type")?.includes("text/markdown")) {
    return (await res.text()) as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => request<UserPublic>("/api/auth/me"),
  register: (username: string, password: string) =>
    request<UserPublic>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<UserPublic>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  workspaces: () => request<WorkspaceTree>("/api/workspaces"),
  createWorkspace: (title: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  moveWorkspace: (
    workspaceId: string,
    body: { prevRank: number | null; nextRank: number | null },
  ) =>
    request<Workspace>(`/api/workspaces/${workspaceId}/move`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createBoard: (title: string, workspaceId?: string) =>
    request<BoardSnapshot>("/api/boards", {
      method: "POST",
      body: JSON.stringify({ title, workspaceId }),
    }),
  importMarkdownBoard: (markdown: string, workspaceId?: string) =>
    request<BoardSnapshot>("/api/boards", {
      method: "POST",
      body: JSON.stringify({ markdown, workspaceId }),
    }),
  board: (boardId: string) => request<BoardSnapshot>(`/api/boards/${boardId}`),
  exportMarkdown: async (boardId: string) => {
    const res = await fetch(`/api/boards/${boardId}/markdown`, { credentials: "include" });
    if (!res.ok) {
      throw new Error("書き出しに失敗しました");
    }
    return res.text();
  },
  createList: (boardId: string, title: string) =>
    request<List>(`/api/boards/${boardId}/lists`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  renameList: (boardId: string, listId: string, title: string) =>
    request<List>(`/api/boards/${boardId}/lists/${listId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  setListCollapsed: (boardId: string, listId: string, collapsed: boolean) =>
    request<List>(`/api/boards/${boardId}/lists/${listId}`, {
      method: "PATCH",
      body: JSON.stringify({ collapsed }),
    }),
  patchList: (
    boardId: string,
    listId: string,
    patch: Partial<Pick<List, "width" | "wipLimit" | "archived" | "color" | "cardEdit">>,
  ) =>
    request<List>(`/api/boards/${boardId}/lists/${listId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  createCard: (boardId: string, listId: string, title: string, description = "") =>
    request<Card>(`/api/boards/${boardId}/cards`, {
      method: "POST",
      body: JSON.stringify({ listId, title, description }),
    }),
  importMarkdownCard: (
    boardId: string,
    listId: string,
    markdown: string,
    filename: string,
  ) =>
    request<Card>(`/api/boards/${boardId}/cards`, {
      method: "POST",
      body: JSON.stringify({ listId, markdown, filename }),
    }),
  deleteCard: (boardId: string, cardId: string) =>
    request<{ ok: boolean }>(`/api/boards/${boardId}/cards/${cardId}`, { method: "DELETE" }),
  deleteList: (boardId: string, listId: string) =>
    request<{ ok: boolean }>(`/api/boards/${boardId}/lists/${listId}`, { method: "DELETE" }),
  moveList: (
    boardId: string,
    listId: string,
    body: { prevRank: number | null; nextRank: number | null },
  ) =>
    request<List>(`/api/boards/${boardId}/lists/${listId}/move`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchCard: (
    boardId: string,
    cardId: string,
    patch: { title?: string; description?: string },
  ) =>
    request<Card>(`/api/boards/${boardId}/cards/${cardId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  moveCard: (
    boardId: string,
    cardId: string,
    body: { listId: string; prevRank: number | null; nextRank: number | null },
  ) =>
    request<Card>(`/api/boards/${boardId}/cards/${cardId}/move`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  moveBoard: (
    boardId: string,
    body: { workspaceId: string; prevRank: number | null; nextRank: number | null },
  ) =>
    request<Board>(`/api/boards/${boardId}/move`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
