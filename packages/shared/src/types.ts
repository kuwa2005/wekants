export type UserPublic = {
  id: string;
  username: string;
};

export type Workspace = {
  id: string;
  title: string;
  rank: number;
  ownerId: string;
};

export type Board = {
  id: string;
  title: string;
  archived: boolean;
  ownerId: string;
  workspaceId: string;
  rank: number;
};

export type List = {
  id: string;
  boardId: string;
  title: string;
  rank: number;
};

export type Card = {
  id: string;
  boardId: string;
  listId: string;
  title: string;
  description: string;
  rank: number;
};

export type BoardSnapshot = {
  board: Board;
  lists: List[];
  cards: Card[];
};

export type WorkspaceTree = {
  workspaces: Array<Workspace & { boards: Board[] }>;
};

export type WsEvent =
  | { type: "board"; payload: BoardSnapshot; actorId: string }
  | { type: "card.moved"; payload: Card; actorId: string }
  | { type: "card.upserted"; payload: Card; actorId: string }
  | { type: "list.upserted"; payload: List; actorId: string }
  | { type: "workspace.moved"; payload: Board; actorId: string };

export type MoveCardBody = {
  listId: string;
  prevRank: number | null;
  nextRank: number | null;
};

export type MoveBoardBody = {
  workspaceId: string;
  prevRank: number | null;
  nextRank: number | null;
};
