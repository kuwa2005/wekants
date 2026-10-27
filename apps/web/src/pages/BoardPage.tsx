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
import type { BoardSnapshot, Card, List, UserPublic, WsEvent } from "@wekants/shared";
import { api } from "../api";
import { Markdown } from "../Markdown";

type Props = {
  user: UserPublic;
  onLogout: () => void;
};

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
}: {
  list: List;
  cards: Card[];
  onAdd: (title: string) => Promise<void>;
  onOpen: (card: Card) => void;
  onImportMd: (markdown: string, filename: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onRename: (title: string) => Promise<void>;
  onToggle: (collapsed: boolean) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(list.title);
  const skipCommit = useRef(false);
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
    if (!title.trim()) {
      return;
    }
    await onAdd(title.trim());
    setTitle("");
  }

  return (
    <section
      ref={setColumnRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={
        list.collapsed
          ? isDragging
            ? "list collapsed dragging"
            : "list collapsed"
          : isDragging
            ? "list dragging"
            : "list"
      }
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
        <button
          type="button"
          className="grip"
          {...attributes}
          {...listeners}
          aria-label={`${list.title} を移動`}
        >
          移動
        </button>
        {renaming ? (
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
      </div>
      {list.collapsed ? null : (
      <>
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
      <form onSubmit={submit}>
        <input
          aria-label={`${list.title} の新しいカード`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新しいカード"
        />
        <button type="submit">+</button>
      </form>
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
      </>
      )}
    </section>
  );
}

export function BoardPage({ user, onLogout }: Props) {
  const { boardId = "" } = useParams();
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    api.board(boardId).then(setSnapshot).catch(() => setSnapshot(null));
  }, [boardId]);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${protocol}://${location.host}/ws?boardId=${encodeURIComponent(boardId)}`,
    );
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as WsEvent;
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
    () => (snapshot ? snapshot.lists.slice().sort((a, b) => a.rank - b.rank) : []),
    [snapshot],
  );

  async function addList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("listTitle") as HTMLInputElement;
    const list = await api.createList(boardId, input.value);
    setSnapshot((current) =>
      current ? { ...current, lists: [...current.lists, list] } : current,
    );
    input.value = "";
  }

  async function addCard(listId: string, title: string) {
    const card = await api.createCard(boardId, listId, title);
    setSnapshot((current) =>
      current ? { ...current, cards: [...current.cards, card] } : current,
    );
  }

  async function onDragEnd(event: DragEndEvent) {
    if (!snapshot || !event.over) {
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
    const targetCards = snapshot.cards.filter((card) => card.listId === listId);
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

  if (!snapshot) {
    return <div className="gate">ボードを開いています…</div>;
  }

  return (
    <div className="shell">
      <header className="rail">
        <Link className="ghost" to="/">
          すべてのボード
        </Link>
        <h1>{snapshot.board.title}</h1>
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
        <button type="button" onClick={logout}>
          出る
        </button>
      </header>
      <form className="composer" onSubmit={addList}>
        <input name="listTitle" placeholder="新しいリスト" />
        <button type="submit">リストを追加</button>
      </form>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext
          items={lists.map((list) => `column:${list.id}`)}
          strategy={horizontalListSortingStrategy}
        >
        <div className="board">
          {lists.map((list) => (
            <ListColumn
              key={list.id}
              list={list}
              cards={snapshot.cards
                .filter((card) => card.listId === list.id)
                .slice()
                .sort((a, b) => a.rank - b.rank)}
              onAdd={(title) => addCard(list.id, title)}
              onOpen={setEditing}
              onToggle={(collapsed) =>
                api.setListCollapsed(boardId, list.id, collapsed).then((updated) => {
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          lists: current.lists.map((row) =>
                            row.id === updated.id ? updated : row,
                          ),
                        }
                      : current,
                  );
                })
              }
              onRename={(title) =>
                api.renameList(boardId, list.id, title).then((updated) => {
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          lists: current.lists.map((row) =>
                            row.id === updated.id ? updated : row,
                          ),
                        }
                      : current,
                  );
                })
              }
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
                    current ? { ...current, cards: [...current.cards, card] } : current,
                  );
                })
              }
            />
          ))}
        </div>
        </SortableContext>
      </DndContext>
      {editing ? (
        <aside className="editor">
          <h2>Markdown</h2>
          <input
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
          />
          <textarea
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            rows={12}
          />
          <Markdown source={editing.description} />
          <div className="composer">
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
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              閉じる
            </button>
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
          </div>
        </aside>
      ) : null}
    </div>
  );
}
