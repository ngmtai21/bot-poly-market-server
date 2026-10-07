type Level = "info" | "warn" | "error";

// Vietnam is a fixed UTC+7 with no DST, so shift by a constant instead of
// pulling in Intl/timezone handling. Log lines only; DB timestamps stay UTC.
const VN_OFFSET_MS = 7 * 3_600_000;
const stamp = () => new Date(Date.now() + VN_OFFSET_MS).toISOString().replace("Z", "+07:00");

function log(level: Level, msg: string, meta?: unknown): void {
  const line = `${stamp()} [${level.toUpperCase()}] ${msg}`;
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta === undefined) out(line);
  else out(line, meta);
}

export const logger = {
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
};
