import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useSortable } from "@dnd-kit/sortable";
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { BoardSnapshot, Card, List, TitleBatch, UserPublic, WsEvent } from "@wekants/shared";
import { titlesFromInput } from "@wekants/shared";
import { api } from "../api";
import { LineBatch } from "../LineBatch";
import { Markdown } from "../Markdown";

type Props = {
  user: UserPublic;
  onLogout: () => void;
};

function upsertById<T extends { id: string }>(rows: T[], incoming: T[]): T[] {
  const next = [...rows];
  for (const row of incoming) {
    const index = next.findIndex((item) => item.id === row.id);
    if (index < 0) {
      next.push(row);
    } else {
      next[index] = row;
    }
  }
  return next;
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) {
      return false;
    }
    seen.add(row.id);
    return true;
  });
}

function neighborRanks(
  listCards: Array<{ id: string; rank: number }>,
  movingId: string,
  beforeId: string | null,
): { prevRank: number | null; nextRank: number | null } {
  const others = listCards
    .filter((card) => card.id !== movingId)
    .slice()
    .sort((a, b) => a.rank - b.rank);
  if (!beforeId) {
    const last = others.at(-1);
    return { prevRank: last?.rank ?? null, nextRank: null };
  }
  const index = others.findIndex((card) => card.id === beforeId);
  const prev = index > 0 ? others[index - 1] : undefined;
  const next = others[index];
  return { prevRank: prev?.rank ?? null, nextRank: next?.rank ?? null };
}

function Ticket({ card, onOpen }: { card: Card; onOpen: (card: Card) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id, data: { type: "card", listId: card.listId } });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <article
      ref={setNodeRef}
      style={style}
      className={isDragging ? "ticket dragging" : "ticket"}
      data-card-id={card.id}
      onDoubleClick={() => onOpen(card)}
      {...attributes}
      {...listeners}
    >
      <h3>{card.title}</h3>
      {card.description ? <Markdown source={card.description} /> : null}
    </article>
  );
}

function ListColumn({
  list,
  cards,
  onAdd,
  onOpen,
  onImportMd,
  onDelete,
  onRename,
  onToggle,
  onPatch,
  onCopy,
  canEdit,
  boards,
  boardId,
}: {
  list: List;
  cards: Card[];
  onAdd: (title: string) => Promise<void>;
  onOpen: (card: Card) => void;
  onImportMd: (markdown: string, filename: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onRename: (title: string) => Promise<void>;
  onToggle: (collapsed: boolean) => Promise<void>;
  onPatch: (patch: Partial<Pick<List, "width" | "wipLimit" | "archived" | "color" | "cardEdit">>) => Promise<void>;
  onCopy: (targetBoardId: string) => Promise<void>;
  canEdit: boolean;
  boards: Array<{ id: string; title: string }>;
  boardId: string;
}) {
  const [title, setTitle] = useState("");
  const [cardBatch, setCardBatch] = useState<TitleBatch>("one");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(list.title);
  const [wipDraft, setWipDraft] = useState(list.wipLimit == null ? "" : String(list.wipLimit));
  const [copyBoardId, setCopyBoardId] = useState(boardId);
  const skipCommit = useRef(false);
  useEffect(() => {
    setWipDraft(list.wipLimit == null ? "" : String(list.wipLimit));
  }, [list.wipLimit]);
  const {
    attributes,
    listeners,
    setNodeRef: setColumnRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `column:${list.id}`,
    data: { type: "list-column", listId: list.id },
  });
  const { setNodeRef } = useDroppable({
    id: `list:${list.id}`,
    data: { type: "list", listId: list.id },
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const source = title;
    const titles = titlesFromInput(source, cardBatch);
    if (titles.length === 0) {
      return;
    }
    let done = 0;
    try {
      for (const next of titles) {
        await onAdd(next);
        done += 1;
      }
      setTitle((current) => (current === source ? "" : current));
    } catch {
      setTitle((current) => (current === source ? (cardBatch === "many" ? titles.slice(done).join("\n") : source) : current));
    }
  }

  return (
    <section
      ref={setColumnRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        "list",
        list.collapsed ? "collapsed" : "",
        list.width === "narrow" ? "narrow" : "",
        list.width === "wide" ? "wide" : "",
        list.color ? `color-${list.color}` : "",
        list.wipLimit != null && cards.length >= list.wipLimit ? "wip-full" : "",
        isDragging ? "dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-list-id={list.id}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={async (event) => {
        const file = event.dataTransfer.files[0];
        if (!file || !file.name.endsWith(".md")) {
          return;
        }
        event.preventDefault();
        await onImportMd(await file.text(), file.name);
      }}
    >
      <div className="list-head">
        {canEdit ? (
        <button
          type="button"
          className="grip"
          {...attributes}
          {...listeners}
          aria-label={`${list.title} を移動`}
        >
          移動
        </button>
        ) : null}
        {!canEdit ? (
          <h2>{list.title}</h2>
        ) : renaming ? (
          <input
            className="list-title"
            aria-label="リスト名"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (skipCommit.current) {
                skipCommit.current = false;
                setDraft(list.title);
                setRenaming(false);
                return;
              }
              const next = draft.trim();
              setRenaming(false);
              if (!next || next === list.title) {
                setDraft(list.title);
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
            aria-label={`${list.title} の名前を変更`}
            onClick={() => {
              setDraft(list.title);
              setRenaming(true);
            }}
          >
            {list.title}
          </button>
        )}
        {canEdit ? (
        <>
        <button
          type="button"
          className="fold"
          aria-label={list.collapsed ? `${list.title} を開く` : `${list.title} を折りたたむ`}
          onClick={() => void onToggle(!list.collapsed)}
        >
          {list.collapsed ? "開く" : "畳む"}
        </button>
        <button
          type="button"
          className="danger"
          aria-label={`${list.title} を削除`}
          onClick={() => {
            if (window.confirm(`「${list.title}」とそのカードを削除しますか？`)) {
              void onDelete();
            }
          }}
        >
          削除
        </button>
        </>
        ) : null}
      </div>
      {list.collapsed ? null : (
      <>
      {canEdit ? (
      <div className="list-tools">
        <button
          type="button"
          className="fold"
          aria-label={`${list.title} の幅`}
          onClick={() => {
            const order = ["narrow", "normal", "wide"] as const;
            const next = order[(order.indexOf(list.width) + 1) % order.length] ?? "normal";
            void onPatch({ width: next });
          }}
        >
          {list.width === "narrow" ? "狭" : list.width === "wide" ? "広" : "普"}
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const raw = wipDraft.trim();
            void onPatch({ wipLimit: raw === "" ? null : Number(raw) });
          }}
        >
          <input
            aria-label={`${list.title} の WIP`}
            inputMode="numeric"
            placeholder="WIP"
            value={wipDraft}
            onChange={(event) => setWipDraft(event.target.value)}
          />
        </form>
        <button
          type="button"
          className="fold"
          aria-label={`${list.title} の色`}
          onClick={() => {
            const order = ["", "rust", "moss", "rivet"] as const;
            const next = order[(order.indexOf(list.color) + 1) % order.length] ?? "";
            void onPatch({ color: next });
          }}
        >
          色
        </button>
        <button
          type="button"
          className="fold"
          aria-label={`${list.title} の編集`}
          onClick={() => void onPatch({ cardEdit: list.cardEdit === "deny" ? "allow" : "deny" })}
        >
          {list.cardEdit === "deny" ? "編集不可" : "編集可"}
        </button>
        <button
          type="button"
          className="danger"
          aria-label={`${list.title} を保管`}
          onClick={() => {
            if (window.confirm(`「${list.title}」を保管しますか？`)) {
              void onPatch({ archived: true });
            }
          }}
        >
          保管
        </button>
        {boards.length > 1 ? (
          <select
            aria-label={`${list.title} の複製先`}
            value={copyBoardId}
            onChange={(event) => setCopyBoardId(event.target.value)}
          >
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.title}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="fold"
          aria-label={`${list.title} を複製`}
          onClick={() => void onCopy(copyBoardId)}
        >
          複製
        </button>
      </div>
      ) : null}
      <div ref={setNodeRef} className="list-cards">
        <SortableContext
          items={cards.map((card) => card.id)}
          strategy={verticalListSortingStrategy}
        >
          {cards.map((card) => (
            <Ticket key={card.id} card={card} onOpen={onOpen} />
          ))}
        </SortableContext>
      </div>
      {!canEdit ? null : list.cardEdit === "deny" ? (
        <p className="hint">このリストは編集できません</p>
      ) : list.wipLimit != null && cards.length >= list.wipLimit ? (
        <p className="hint">WIP の上限です</p>
      ) : (
      <form className="batch" onSubmit={submit}>
        <textarea
          aria-label={`${list.title} の新しいカード`}
          value={title}
          rows={2}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新しいカード"
        />
        <LineBatch
          name={`cards-${list.id}`}
          value={cardBatch}
          onChange={setCardBatch}
          oneLabel="1枚のカード"
          manyLabel="複数のカード"
        />
        <button type="submit">+</button>
      </form>
      )}
      {!canEdit || list.cardEdit === "deny" ? null : (
      <label className="hint">
        Markdown を取り込む
        <input
          type="file"
          accept=".md,text/markdown"
          aria-label={`${list.title} に Markdown を取り込む`}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) {
              return;
            }
            await onImportMd(await file.text(), file.name);
          }}
        />
      </label>
      )}
      </>
      )}
    </section>
  );
}

export function BoardPage({ user, onLogout }: Props) {
  const { boardId = "" } = useParams();
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [missing, setMissing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const skipTitle = useRef(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [listTitle, setListTitle] = useState("");
  const [listBatch, setListBatch] = useState<TitleBatch>("one");
  const [copyBoardId, setCopyBoardId] = useState(boardId);
  const [copyListId, setCopyListId] = useState("");
  const [ownedBoards, setOwnedBoards] = useState<Array<{ id: string; title: string }>>([]);
  const [foreignLists, setForeignLists] = useState<List[]>([]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    setMissing(false);
    api
      .board(boardId)
      .then((next) => {
        setSnapshot(next);
        setMissing(false);
      })
      .catch(() => {
        setSnapshot(null);
        setMissing(true);
      });
  }, [boardId]);

  useEffect(() => {
    api
      .workspaces()
      .then((tree) => {
        setOwnedBoards(
          tree.workspaces.flatMap((space) =>
            space.boards.map((board) => ({ id: board.id, title: board.title })),
          ),
        );
      })
      .catch(() => setOwnedBoards([]));
  }, [boardId]);

  useEffect(() => {
    if (!editing || copyBoardId === boardId) {
      return;
    }
    api
      .board(copyBoardId)
      .then((next) => {
        const open = next.lists.filter((list) => !list.archived);
        setForeignLists(open);
        setCopyListId((current) => (open.some((list) => list.id === current) ? current : (open[0]?.id ?? "")));
      })
      .catch(() => setForeignLists([]));
  }, [copyBoardId, boardId, editing]);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${protocol}://${location.host}/ws?boardId=${encodeURIComponent(boardId)}`,
    );
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as WsEvent;
      if (event.type === "board.updated") {
        if (!event.payload.isPublic && event.payload.ownerId !== user.id) {
          setMissing(true);
          setSnapshot(null);
          return;
        }
        setSnapshot((current) => (current ? { ...current, board: event.payload } : current));
        return;
      }
      if (event.type === "card.deleted") {
        setEditing((current) => (current?.id === event.payload.id ? null : current));
      }
      if (event.type === "list.deleted") {
        setEditing((current) => (current?.listId === event.payload.id ? null : current));
      }
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        if (event.actorId === user.id && event.type !== "card.moved") {
          if (event.type === "card.upserted") {
            return { ...current, cards: upsertById(current.cards, [event.payload]) };
          }
          if (event.type === "list.upserted") {
            return { ...current, lists: upsertById(current.lists, [event.payload]) };
          }
          return current;
        }
        if (event.type === "board") {
          return event.payload;
        }
        if (event.type === "list.upserted") {
          const lists = current.lists.some((list) => list.id === event.payload.id)
            ? current.lists.map((list) =>
                list.id === event.payload.id ? event.payload : list,
              )
            : [...current.lists, event.payload];
          return { ...current, lists };
        }
        if (event.type === "list.deleted") {
          return {
            ...current,
            lists: current.lists.filter((list) => list.id !== event.payload.id),
            cards: current.cards.filter((card) => card.listId !== event.payload.id),
          };
        }
        if (event.type === "card.deleted") {
          return {
            ...current,
            cards: current.cards.filter((card) => card.id !== event.payload.id),
          };
        }
        if (event.type === "workspace.moved") {
          return current;
        }
        const cards = current.cards.some((card) => card.id === event.payload.id)
          ? current.cards.map((card) =>
              card.id === event.payload.id ? event.payload : card,
            )
          : [...current.cards, event.payload];
        return { ...current, cards };
      });
    };
    return () => socket.close();
  }, [boardId, user.id]);

  const lists = useMemo(
    () =>
      snapshot
        ? uniqueById(snapshot.lists)
            .filter((list) => !list.archived)
            .slice()
            .sort((a, b) => a.rank - b.rank)
        : [],
    [snapshot],
  );
  const archivedCards = useMemo(
    () => (snapshot ? uniqueById(snapshot.cards).filter((card) => card.archived) : []),
    [snapshot],
  );
  const archivedLists = useMemo(
    () =>
      snapshot
        ? snapshot.lists.filter((list) => list.archived).slice().sort((a, b) => a.rank - b.rank)
        : [],
    [snapshot],
  );

  function applyList(updated: List) {
    setSnapshot((current) =>
      current
        ? { ...current, lists: current.lists.map((row) => (row.id === updated.id ? updated : row)) }
        : current,
    );
  }

  async function addList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const source = listTitle;
    const titles = titlesFromInput(source, listBatch);
    if (titles.length === 0) {
      return;
    }
    let done = 0;
    try {
      for (const next of titles) {
        const list = await api.createList(boardId, next);
        setSnapshot((current) =>
          current ? { ...current, lists: upsertById(current.lists, [list]) } : current,
        );
        done += 1;
      }
      setListTitle((current) => (current === source ? "" : current));
    } catch {
      setListTitle((current) =>
        current === source ? (listBatch === "many" ? titles.slice(done).join("\n") : source) : current,
      );
    }
  }

  async function addCard(listId: string, title: string) {
    const card = await api.createCard(boardId, listId, title);
    setSnapshot((current) =>
      current ? { ...current, cards: upsertById(current.cards, [card]) } : current,
    );
  }

  async function onDragEnd(event: DragEndEvent) {
    if (!snapshot || !event.over || snapshot.board.ownerId !== user.id) {
      return;
    }
    const activeType = event.active.data.current?.type;
    if (activeType === "list-column") {
      const movingListId = String(event.active.data.current?.listId ?? "");
      const overId = String(event.over.id);
      let beforeId: string | null = null;
      if (overId.startsWith("column:") || overId.startsWith("list:")) {
        beforeId = overId.slice(overId.indexOf(":") + 1);
      } else {
        beforeId = snapshot.cards.find((card) => card.id === overId)?.listId ?? null;
      }
      if (!beforeId || beforeId === movingListId) {
        return;
      }
      const targetList = snapshot.lists.find((list) => list.id === beforeId);
      if (targetList?.archived) {
        return;
      }
      const { prevRank, nextRank } = neighborRanks(snapshot.lists, movingListId, beforeId);
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          lists: current.lists.map((list) =>
            list.id === movingListId ? { ...list, rank: (prevRank ?? 0) + 1 } : list,
          ),
        };
      });
      const updated = await api.moveList(boardId, movingListId, { prevRank, nextRank });
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          lists: current.lists.map((list) => (list.id === movingListId ? updated : list)),
        };
      });
      return;
    }
    const cardId = String(event.active.id);
    const moving = snapshot.cards.find((card) => card.id === cardId);
    if (!moving) {
      return;
    }
    const overId = String(event.over.id);
    let listId = moving.listId;
    let beforeId: string | null = null;
    if (overId.startsWith("list:") || overId.startsWith("column:")) {
      listId = overId.slice(overId.indexOf(":") + 1);
    } else {
      const overCard = snapshot.cards.find((card) => card.id === overId);
      if (!overCard) {
        return;
      }
      listId = overCard.listId;
      beforeId = overCard.id === cardId ? null : overCard.id;
    }
    const destination = snapshot.lists.find((list) => list.id === listId);
    const origin = snapshot.lists.find((list) => list.id === moving.listId);
    if (destination?.cardEdit === "deny" || origin?.cardEdit === "deny") {
      return;
    }
    if (
      destination?.wipLimit != null &&
      listId !== moving.listId &&
      snapshot.cards.filter((card) => card.listId === listId && !card.archived).length >= destination.wipLimit
    ) {
      return;
    }
    const targetCards = snapshot.cards.filter((card) => card.listId === listId && !card.archived);
    const { prevRank, nextRank } = neighborRanks(targetCards, cardId, beforeId);
    setSnapshot((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        cards: current.cards.map((card) =>
          card.id === cardId ? { ...card, listId, rank: (prevRank ?? 0) + 1 } : card,
        ),
      };
    });
    const updated = await api.moveCard(boardId, cardId, { listId, prevRank, nextRank });
    setSnapshot((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        cards: current.cards.map((card) => (card.id === cardId ? updated : card)),
      };
    });
  }

  async function logout() {
    await api.logout();
    onLogout();
  }

  if (missing || !snapshot) {
    return (
      <div className="gate">
        {missing ? "このボードは見られません" : "ボードを開いています…"}
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="rail">
        <Link className="ghost" to="/">
          すべてのボード
        </Link>
        {snapshot.board.ownerId === user.id ? (
          renaming ? (
            <input
              className="board-name"
              aria-label="ボード名"
              value={titleDraft}
              autoFocus
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => {
                if (skipTitle.current) {
                  skipTitle.current = false;
                  setRenaming(false);
                  return;
                }
                const next = titleDraft.trim();
                setRenaming(false);
                if (!next || next === snapshot.board.title) {
                  return;
                }
                void api.patchBoard(boardId, { title: next }).then((board) => {
                  setSnapshot((current) => (current ? { ...current, board } : current));
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  skipTitle.current = true;
                  event.currentTarget.blur();
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="board-name"
              role="heading"
              aria-level={1}
              aria-label={`${snapshot.board.title} の名前を変更`}
              onClick={() => {
                setTitleDraft(snapshot.board.title);
                setRenaming(true);
              }}
            >
              {snapshot.board.title}
            </button>
          )
        ) : (
          <h1>{snapshot.board.title}</h1>
        )}
        {snapshot.board.ownerId === user.id ? (
          <>
            <button
              type="button"
              onClick={() =>
                void api
                  .patchBoard(boardId, { isTemplate: !snapshot.board.isTemplate })
                  .then((board) =>
                    setSnapshot((current) => (current ? { ...current, board } : current)),
                  )
              }
            >
              {snapshot.board.isTemplate ? "雛形をやめる" : "雛形にする"}
            </button>
            <button
              type="button"
              onClick={() =>
                void api
                  .patchBoard(boardId, { isPublic: !snapshot.board.isPublic })
                  .then((board) =>
                    setSnapshot((current) => (current ? { ...current, board } : current)),
                  )
              }
            >
              {snapshot.board.isPublic ? "公開をやめる" : "公開する"}
            </button>
          </>
        ) : (
          <span>公開ボード</span>
        )}
        <button
          type="button"
          onClick={async () => {
            const md = await api.exportMarkdown(boardId);
            const blob = new Blob([md], { type: "text/markdown" });
            const href = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = href;
            link.download = `${snapshot.board.title}.md`;
            link.click();
            URL.revokeObjectURL(href);
          }}
        >
          Markdown を書き出す
        </button>
        <span>{user.username}</span>
        <Link className="ghost" to="/password">
          パスワード
        </Link>
        <button type="button" onClick={logout}>
          出る
        </button>
      </header>
      {snapshot.board.ownerId === user.id ? (
      <form className="composer batch" onSubmit={addList}>
        <textarea
          aria-label="新しいリスト"
          placeholder="新しいリスト"
          rows={2}
          value={listTitle}
          onChange={(event) => setListTitle(event.target.value)}
        />
        <LineBatch
          name="lists"
          value={listBatch}
          onChange={setListBatch}
          oneLabel="1つのリスト"
          manyLabel="複数のリスト"
        />
        <button type="submit">リストを追加</button>
      </form>
      ) : null}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext
          items={lists.map((list) => `column:${list.id}`)}
          strategy={horizontalListSortingStrategy}
        >
        <div className="board">
          {lists.map((list) => (
            <ListColumn
              key={list.id}
              canEdit={snapshot.board.ownerId === user.id}
              boardId={boardId}
              boards={
                ownedBoards.some((board) => board.id === snapshot.board.id)
                  ? ownedBoards
                  : [{ id: snapshot.board.id, title: snapshot.board.title }, ...ownedBoards]
              }
              list={list}
              cards={uniqueById(snapshot.cards)
                .filter((card) => card.listId === list.id && !card.archived)
                .slice()
                .sort((a, b) => a.rank - b.rank)}
              onAdd={(title) => addCard(list.id, title)}
              onOpen={(card) => {
                setEditing(card);
                setCopyBoardId(boardId);
                setCopyListId(card.listId);
              }}
              onCopy={(targetBoardId) =>
                api.copyList(boardId, list.id, { targetBoardId }).then((copied) => {
                  if (targetBoardId !== boardId) {
                    return;
                  }
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          lists: upsertById(current.lists, [copied.list]),
                          cards: upsertById(current.cards, copied.cards),
                        }
                      : current,
                  );
                })
              }
              onToggle={(collapsed) =>
                api.setListCollapsed(boardId, list.id, collapsed).then(applyList)
              }
              onRename={(title) => api.renameList(boardId, list.id, title).then(applyList)}
              onPatch={(patch) => api.patchList(boardId, list.id, patch).then(applyList)}
              onDelete={() =>
                api.deleteList(boardId, list.id).then(() => {
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          lists: current.lists.filter((row) => row.id !== list.id),
                          cards: current.cards.filter((card) => card.listId !== list.id),
                        }
                      : current,
                  );
                  setEditing((current) => (current?.listId === list.id ? null : current));
                })
              }
              onImportMd={(markdown, filename) =>
                api.importMarkdownCard(boardId, list.id, markdown, filename).then((card) => {
                  setSnapshot((current) =>
                    current ? { ...current, cards: upsertById(current.cards, [card]) } : current,
                  );
                })
              }
            />
          ))}
        </div>
        </SortableContext>
      </DndContext>
      {snapshot.board.ownerId === user.id && archivedLists.length > 0 ? (
        <aside className="archive">
          <h2>保管庫</h2>
          {archivedLists.map((list) => (
            <button
              key={list.id}
              type="button"
              className="ghost"
              aria-label={`${list.title} を戻す`}
              onClick={() => void api.patchList(boardId, list.id, { archived: false }).then(applyList)}
            >
              {list.title} を戻す
            </button>
          ))}
        </aside>
      ) : null}
      {snapshot.board.ownerId === user.id && archivedCards.length > 0 ? (
        <aside className="archive">
          <h2>カード保管庫</h2>
          {archivedCards.map((card) => (
            <button
              key={card.id}
              type="button"
              className="ghost"
              aria-label={`${card.title} を戻す`}
              onClick={() =>
                void api.patchCard(boardId, card.id, { archived: false }).then((updated) => {
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          cards: current.cards.map((row) => (row.id === updated.id ? updated : row)),
                        }
                      : current,
                  );
                })
              }
            >
              {card.title} を戻す
            </button>
          ))}
        </aside>
      ) : null}
      {editing ? (
        <aside className="editor">
          <h2>Markdown</h2>
          <input
            value={editing.title}
            readOnly={snapshot.board.ownerId !== user.id}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
          />
          <textarea
            value={editing.description}
            readOnly={snapshot.board.ownerId !== user.id}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            rows={12}
          />
          <Markdown source={editing.description} />
          <div className="composer">
            {snapshot.board.ownerId === user.id ? (
            <>
            <label className="hint">
              複製先のボード
              <select
                aria-label="複製先のボード"
                value={copyBoardId}
                onChange={(event) => {
                  const nextBoardId = event.target.value;
                  setCopyBoardId(nextBoardId);
                  if (nextBoardId === boardId) {
                    setCopyListId(editing.listId);
                  }
                }}
              >
                {(ownedBoards.some((board) => board.id === snapshot.board.id)
                  ? ownedBoards
                  : [{ id: snapshot.board.id, title: snapshot.board.title }, ...ownedBoards]
                ).map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="hint">
              複製先のリスト
              <select
                aria-label="複製先のリスト"
                value={copyListId}
                onChange={(event) => setCopyListId(event.target.value)}
              >
                {(copyBoardId === boardId
                  ? snapshot.lists.filter((list) => !list.archived)
                  : foreignLists
                ).map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label={`${editing.title} を複製`}
              onClick={() => {
                const targetListId = copyListId || editing.listId;
                void api
                  .copyCard(boardId, editing.id, {
                    targetBoardId: copyBoardId,
                    targetListId,
                  })
                  .then((copied) => {
                    if (copyBoardId !== boardId) {
                      return;
                    }
                    setSnapshot((current) =>
                      current
                        ? { ...current, cards: upsertById(current.cards, [copied]) }
                        : current,
                    );
                  });
              }}
            >
              複製
            </button>
            <button
              type="button"
              onClick={async () => {
                const updated = await api.patchCard(boardId, editing.id, {
                  title: editing.title,
                  description: editing.description,
                });
                setSnapshot((current) =>
                  current
                    ? {
                        ...current,
                        cards: current.cards.map((card) =>
                          card.id === updated.id ? updated : card,
                        ),
                      }
                    : current,
                );
                setEditing(null);
              }}
            >
              保存
            </button>
            </>
            ) : null}
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              閉じる
            </button>
            {snapshot.board.ownerId === user.id ? (
            <>
            <button
              type="button"
              className="ghost"
              aria-label={`${editing.title} を先頭へ`}
              onClick={() => {
                const listCards = snapshot.cards.filter(
                  (card) => card.listId === editing.listId && !card.archived,
                );
                const others = listCards
                  .filter((card) => card.id !== editing.id)
                  .slice()
                  .sort((a, b) => a.rank - b.rank);
                const { prevRank, nextRank } = neighborRanks(listCards, editing.id, others[0]?.id ?? null);
                void api
                  .moveCard(boardId, editing.id, { listId: editing.listId, prevRank, nextRank })
                  .then((updated) => {
                    setSnapshot((current) =>
                      current ? { ...current, cards: upsertById(current.cards, [updated]) } : current,
                    );
                    setEditing(updated);
                  });
              }}
            >
              先頭へ
            </button>
            <button
              type="button"
              className="ghost"
              aria-label={`${editing.title} を末尾へ`}
              onClick={() => {
                const listCards = snapshot.cards.filter(
                  (card) => card.listId === editing.listId && !card.archived,
                );
                const { prevRank, nextRank } = neighborRanks(listCards, editing.id, null);
                void api
                  .moveCard(boardId, editing.id, { listId: editing.listId, prevRank, nextRank })
                  .then((updated) => {
                    setSnapshot((current) =>
                      current ? { ...current, cards: upsertById(current.cards, [updated]) } : current,
                    );
                    setEditing(updated);
                  });
              }}
            >
              末尾へ
            </button>
            <button
              type="button"
              className="ghost"
              aria-label={`${editing.title} を保管`}
              onClick={() => {
                if (!window.confirm(`「${editing.title}」を保管しますか？`)) {
                  return;
                }
                const cardId = editing.id;
                void api.patchCard(boardId, cardId, { archived: true }).then((updated) => {
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          cards: current.cards.map((row) => (row.id === updated.id ? updated : row)),
                        }
                      : current,
                  );
                  setEditing(null);
                });
              }}
            >
              保管
            </button>
            </>
            ) : null}
            {snapshot.board.ownerId === user.id ? (
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!window.confirm(`「${editing.title}」を削除しますか？`)) {
                  return;
                }
                const cardId = editing.id;
                void api.deleteCard(boardId, cardId).then(() => {
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          cards: current.cards.filter((card) => card.id !== cardId),
                        }
                      : current,
                  );
                  setEditing(null);
                });
              }}
            >
              削除
            </button>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
