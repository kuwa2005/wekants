export type MoveCardResult = {
  rank: number;
  needsRebalance: boolean;
};

export function moveCard(
  prev: number | null,
  next: number | null,
): MoveCardResult;
export function rebalanceRanks(count: number): number[];
export function assertBoardAccess(ownerId: string, userId: string): void;
export function validateTitle(title: string): void;
export function hashPassword(password: string): string;
export function verifyPassword(password: string, hash: string): boolean;
