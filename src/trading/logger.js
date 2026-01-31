function fmt(args) {
  return args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
}

export const logger = {
  info: (...args) => console.log("[trading]", fmt(args)),
  warn: (...args) => console.warn("[trading]", fmt(args)),
  error: (...args) => console.error("[trading]", fmt(args))
};

export function formatError(err) {
  if (!err) return "unknown";
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}
