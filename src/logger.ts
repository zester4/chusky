import pino from "pino";
import { config } from "./config.js";

// pino-pretty's transport runs in a worker thread. Windows file scanners can
// transiently deny that worker's module during tests and local startup, which
// turns an otherwise harmless log into an uncaught process failure. Keep the
// default logger synchronous unless an interactive TTY explicitly opts in.
const prettyLogs = process.env.CHUSKY_LOG_PRETTY === "1" && process.stdout.isTTY === true;

export const logger = pino({
  level: config.logLevel,
  transport: prettyLogs ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } : undefined,
});
