import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("./wekan-core-node.node");

export const moveCard = native.moveCard;
export const rebalanceRanks = native.rebalanceRanks;
export const assertBoardAccess = native.assertBoardAccess;
export const validateTitle = native.validateTitle;
export const hashPassword = native.hashPassword;
export const verifyPassword = native.verifyPassword;
