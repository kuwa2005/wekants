import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import type { UserPublic } from "@wekants/shared";
import { api } from "../api";

type Props = {
  mode: "login" | "register";
  onAuth: (user: UserPublic) => void;
};

export function GatePage({ mode, onAuth }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const user =
        mode === "register"
          ? await api.register(username, password)
          : await api.login(username, password);
      onAuth(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "失敗しました");
    }
  }

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={onSubmit}>
        <h1>wekants</h1>
        <p>作業場のボードです。カードを動かすと、同じボードを開いている人にも見えます。</p>
        <label>
          ユーザー名
          <input
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          パスワード
          <input
            name="password"
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="error">{error}</div>
        <button type="submit">
          {mode === "register" ? "登録する" : "入る"}
        </button>
        {mode === "login" ? (
          <Link className="alt" to="/register">
            初めての人は登録
          </Link>
        ) : (
          <Link className="alt" to="/login">
            登録済みの人はログイン
          </Link>
        )}
      </form>
    </div>
  );
}
