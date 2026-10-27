import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import type { UserPublic } from "@wekants/shared";
import { api } from "../api";

type Props = {
  user: UserPublic;
};

export function PasswordPage({ user }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setDone(false);
    try {
      await api.changePassword(currentPassword, nextPassword);
      setCurrentPassword("");
      setNextPassword("");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "失敗しました");
    }
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={onSubmit}>
        <h1>パスワード</h1>
        <p>{user.username} のパスワードを変えます。ログインしたまま使えます。</p>
        <label>
          今のパスワード
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label>
          新しいパスワード
          <input
            name="nextPassword"
            type="password"
            autoComplete="new-password"
            value={nextPassword}
            onChange={(event) => setNextPassword(event.target.value)}
          />
        </label>
        {done ? <p>変えました。</p> : null}
        <div className="error">{error}</div>
        <button type="submit">変える</button>
        <Link className="alt" to="/">
          すべてのボード
        </Link>
      </form>
    </div>
  );
}
