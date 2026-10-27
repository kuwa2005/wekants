import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { UserPublic } from "@wekants/shared";
import { api } from "./api";
import { BoardPage } from "./pages/BoardPage";
import { BoardsPage } from "./pages/BoardsPage";
import { GatePage } from "./pages/GatePage";
import { PasswordPage } from "./pages/PasswordPage";

export function App() {
  const [user, setUser] = useState<UserPublic | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return <div className="gate">読み込んでいます…</div>;
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          user ? <Navigate to="/" replace /> : <GatePage mode="login" onAuth={setUser} />
        }
      />
      <Route
        path="/register"
        element={
          user ? (
            <Navigate to="/" replace />
          ) : (
            <GatePage mode="register" onAuth={setUser} />
          )
        }
      />
      <Route
        path="/"
        element={user ? <BoardsPage user={user} onLogout={() => setUser(null)} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/password"
        element={user ? <PasswordPage user={user} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/b/:boardId"
        element={
          user ? (
            <BoardPage user={user} onLogout={() => setUser(null)} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}
