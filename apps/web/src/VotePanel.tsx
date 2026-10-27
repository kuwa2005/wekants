import { useEffect, useState } from "react";
import type { Card } from "@wekants/shared";

type Props = {
  card: Card;
  mine: "positive" | "negative" | null;
  canAsk: boolean;
  canVote: boolean;
  onAsk: (question: string, visible: boolean) => Promise<void>;
  onVote: (choice: "positive" | "negative") => Promise<void>;
};

export function VotePanel({ card, mine, canAsk, canVote, onAsk, onVote }: Props) {
  const [question, setQuestion] = useState(card.vote?.question ?? "");
  const [visible, setVisible] = useState(card.vote?.public ?? true);
  const [error, setError] = useState("");

  useEffect(() => {
    setQuestion(card.vote?.question ?? "");
    setVisible(card.vote?.public ?? true);
  }, [card.id, card.vote?.question, card.vote?.public]);

  if (!canAsk && !card.vote) {
    return null;
  }

  return (
    <section className="vote-box">
      <h3>投票</h3>
      {canAsk ? (
        <>
          <label className="hint">
            質問
            <input
              aria-label="投票の質問"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <label className="hint">
            <input
              type="checkbox"
              aria-label="投票者の名前を公開"
              checked={visible}
              onChange={(event) => setVisible(event.target.checked)}
            />
            名前を公開する
          </label>
          <button
            type="button"
            onClick={() => {
              setError("");
              void onAsk(question, visible).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "質問を保存できません");
              });
            }}
          >
            質問を保存
          </button>
        </>
      ) : null}
      {card.vote ? (
        <>
          <p>{card.vote.question}</p>
          <div className="vote-actions">
            <button
              type="button"
              className={mine === "positive" ? "voted" : undefined}
              aria-pressed={mine === "positive"}
              disabled={!canVote}
              onClick={() => void onVote("positive")}
            >
              賛成
            </button>
            <span aria-label="賛成の票">{card.vote.positive}</span>
            <button
              type="button"
              className={mine === "negative" ? "voted" : undefined}
              aria-pressed={mine === "negative"}
              disabled={!canVote}
              onClick={() => void onVote("negative")}
            >
              反対
            </button>
            <span aria-label="反対の票">{card.vote.negative}</span>
          </div>
          {card.vote.public && (card.vote.positiveNames.length > 0 || card.vote.negativeNames.length > 0) ? (
            <p className="hint">
              {card.vote.positiveNames.length > 0 ? `賛成 ${card.vote.positiveNames.join("、")}` : ""}
              {card.vote.positiveNames.length > 0 && card.vote.negativeNames.length > 0 ? " / " : ""}
              {card.vote.negativeNames.length > 0 ? `反対 ${card.vote.negativeNames.join("、")}` : ""}
            </p>
          ) : null}
          {!canVote ? <p className="hint">ログインすると投票できます</p> : null}
        </>
      ) : null}
      {error ? <p className="hint">{error}</p> : null}
    </section>
  );
}
