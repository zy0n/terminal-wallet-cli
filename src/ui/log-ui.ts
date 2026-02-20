import "colors";

const MAX_LOGS = 5;
const MAX_LINE_LEN = 100;
const DUPLICATE_WINDOW_MS = 10000;

type UILogLevel = "log" | "error";

type UILogEntry = {
  level: UILogLevel;
  message: string;
  ts: number;
  count: number;
};

const uiLogEntries: UILogEntry[] = [];
let suppressedNoiseCount = 0;

const NOISE_PATTERNS: RegExp[] = [
  /wallet poi proof progress:\s*0/i,
  /scan wallets:\s*chain/i,
  /wallet:\s*scanned\s*\d+/i,
];

const simplifyMessage = (message: string): string => {
  return message
    .replace(/^terminal-cli:[^:]+:\s*/i, "")
    .replace(/syncing railgun transactions to validated index/i, "Syncing transactions")
    .replace(/scan wallet balances/i, "Scanning wallet balances")
    .replace(/wallet balance scanned\.?/i, "Wallet balance scan complete")
    .replace(/proof generation in progress/i, "Proof generation in progress")
    .replace(/\s*\|\s*/g, " • ")
    .trim();
};

const normalizeMessage = (input: unknown): string => {
  const text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? input.message
        : JSON.stringify(input);

  const oneLine = simplifyMessage(text.replace(/\s+/g, " ").trim());
  if (oneLine.length <= MAX_LINE_LEN) return oneLine;
  return `${oneLine.slice(0, MAX_LINE_LEN - 1)}…`;
};

const shouldSuppressAsNoise = (message: string, level: UILogLevel): boolean => {
  if (level === "error") return false;
  return NOISE_PATTERNS.some((pattern) => pattern.test(message));
};

export const pushUILog = (input: unknown, level: UILogLevel = "log") => {
  const message = normalizeMessage(input);
  if (!message.length) return;

  if (shouldSuppressAsNoise(message, level)) {
    suppressedNoiseCount += 1;
    return;
  }

  const lastEntry = uiLogEntries[uiLogEntries.length - 1];
  if (
    lastEntry &&
    lastEntry.level === level &&
    lastEntry.message === message &&
    Date.now() - lastEntry.ts < DUPLICATE_WINDOW_MS
  ) {
    lastEntry.ts = Date.now();
    lastEntry.count += 1;
    return;
  }

  uiLogEntries.push({ level, message, ts: Date.now(), count: 1 });
  if (uiLogEntries.length > MAX_LOGS) {
    uiLogEntries.splice(0, uiLogEntries.length - MAX_LOGS);
  }
};

export const getMainUILogComponent = (): string => {
  if (uiLogEntries.length === 0 && suppressedNoiseCount === 0) {
    return "";
  }

  const errorCount = uiLogEntries.filter((entry) => entry.level === "error").length;
  const headerMetaParts: string[] = [];
  if (errorCount > 0) {
    headerMetaParts.push(`${errorCount} errors`.red);
  }
  if (suppressedNoiseCount > 0) {
    headerMetaParts.push(`${suppressedNoiseCount} filtered`.dim);
  }
  const headerMeta = headerMetaParts.length > 0 ? ` (${headerMetaParts.join(", ")})` : "";

  const lines = [
    "",
    `${"Runtime Activity".grey.bold}${headerMeta}:`,
    ...uiLogEntries.map((entry) => {
      const prefix = entry.level === "error" ? "[ERR]".red : "[LOG]".grey;
      const repeat = entry.count > 1 ? ` ${`x${entry.count}`.dim}` : "";
      return `  ${prefix} ${entry.message}${repeat}`;
    }),
  ];

  return lines.join("\n");
};
