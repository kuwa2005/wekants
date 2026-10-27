import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Board, UserPublic, WorkspaceTree } from "@wekants/shared";
import { api } from "../api";

type Props = {
  user: UserPublic;
  onLogout: () => void;
};

function neighborRanks(
  boards: Board[],
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
    </Link>
  );
}

function WorkspaceColumn({
  workspace,
  boards,
  onImport,
  onCreateBoard,
}: {
  workspace: WorkspaceTree["workspaces"][number];
  boards: Board[];
  onImport: (markdown: string, name: string) => Promise<void>;
  onCreateBoard: (title: string) => Promise<void>;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `workspace:${workspace.id}`,
    data: { type: "workspace", workspaceId: workspace.id },
  });
  const [title, setTitle] = useState("");

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
      className={isOver ? "workspace over" : "workspace"}
      data-workspace-id={workspace.id}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={onDropFile}
    >
      <h2>{workspace.title}</h2>
      <div ref={setNodeRef} className="workspace-boards">
        <SortableContext items={boards.map((board) => board.id)} strategy={rectSortingStrategy}>
          {boards.map((board) => (
            <BoardTicket key={board.id} board={board} />
          ))}
        </SortableContext>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!title.trim()) {
            return;
          }
          await onCreateBoard(title.trim());
          setTitle("");
        }}
      >
        <input
          aria-label={`${workspace.title} の新しいボード`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新しいボード"
        />
        <button type="submit">+</button>
      </form>
      <p className="hint">.md を落とすとボードになります</p>
    </section>
  );
}

export function BoardsPage({ user, onLogout }: Props) {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [workspaceTitle, setWorkspaceTitle] = useState("");
  const navigate = useNavigate();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  async function reload() {
    setTree(await api.workspaces());
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
      {/* ワークスペースの並び替えは新規実装。legacy WeKan の DnD は移植しない。 */}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="bays">
          {tree.workspaces.map((workspace) => (
            <WorkspaceColumn
              key={workspace.id}
              workspace={workspace}
              boards={workspace.boards.slice().sort((a, b) => a.rank - b.rank)}
              onCreateBoard={async (title) => {
                const snapshot = await api.createBoard(title, workspace.id);
                navigate(`/b/${snapshot.board.id}`);
              }}
              onImport={async (markdown) => {
                const snapshot = await api.importMarkdownBoard(markdown, workspace.id);
                navigate(`/b/${snapshot.board.id}`);
              }}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
