import type { WsEvent } from "@wekants/shared";
import type { WebSocket } from "ws";

const rooms = new Map<string, Set<WebSocket>>();

export function joinBoard(boardId: string, socket: WebSocket): void {
  let room = rooms.get(boardId);
  if (!room) {
    room = new Set();
    rooms.set(boardId, room);
  }
  room.add(socket);
}

export function leaveBoard(boardId: string, socket: WebSocket): void {
  const room = rooms.get(boardId);
  if (!room) {
    return;
  }
  room.delete(socket);
  if (room.size === 0) {
    rooms.delete(boardId);
  }
}

export function broadcast(boardId: string, event: WsEvent): void {
  const room = rooms.get(boardId);
  if (!room) {
    return;
  }
  const data = JSON.stringify(event);
  for (const socket of room) {
    if (socket.readyState === socket.OPEN) {
      socket.send(data);
    }
  }
}
