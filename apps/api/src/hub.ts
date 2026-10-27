import type { WsEvent } from "@wekants/shared";
import type { WebSocket } from "ws";

type Viewer = {
  socket: WebSocket;
  userId: string;
};

const rooms = new Map<string, Set<Viewer>>();

export function joinBoard(boardId: string, socket: WebSocket, userId: string): void {
  let room = rooms.get(boardId);
  if (!room) {
    room = new Set();
    rooms.set(boardId, room);
  }
  room.add({ socket, userId });
}

export function leaveBoard(boardId: string, socket: WebSocket): void {
  const room = rooms.get(boardId);
  if (!room) {
    return;
  }
  for (const viewer of room) {
    if (viewer.socket === socket) {
      room.delete(viewer);
    }
  }
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
  for (const viewer of room) {
    if (viewer.socket.readyState === viewer.socket.OPEN) {
      viewer.socket.send(data);
    }
  }
}

export function closeGuests(boardId: string, ownerId: string): void {
  const room = rooms.get(boardId);
  if (!room) {
    return;
  }
  for (const viewer of [...room]) {
    if (viewer.userId === ownerId) {
      continue;
    }
    room.delete(viewer);
    viewer.socket.close(4404, "見つかりません");
  }
  if (room.size === 0) {
    rooms.delete(boardId);
  }
}
