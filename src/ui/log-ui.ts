import "colors";

const MAX_LOGS = 6;
const MAX_LINE_LEN = 88;

type UILogLevel = "log" | "error";

type UILogEntry = {
  level: UILogLevel;
  message: string;
  ts: number;
};

const uiLogEntries: UILogEntry[] = [];

const normalizeMessage = (input: unknown): string => {
  const text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? input.message
        : JSON.stringify(input);

  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_LINE_LEN) return oneLine;
  return `${oneLine.slice(0, MAX_LINE_LEN - 1)}…`;
};

export const pushUILog = (input: unknown, level: UILogLevel = "log") => {
  const message = normalizeMessage(input);
  if (!message.length) return;

  uiLogEntries.push({ level, message, ts: Date.now() });
  if (uiLogEntries.length > MAX_LOGS) {
    uiLogEntries.splice(0, uiLogEntries.length - MAX_LOGS);
  }
};

export const getMainUILogComponent = (): string => {
  if (uiLogEntries.length === 0) {
    return "";
  }

  const lines = [
    "",
    `${"Runtime Logs".grey.bold}:`,
    ...uiLogEntries.map((entry) => {
      const prefix = entry.level === "error" ? "[ERR]".red : "[LOG]".grey;
      return `  ${prefix} ${entry.message}`;
    }),
  ];

  return lines.join("\n");
};
