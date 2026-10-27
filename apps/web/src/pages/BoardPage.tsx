import { FormEvent, useEffect, useMemo, useState } from "react";
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
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { BoardSnapshot, Card, List, UserPublic, WsEvent } from "@wekants/shared";
import { api } from "../api";
import { Markdown } from "../Markdown";

type Props = {
  user: UserPublic;
  onLogout: () => void;
};

function neighborRanks(
  listCards: Card[],
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
}: {
  list: List;
  cards: Card[];
  onAdd: (title: string) => Promise<void>;
  onOpen: (card: Card) => void;
  onImportMd: (markdown: string, filename: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
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
      className="list"
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
        <h2>{list.title}</h2>
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
    const cardId = String(event.active.id);
    const moving = snapshot.cards.find((card) => card.id === cardId);
    if (!moving) {
      return;
    }
    const overId = String(event.over.id);
    let listId = moving.listId;
    let beforeId: string | null = null;
    if (overId.startsWith("list:")) {
      listId = overId.slice(5);
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
