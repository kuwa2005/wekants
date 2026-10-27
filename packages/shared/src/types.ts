export type UserPublic = {
  id: string;
  username: string;
  homeBoardId: string | null;
};

export type Workspace = {
  id: string;
  title: string;
  rank: number;
  ownerId: string;
  starred: boolean;
};

export type Board = {
  id: string;
  title: string;
  archived: boolean;
  ownerId: string;
  workspaceId: string | null;
  rank: number;
  isTemplate: boolean;
  isPublic: boolean;
  key: string;
};

export type List = {
  id: string;
  boardId: string;
  title: string;
  rank: number;
  collapsed: boolean;
  width: "narrow" | "normal" | "wide";
  wipLimit: number | null;
  archived: boolean;
  color: "" | "rust" | "moss" | "rivet";
  cardEdit: "allow" | "deny";
};

export type CardTemplate = {
  id: string;
  title: string;
  description: string;
};

export type CardVote = {
  question: string;
  public: boolean;
  positive: number;
  negative: number;
  positiveNames: string[];
  negativeNames: string[];
};

export type MyVote = {
  cardId: string;
  choice: "positive" | "negative";
};

export type Card = {
  id: string;
  boardId: string;
  listId: string;
  title: string;
  description: string;
  rank: number;
  archived: boolean;
  archivedWithList: boolean;
  number: number;
  vote: CardVote | null;
};

export type UnsavedEdit = {
  cardId: string;
  title: string;
  description: string;
};

export type BoardSnapshot = {
  board: Board;
  lists: List[];
  cards: Card[];
  home?: boolean;
  unsaved?: UnsavedEdit[];
  myVotes?: MyVote[];
};

export type WorkspaceTree = {
  workspaces: Array<Workspace & { boards: Board[] }>;
  looseBoards: Board[];
  homeBoardId: string | null;
};

export type WsEvent =
  | { type: "board"; payload: BoardSnapshot; actorId: string }
  | { type: "card.moved"; payload: Card; actorId: string }
  | { type: "card.upserted"; payload: Card; actorId: string }
  | { type: "card.deleted"; payload: { id: string }; actorId: string }
  | { type: "list.upserted"; payload: List; actorId: string }
  | { type: "list.deleted"; payload: { id: string }; actorId: string }
  | { type: "workspace.moved"; payload: Board; actorId: string }
  | { type: "board.updated"; payload: Board; actorId: string }
  | { type: "card.unsaved"; payload: UnsavedEdit & { userId: string }; actorId: string }
  | { type: "card.unsavedCleared"; payload: { cardId: string; userId: string }; actorId: string }
  | {
      type: "card.voted";
      payload: { cardId: string; choice: "positive" | "negative" | null; userId: string };
      actorId: string;
    };

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
