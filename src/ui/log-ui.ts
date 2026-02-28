import "colors";

const MAX_LOGS = 500;
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

const getPOIStatusFromRawLog = (raw: string): Optional<string> => {
  const normalizedRaw = raw.replace(/\s+/g, " ").trim();

  const detailedMatch = normalizedRaw.match(
    /POI Status:\s*([^|]+)\|\s*TX:\s*(\d+\/\d+)\s*\|\s*Progress:\s*([\d.]+)/i,
  );
  if (detailedMatch) {
    const [, status, txInfo, progress] = detailedMatch;
    const txidMatch = normalizedRaw.match(/TxID:\s*([a-f0-9]{64})/i);
    const txidSuffix = txidMatch
      ? ` • TxID ${txidMatch[1].slice(0, 10)}...${txidMatch[1].slice(-8)}`
      : "";
    return `POI ${status.trim()} • TX ${txInfo.trim()} • ${progress.trim()}%${txidSuffix}`;
  }

  const legacyProgressMatch = normalizedRaw.match(/wallet poi proof progress:\s*(\d+)/i);
  if (legacyProgressMatch) {
    return `POI InProgress • ${legacyProgressMatch[1]}%`;
  }

  return undefined;
};

const shouldSuppressAsNoise = (message: string, level: UILogLevel): boolean => {
  if (level === "error") return false;
  return NOISE_PATTERNS.some((pattern) => pattern.test(message));
};

export const pushUILog = (input: unknown, level: UILogLevel = "log") => {
  const rawText =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? input.message
        : JSON.stringify(input);

  const poiStatus = getPOIStatusFromRawLog(rawText);
  const message = poiStatus ?? normalizeMessage(input);
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

export const getUILogViewerLines = (): string[] => {
  if (uiLogEntries.length === 0) {
    return ["No runtime logs captured yet.".grey];
  }

  const errorCount = uiLogEntries.filter((entry) => entry.level === "error").length;
  const summary = [
    `Entries: ${uiLogEntries.length}`.dim,
    `Errors: ${errorCount}`.dim,
    `Filtered: ${suppressedNoiseCount}`.dim,
  ].join("  ");

  const entries = [...uiLogEntries].reverse().map((entry) => {
    const level = entry.level === "error" ? "[ERR]".red : "[LOG]".grey;
    const repeat = entry.count > 1 ? ` ${`x${entry.count}`.dim}` : "";
    const timestamp = new Date(entry.ts).toLocaleTimeString().dim;
    return `${timestamp} ${level} ${entry.message}${repeat}`;
  });

  return [summary, ...entries];
};
