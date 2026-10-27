import { useState } from "react";
import type { List, WipGroup } from "@wekants/shared";

type Draft = {
  title: string;
  listIds: string[];
  limit: string;
  enabled: boolean;
};

type Props = {
  lists: List[];
  groups: WipGroup[];
  onCreate: (body: { title: string; listIds: string[]; limit: number }) => Promise<void>;
  onUpdate: (
    groupId: string,
    body: { title: string; listIds: string[]; limit: number; enabled: boolean },
  ) => Promise<void>;
  onDelete: (groupId: string) => Promise<void>;
};

function limitNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }
  const value = Number(raw);
  return value >= 1 && value <= 999 ? value : null;
}

export function WipPanel({ lists, groups, onCreate, onUpdate, onDelete }: Props) {
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [limit, setLimit] = useState("1");
  const [error, setError] = useState("");

  function toggle(current: string[], listId: string): string[] {
    return current.includes(listId) ? current.filter((id) => id !== listId) : [...current, listId];
  }

  return (
    <section className="wip-panel" aria-label="仕掛かり上限">
      <h2>仕掛かり上限</h2>
      <form
        aria-label="新しいグループ"
        onSubmit={(event) => {
          event.preventDefault();
          const next = limitNumber(limit);
          if (!next) {
            setError("上限は1から999です");
            return;
          }
          if (picked.length < 2) {
            setError("リストを2つ以上選んでください");
            return;
          }
          setError("");
          void onCreate({ title, listIds: picked, limit: next })
            .then(() => {
              setTitle("");
              setPicked([]);
              setLimit("1");
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : "グループを追加できません");
            });
        }}
      >
        <label className="hint">
          グループ名
          <input aria-label="グループ名" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <div className="wip-lists">
          {lists.map((list) => (
            <label key={list.id}>
              <input
                type="checkbox"
                aria-label={`${list.title} をグループに入れる`}
                checked={picked.includes(list.id)}
                onChange={() => setPicked((current) => toggle(current, list.id))}
              />
              {list.title}
            </label>
          ))}
        </div>
        <div className="wip-row">
          <label className="hint">
            上限
            <input aria-label="共通上限" inputMode="numeric" value={limit} onChange={(event) => setLimit(event.target.value)} />
          </label>
          <button type="submit">グループを追加</button>
        </div>
      </form>
      {groups.map((group) => (
        <GroupRow key={group.id} group={group} lists={lists} onUpdate={onUpdate} onDelete={onDelete} />
      ))}
      {error ? <p className="hint">{error}</p> : null}
    </section>
  );
}

function GroupRow({
  group,
  lists,
  onUpdate,
  onDelete,
}: {
  group: WipGroup;
  lists: List[];
  onUpdate: Props["onUpdate"];
  onDelete: Props["onDelete"];
}) {
  const name = group.title || "グループ";
  const [draft, setDraft] = useState<Draft>({
    title: group.title,
    listIds: group.listIds,
    limit: String(group.limit),
    enabled: group.enabled,
  });
  const [error, setError] = useState("");
  const known = new Map(lists.map((list) => [list.id, list.title]));

  return (
    <form
      className="wip-group"
      aria-label={name}
      onSubmit={(event) => {
        event.preventDefault();
        const next = limitNumber(draft.limit);
        if (!next) {
          setError("上限は1から999です");
          return;
        }
        if (draft.listIds.length < 2) {
          setError("リストを2つ以上選んでください");
          return;
        }
        setError("");
        void onUpdate(group.id, {
          title: draft.title,
          listIds: draft.listIds,
          limit: next,
          enabled: draft.enabled,
        }).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "グループを反映できません");
        });
      }}
    >
      <div className="wip-row">
        <input
          aria-label={`${name} の名前`}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        <label>
          <input
            type="checkbox"
            aria-label={`${name} を有効にする`}
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          有効
        </label>
        <label className="hint">
          上限
          <input
            aria-label={`${name} の上限`}
            inputMode="numeric"
            value={draft.limit}
            onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
          />
        </label>
        <button type="submit">反映</button>
        <button
          type="button"
          className="danger"
          aria-label={`${name} を削除`}
          onClick={() => {
            if (window.confirm(`「${name}」を削除しますか？`)) {
              void onDelete(group.id);
            }
          }}
        >
          削除
        </button>
      </div>
      <div className="wip-lists">
        {lists.map((list) => (
          <label key={list.id}>
            <input
              type="checkbox"
              aria-label={`${name} の ${list.title}`}
              checked={draft.listIds.includes(list.id)}
              onChange={() =>
                setDraft({
                  ...draft,
                  listIds: draft.listIds.includes(list.id)
                    ? draft.listIds.filter((id) => id !== list.id)
                    : [...draft.listIds, list.id],
                })
              }
            />
            {known.get(list.id)}
          </label>
        ))}
      </div>
      {error ? <p className="hint">{error}</p> : null}
    </form>
  );
}
