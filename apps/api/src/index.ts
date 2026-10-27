import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { eq } from "drizzle-orm";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { joinBoard, leaveBoard } from "./hub.ts";
import { boards, sessions } from "./schema.ts";

const port = Number(process.env.PORT ?? 3001);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL が必要です");
}

const { db } = await openDatabase(databaseUrl);
const app = createApp(db);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`wekants api on http://localhost:${info.port}`);
}) as Server;

const wss = new WebSocketServer({ server, path: "/ws" });

function cookieSession(request: { headers: { cookie?: string } }): string | null {
  const header = request.headers.cookie ?? "";
  const match = header.match(/(?:^|;\s*)wekants_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

wss.on("connection", (socket: WebSocket, request) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const boardId = url.searchParams.get("boardId");
    const token = cookieSession(request);
    if (!boardId || !token) {
      socket.close(4401, "ログインが必要です");
      return;
    }
    const [session] = await db.select().from(sessions).where(eq(sessions.id, token)).limit(1);
    if (!session || session.expiresAt < Date.now()) {
      socket.close(4401, "ログインが必要です");
      return;
    }
    const [board] = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1);
    if (!board) {
      socket.close(4404, "見つかりません");
      return;
    }
    if (board.ownerId !== session.userId && !board.isPublic) {
      socket.close(4404, "見つかりません");
      return;
    }
    joinBoard(boardId, socket, session.userId);
    socket.on("close", () => leaveBoard(boardId, socket));
  })();
});
