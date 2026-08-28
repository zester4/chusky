import { config } from "./config.js";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Session {
  model: string;
  history: Message[];
}

const store = new Map<number, Session>();

export function getSession(userId: number): Session {
  if (!store.has(userId)) {
    store.set(userId, { model: config.defaultModel, history: [] });
  }
  return store.get(userId)!;
}

export function pushMessage(userId: number, msg: Message): void {
  const session = getSession(userId);
  session.history.push(msg);

  // Keep last N exchanges (user + assistant = 2 messages per exchange)
  const cap = config.maxHistory * 2;
  if (session.history.length > cap) {
    session.history = session.history.slice(session.history.length - cap);
  }
}

export function clearHistory(userId: number): void {
  getSession(userId).history = [];
}

export function setModel(userId: number, model: string): void {
  getSession(userId).model = model;
}

export function getModel(userId: number): string {
  return getSession(userId).model;
}
