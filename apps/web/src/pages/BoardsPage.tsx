import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Board, TitleBatch, UserPublic, WorkspaceTree } from "@wekants/shared";
import { titlesFromInput } from "@wekants/shared";
import { api } from "../api";
import { LineBatch } from "../LineBatch";

type Props = {
  user: UserPublic;
  onLogout: () => void;
};

function neighborRanks(
  boards: Array<{ id: string; rank: number }>,
  movingId: string,
  beforeId: string | null,
): { prevRank: number | null; nextRank: number | null } {
  const others = boards
    .filter((board) => board.id !== movingId)
    .slice()
    .sort((a, b) => a.rank - b.rank);
  if (!beforeId) {
    const last = others.at(-1);
    return { prevRank: last?.rank ?? null, nextRank: null };
  }
  const index = others.findIndex((board) => board.id === beforeId);
  const prev = index > 0 ? others[index - 1] : undefined;
  const next = others[index];
  return { prevRank: prev?.rank ?? null, nextRank: next?.rank ?? null };
}

function BoardTicket({ board }: { board: Board }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: board.id,
      data: { type: "board", workspaceId: board.workspaceId },
    });
  return (
    <Link
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "board-ticket dragging" : "board-ticket"}
      data-board-id={board.id}
      to={`/b/${board.id}`}
      {...attributes}
      {...listeners}
      role="link"
    >
      {board.title}
      {board.isTemplate || board.isPublic ? (
        <span className="marks">
          {board.isTemplate ? "雛形" : ""}
          {board.isTemplate && board.isPublic ? " · " : ""}
          {board.isPublic ? "公開" : ""}
        </span>
      ) : null}
    </Link>
  );
}

function WorkspaceColumn({
  workspace,
  boards,
  onImport,
  onCreateBoard,
  onRename,
  onStar,
  onDelete,
  onCopy,
}: {
  workspace: WorkspaceTree["workspaces"][number];
  boards: Board[];
  onImport: (markdown: string, name: string) => Promise<void>;
  onCreateBoard: (titles: string[]) => Promise<void>;
  onRename: (title: string) => Promise<void>;
  onStar: (starred: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
  onCopy: (boardId: string) => Promise<void>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setBayRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `bay:${workspace.id}`,
    data: { type: "workspace-column", workspaceId: workspace.id },
  });
  const { setNodeRef, isOver } = useDroppable({
    id: `workspace:${workspace.id}`,
    data: { type: "workspace", workspaceId: workspace.id },
  });
  const [title, setTitle] = useState("");
  const [boardBatch, setBoardBatch] = useState<TitleBatch>("one");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(workspace.title);
  const [page, setPage] = useState(0);
  const skipCommit = useRef(false);
  const pageSize = 6;
  useEffect(() => {
    setPage(0);
  }, [boards.length]);
  const pageCount = Math.max(1, Math.ceil(boards.length / pageSize));
  const shown = boards.slice(page * pageSize, page * pageSize + pageSize);

  async function onDropFile(event: React.DragEvent) {
    const file = event.dataTransfer.files[0];
    if (!file || !file.name.endsWith(".md")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    await onImport(await file.text(), file.name);
  }

  return (
    <section
      ref={setBayRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "workspace dragging" : isOver ? "workspace over" : "workspace"}
      data-workspace-id={workspace.id}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={onDropFile}
    >
      <div className="list-head">
        <button
          type="button"
          className="grip"
          {...attributes}
          {...listeners}
          aria-label={`${workspace.title} を移動`}
        >
          移動
        </button>
        {renaming ? (
          <input
            className="list-title"
            aria-label="ワークスペース名"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (skipCommit.current) {
                skipCommit.current = false;
                setDraft(workspace.title);
                setRenaming(false);
                return;
              }
              const next = draft.trim();
              setRenaming(false);
              if (!next || next === workspace.title) {
                setDraft(workspace.title);
                return;
              }
              void onRename(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                skipCommit.current = true;
                event.currentTarget.blur();
              }
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="list-title"
            role="heading"
            aria-level={2}
            aria-label={`${workspace.title} の名前を変更`}
            onClick={() => {
              setDraft(workspace.title);
              setRenaming(true);
            }}
          >
            {workspace.title}
          </button>
        )}
        <button
          type="button"
          className="fold"
          aria-label={workspace.starred ? `${workspace.title} の星を外す` : `${workspace.title} を星付きにする`}
          onClick={() => void onStar(!workspace.starred)}
        >
          {workspace.starred ? "星付き" : "星"}
        </button>
        <button
          type="button"
          className="danger"
          aria-label={`${workspace.title} を削除`}
          onClick={() => {
            if (window.confirm(`「${workspace.title}」と中のボードを削除しますか？`)) {
              void onDelete();
            }
          }}
        >
          削除
        </button>
      </div>
      <div ref={setNodeRef} className="workspace-boards">
        <SortableContext items={shown.map((board) => board.id)} strategy={rectSortingStrategy}>
          {shown.map((board) => (
            <div key={board.id} className="ticket-row">
              <BoardTicket board={board} />
              {board.isTemplate ? (
                <button type="button" className="ghost" onClick={() => void onCopy(board.id)}>
                  複製
                </button>
              ) : null}
            </div>
          ))}
        </SortableContext>
      </div>
      {boards.length > pageSize ? (
        <div className="pager">
          <button type="button" className="ghost" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>
            前へ
          </button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((current) => current + 1)}
          >
            次へ
          </button>
        </div>
      ) : null}
      <form
        className="batch"
        onSubmit={async (event) => {
          event.preventDefault();
          const source = title;
          const titles = titlesFromInput(source, boardBatch);
          if (titles.length === 0) {
            return;
          }
          await onCreateBoard(titles);
          setTitle((current) => (current === source ? "" : current));
        }}
      >
        <textarea
          aria-label={`${workspace.title} の新しいボード`}
          value={title}
          rows={2}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新しいボード"
        />
        <LineBatch
          name={`boards-${workspace.id}`}
          value={boardBatch}
          onChange={setBoardBatch}
          oneLabel="1つのボード"
          manyLabel="複数のボード"
        />
        <button type="submit">+</button>
      </form>
      <p className="hint">.md を落とすとボードになります</p>
    </section>
  );
}

export function BoardsPage({ user, onLogout }: Props) {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [publicBoards, setPublicBoards] = useState<Board[]>([]);
  const [query, setQuery] = useState("");
  const [workspaceTitle, setWorkspaceTitle] = useState("");
  const navigate = useNavigate();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  async function reload() {
    const [next, published] = await Promise.all([api.workspaces(), api.publicBoards()]);
    setTree(next);
    setPublicBoards(published.boards);
  }

  useEffect(() => {
    reload().catch(() => setTree({ workspaces: [] }));
  }, []);

  async function addWorkspace(event: FormEvent) {
    event.preventDefault();
    await api.createWorkspace(workspaceTitle);
    setWorkspaceTitle("");
    await reload();
  }

  async function onDragEnd(event: DragEndEvent) {
    if (!tree || !event.over) {
      return;
    }
    if (event.active.data.current?.type === "workspace-column") {
      const movingId = String(event.active.data.current.workspaceId ?? "");
      const overId = String(event.over.id);
      let beforeId: string | null = null;
      if (overId.startsWith("bay:") || overId.startsWith("workspace:")) {
        beforeId = overId.slice(overId.indexOf(":") + 1);
      } else {
        beforeId =
          tree.workspaces.flatMap((space) => space.boards).find((board) => board.id === overId)
            ?.workspaceId ?? null;
      }
      if (!beforeId || beforeId === movingId) {
        return;
      }
      const { prevRank, nextRank } = neighborRanks(tree.workspaces, movingId, beforeId);
      await api.moveWorkspace(movingId, { prevRank, nextRank });
      await reload();
      return;
    }
    const boardId = String(event.active.id);
    const moving = tree.workspaces.flatMap((space) => space.boards).find((board) => board.id === boardId);
    if (!moving) {
      return;
    }
    const overId = String(event.over.id);
    let workspaceId = moving.workspaceId;
    let beforeId: string | null = null;
    if (overId.startsWith("workspace:")) {
      workspaceId = overId.slice("workspace:".length);
    } else {
      const overBoard = tree.workspaces
        .flatMap((space) => space.boards)
        .find((board) => board.id === overId);
      if (!overBoard) {
        return;
      }
      workspaceId = overBoard.workspaceId;
      beforeId = overBoard.id === boardId ? null : overBoard.id;
    }
    const target = tree.workspaces.find((space) => space.id === workspaceId)?.boards ?? [];
    const { prevRank, nextRank } = neighborRanks(target, boardId, beforeId);
    await api.moveBoard(boardId, { workspaceId, prevRank, nextRank });
    await reload();
  }

  async function logout() {
    await api.logout();
    onLogout();
  }

  if (!tree) {
    return <div className="gate">読み込んでいます…</div>;
  }

  return (
    <div className="shell">
      <header className="rail">
        <h1>wekants</h1>
        <span>{user.username}</span>
        <Link className="ghost" to="/password">
          パスワード
        </Link>
        <button type="button" onClick={logout}>
          出る
        </button>
      </header>
      <form className="composer" onSubmit={addWorkspace}>
        <input
          name="workspaceTitle"
          placeholder="新しいワークスペース"
          value={workspaceTitle}
          onChange={(e) => setWorkspaceTitle(e.target.value)}
        />
        <button type="submit">ワークスペースを追加</button>
      </form>
      <input
        className="search"
        aria-label="ボードを検索"
        placeholder="ボードを検索"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {/* ワークスペースの並び替えは新規実装。legacy WeKan の DnD は移植しない。 */}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext
          items={tree.workspaces.map((workspace) => `bay:${workspace.id}`)}
          strategy={horizontalListSortingStrategy}
        >
        <div className="bays">
          {tree.workspaces.map((workspace) => (
            <WorkspaceColumn
              key={workspace.id}
              workspace={workspace}
              boards={workspace.boards
                .filter((board) => {
                  const needle = query.trim().toLowerCase();
                  return !needle || board.title.toLowerCase().includes(needle);
                })
                .slice()
                .sort((a, b) => a.rank - b.rank)}
              onCreateBoard={async (titles) => {
                let lastId = "";
                for (const title of titles) {
                  const snapshot = await api.createBoard(title, workspace.id);
                  lastId = snapshot.board.id;
                }
                if (lastId) {
                  navigate(`/b/${lastId}`);
                }
              }}
              onImport={async (markdown) => {
                const snapshot = await api.importMarkdownBoard(markdown, workspace.id);
                navigate(`/b/${snapshot.board.id}`);
              }}
              onRename={async (title) => {
                await api.patchWorkspace(workspace.id, { title });
                await reload();
              }}
              onStar={async (starred) => {
                await api.patchWorkspace(workspace.id, { starred });
                await reload();
              }}
              onDelete={async () => {
                await api.deleteWorkspace(workspace.id);
                await reload();
              }}
              onCopy={async (boardId) => {
                const snapshot = await api.copyBoard(boardId, workspace.id);
                navigate(`/b/${snapshot.board.id}`);
              }}
            />
          ))}
        </div>
        </SortableContext>
      </DndContext>
      {publicBoards.length > 0 ? (
        <section className="public-boards">
          <h2>公開ボード</h2>
          <div className="workspace-boards">
            {publicBoards.map((board) => (
              <Link key={board.id} className="board-ticket" to={`/b/${board.id}`}>
                {board.title}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
