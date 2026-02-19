import {
  NetworkName,
  TransactionHistoryItem,
  TransactionHistoryItemCategory,
  isDefined,
} from "@railgun-community/shared-models";
import {
  getWalletTransactionHistory,
  categoryForTransactionHistoryItem,
} from "@railgun-community/wallet";
import {
  getChainForName,
  getFirstPollingProviderForChain,
} from "../network/network-util";
import {
  getCurrentRailgunID,
  getCurrentWalletPublicAddress,
} from "../wallet/wallet-util";
import { getTokenInfo } from "../balance/token-util";
import { Interface, Log } from "ethers";
import { readablePrecision } from "../util/util";
import {
  confirmPromptCatch,
  confirmPromptCatchRetry,
} from "./confirm-ui";
import { clearConsoleBuffer } from "../util/error-util";
import "colors";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select } = require("enquirer");

const PAGE_SIZE = 10;

// ─── Well-known Event Signatures ────────────────────────────────────────────

const STANDARD_EVENTS = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
]);

const STANDARD_FUNCTIONS = new Interface([
  "function transfer(address to, uint256 value)",
  "function approve(address spender, uint256 value)",
  "function transferFrom(address from, address to, uint256 value)",
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

// RAILGUN V2.1 contract events — ABI JSON inlined from RailgunSmartWallet.json
const RAILGUN_EVENTS = new Interface([
  // Shield(uint256,uint256,tuple[],tuple[],uint256[])
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"treeNumber","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"startPosition","type":"uint256"},{"components":[{"internalType":"bytes32","name":"npk","type":"bytes32"},{"components":[{"internalType":"enum TokenType","name":"tokenType","type":"uint8"},{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"uint256","name":"tokenSubID","type":"uint256"}],"internalType":"struct TokenData","name":"token","type":"tuple"},{"internalType":"uint120","name":"value","type":"uint120"}],"indexed":false,"internalType":"struct CommitmentPreimage[]","name":"commitments","type":"tuple[]"},{"components":[{"internalType":"bytes32[3]","name":"encryptedBundle","type":"bytes32[3]"},{"internalType":"bytes32","name":"shieldKey","type":"bytes32"}],"indexed":false,"internalType":"struct ShieldCiphertext[]","name":"shieldCiphertext","type":"tuple[]"},{"indexed":false,"internalType":"uint256[]","name":"fees","type":"uint256[]"}],"name":"Shield","type":"event"},
  // Transact(uint256,uint256,bytes32[],tuple[])
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"treeNumber","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"startPosition","type":"uint256"},{"indexed":false,"internalType":"bytes32[]","name":"hash","type":"bytes32[]"},{"components":[{"internalType":"bytes32[4]","name":"ciphertext","type":"bytes32[4]"},{"internalType":"bytes32","name":"blindedSenderViewingKey","type":"bytes32"},{"internalType":"bytes32","name":"blindedReceiverViewingKey","type":"bytes32"},{"internalType":"bytes","name":"annotationData","type":"bytes"},{"internalType":"bytes","name":"memo","type":"bytes"}],"indexed":false,"internalType":"struct CommitmentCiphertext[]","name":"ciphertext","type":"tuple[]"}],"name":"Transact","type":"event"},
  // Unshield(address,tuple,uint256,uint256)
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"to","type":"address"},{"components":[{"internalType":"enum TokenType","name":"tokenType","type":"uint8"},{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"uint256","name":"tokenSubID","type":"uint256"}],"indexed":false,"internalType":"struct TokenData","name":"token","type":"tuple"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"fee","type":"uint256"}],"name":"Unshield","type":"event"},
  // Nullified(uint16,bytes32[])
  {"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint16","name":"treeNumber","type":"uint16"},{"indexed":false,"internalType":"bytes32[]","name":"nullifier","type":"bytes32[]"}],"name":"Nullified","type":"event"},
]);

type DecodedEvent = {
  eventName: string;
  address: string;
  args: Record<string, string>;
  logIndex: number;
};

type DecodedTxCall = {
  methodName: string;
  to: string;
  args: Record<string, string>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stringifyArg = (val: any): string => {
  if (typeof val === "bigint") return val.toString();
  if (Array.isArray(val)) {
    // ethers Result (tuple/struct): check for named keys
    const named: Record<string, string> = {};
    let hasNamed = false;
    for (const [k, v] of Object.entries(val)) {
      if (/^\d+$/.test(k)) continue;
      named[k] = stringifyArg(v);
      hasNamed = true;
    }
    if (hasNamed) return JSON.stringify(named);
    return `[${val.map(stringifyArg).join(", ")}]`;
  }
  return String(val);
};

const tryDecodeLog = (log: Log): DecodedEvent | undefined => {
  const logData = { topics: log.topics as string[], data: log.data };

  // Try each interface — RAILGUN first (more specific), then standard ERC-20/DEX
  for (const iface of [RAILGUN_EVENTS, STANDARD_EVENTS]) {
    try {
      const parsed = iface.parseLog(logData);
      if (!parsed) continue;

      const args: Record<string, string> = {};
      for (const [i, input] of parsed.fragment.inputs.entries()) {
        args[input.name] = stringifyArg(parsed.args[i]);
      }

      return {
        eventName: parsed.name,
        address: log.address,
        args,
        logIndex: log.index,
      };
    } catch {
      continue;
    }
  }
  return undefined;
};

const tryDecodeTxInput = (
  to: string,
  data: string,
): DecodedTxCall | undefined => {
  if (!data || data === "0x") return undefined;

  try {
    const parsed = STANDARD_FUNCTIONS.parseTransaction({ data });
    if (!parsed) return undefined;

    const args: Record<string, string> = {};
    for (const [i, input] of parsed.fragment.inputs.entries()) {
      args[input.name] = stringifyArg(parsed.args[i]);
    }

    return {
      methodName: parsed.name,
      to,
      args,
    };
  } catch {
    return undefined;
  }
};

const normalizeAddress = (address: Optional<string>): Optional<string> => {
  if (!isDefined(address)) return undefined;
  return address.toLowerCase();
};

const pushUnique = (arr: string[], value: string) => {
  if (!arr.includes(value)) {
    arr.push(value);
  }
};

type AssetTypeLabel = "ERC20" | "NFT";

const withAssetType = (assetType: AssetTypeLabel, text: string): string => {
  return `[${assetType}] ${text}`;
};

const formatNFTSummary = (
  nfts: Array<{
    nftAddress: string;
    tokenSubID: string | number | bigint;
    amount: string | number | bigint;
  }>,
): string => {
  if (nfts.length === 0) return "";
  return nfts
    .map(
      ({ nftAddress, tokenSubID, amount }) =>
        `${truncateHash(nftAddress, 6)}#${tokenSubID.toString()} x${amount.toString()}`,
    )
    .join(", ");
};

const inferAssetTypeForTransferEvent = async (
  chainName: NetworkName,
  tokenAddress: string,
): Promise<AssetTypeLabel> => {
  try {
    await getTokenInfo(chainName, tokenAddress);
    return "ERC20";
  } catch {
    return "NFT";
  }
};

const formatTokenValue = async (
  chainName: NetworkName,
  tokenAddress: string,
  rawValue: string,
): Promise<string> => {
  if (!/^\d+$/.test(rawValue)) return rawValue;
  try {
    const { symbol, decimals } = await getTokenInfo(chainName, tokenAddress);
    return `${readablePrecision(BigInt(rawValue), decimals, 6)} ${symbol}`;
  } catch {
    return rawValue;
  }
};

const inferWalletActionsFromHistoryItem = async (
  chainName: NetworkName,
  item: TransactionHistoryItem,
): Promise<string[]> => {
  const actions: string[] = [];
  const cat = categoryForTransactionHistoryItem(item);

  if (item.receiveERC20Amounts.length > 0) {
    const summaries = await buildTokenSummaries(
      chainName,
      item.receiveERC20Amounts.map((x) => ({
        tokenAddress: x.tokenAddress,
        amount: x.amount,
      })),
    );
    const amounts = summaryAmountString(summaries);
    if (cat === TransactionHistoryItemCategory.ShieldERC20s) {
      pushUnique(
        actions,
        withAssetType("ERC20", `Shielded ${amounts} into private balance`),
      );
    } else {
      pushUnique(actions, withAssetType("ERC20", `Received privately ${amounts}`));
    }
  }

  if (item.transferERC20Amounts.length > 0) {
    const summaries = await buildTokenSummaries(
      chainName,
      item.transferERC20Amounts.map((x) => ({
        tokenAddress: x.tokenAddress,
        amount: x.amount,
      })),
    );
    const amounts = summaryAmountString(summaries);
    pushUnique(actions, withAssetType("ERC20", `Sent privately ${amounts}`));
  }

  if (item.unshieldERC20Amounts.length > 0) {
    const summaries = await buildTokenSummaries(
      chainName,
      item.unshieldERC20Amounts.map((x) => ({
        tokenAddress: x.tokenAddress,
        amount: x.amount,
      })),
    );
    const amounts = summaryAmountString(summaries);
    const firstRecipient = item.unshieldERC20Amounts[0]?.recipientAddress;
    if (isDefined(firstRecipient) && firstRecipient.length > 0) {
      pushUnique(
        actions,
        withAssetType(
          "ERC20",
          `Unshielded ${amounts} to ${truncateHash(firstRecipient, 6)}`,
        ),
      );
    } else {
      pushUnique(actions, withAssetType("ERC20", `Unshielded ${amounts}`));
    }
  }

  if (item.receiveNFTAmounts.length > 0) {
    const nfts = formatNFTSummary(item.receiveNFTAmounts);
    pushUnique(actions, withAssetType("NFT", `Received privately ${nfts}`));
  }

  if (item.transferNFTAmounts.length > 0) {
    const nfts = formatNFTSummary(item.transferNFTAmounts);
    pushUnique(actions, withAssetType("NFT", `Sent privately ${nfts}`));
  }

  if (item.unshieldNFTAmounts.length > 0) {
    const nfts = formatNFTSummary(item.unshieldNFTAmounts);
    const firstRecipient = item.unshieldNFTAmounts[0]?.recipientAddress;
    if (isDefined(firstRecipient) && firstRecipient.length > 0) {
      pushUnique(
        actions,
        withAssetType("NFT", `Unshielded ${nfts} to ${truncateHash(firstRecipient, 6)}`),
      );
    } else {
      pushUnique(actions, withAssetType("NFT", `Unshielded ${nfts}`));
    }
  }

  if (item.broadcasterFeeERC20Amount) {
    const fee = item.broadcasterFeeERC20Amount;
    const feeAmount = await formatTokenValue(
      chainName,
      fee.tokenAddress,
      fee.amount.toString(),
    );
    pushUnique(actions, `Paid broadcaster fee ${feeAmount}`);
  }

  return actions;
};

const inferWalletActionsFromDecodedData = async (
  chainName: NetworkName,
  decodedEvents: DecodedEvent[],
  decodedCall: Optional<DecodedTxCall>,
  walletAddresses: Set<string>,
): Promise<string[]> => {
  const actions: string[] = [];

  if (isDefined(decodedCall)) {
    switch (decodedCall.methodName) {
      case "approve": {
        const spender = decodedCall.args.spender ?? "unknown";
        const amount = await formatTokenValue(
          chainName,
          decodedCall.to,
          decodedCall.args.value ?? "0",
        );
        pushUnique(
          actions,
          withAssetType(
            "ERC20",
            `Approved ${truncateHash(spender, 6)} to spend ${amount}`,
          ),
        );
        break;
      }
      case "transfer": {
        const amount = await formatTokenValue(
          chainName,
          decodedCall.to,
          decodedCall.args.value ?? "0",
        );
        const recipient = decodedCall.args.to ?? "unknown";
        pushUnique(
          actions,
          withAssetType(
            "ERC20",
            `Called transfer: ${amount} to ${truncateHash(recipient, 6)}`,
          ),
        );
        break;
      }
      case "swapExactTokensForTokens":
      case "swapExactTokensForETH":
      case "swapExactETHForTokens":
        pushUnique(actions, `Executed swap via ${truncateHash(decodedCall.to, 6)}`);
        break;
      case "deposit":
        pushUnique(actions, `Wrapped native token via ${truncateHash(decodedCall.to, 6)}`);
        break;
      case "withdraw":
        pushUnique(actions, `Unwrapped native token via ${truncateHash(decodedCall.to, 6)}`);
        break;
      default:
        break;
    }
  }

  for (const evt of decodedEvents) {
    if (evt.eventName === "Transfer") {
      const from = normalizeAddress(evt.args.from);
      const to = normalizeAddress(evt.args.to);
      const fromWallet = isDefined(from) && walletAddresses.has(from);
      const toWallet = isDefined(to) && walletAddresses.has(to);

      if (!fromWallet && !toWallet) continue;

      const assetType = await inferAssetTypeForTransferEvent(chainName, evt.address);

      const value = evt.args.value ?? "0";
      const amount =
        assetType === "ERC20"
          ? await formatTokenValue(chainName, evt.address, value)
          : `${truncateHash(evt.address, 6)}#${value}`;

      if (fromWallet && toWallet) {
        pushUnique(
          actions,
          withAssetType(assetType, `Moved ${amount} between your addresses`),
        );
        continue;
      }

      if (fromWallet) {
        pushUnique(
          actions,
          withAssetType(
            assetType,
            `Sent ${amount} to ${truncateHash(evt.args.to ?? "unknown", 6)}`,
          ),
        );
        continue;
      }

      if (toWallet) {
        pushUnique(
          actions,
          withAssetType(
            assetType,
            `Received ${amount} from ${truncateHash(evt.args.from ?? "unknown", 6)}`,
          ),
        );
      }
      continue;
    }

    if (evt.eventName === "Approval") {
      const owner = normalizeAddress(evt.args.owner);
      if (!isDefined(owner) || !walletAddresses.has(owner)) continue;

      const amount = await formatTokenValue(
        chainName,
        evt.address,
        evt.args.value ?? "0",
      );
      pushUnique(
        actions,
        withAssetType(
          "ERC20",
          `Approved ${truncateHash(evt.args.spender ?? "unknown", 6)} for ${amount}`,
        ),
      );
      continue;
    }

    if (evt.eventName === "Unshield") {
      const tokenRaw = evt.args.token;
      let tokenAddress = evt.address;
      let assetType: AssetTypeLabel = "ERC20";
      let tokenSubID = "?";
      if (isDefined(tokenRaw)) {
        try {
          const token = JSON.parse(tokenRaw);
          tokenAddress = token?.tokenAddress ?? tokenAddress;
          if (token?.tokenType === 1 || token?.tokenType === "1") {
            assetType = "NFT";
            tokenSubID = token?.tokenSubID?.toString() ?? "?";
          }
        } catch {
          // keep event address fallback
        }
      }

      if (assetType === "NFT") {
        const nft = `${truncateHash(tokenAddress, 6)}#${tokenSubID} x${evt.args.amount ?? "1"}`;
        pushUnique(
          actions,
          withAssetType(
            "NFT",
            `Unshielded ${nft} to ${truncateHash(evt.args.to ?? "unknown", 6)}`,
          ),
        );
      } else {
        const amount = await formatTokenValue(
          chainName,
          tokenAddress,
          evt.args.amount ?? "0",
        );
        pushUnique(
          actions,
          withAssetType(
            "ERC20",
            `Unshielded ${amount} to ${truncateHash(evt.args.to ?? "unknown", 6)}`,
          ),
        );
      }
      continue;
    }

    if (evt.eventName === "Shield") {
      pushUnique(actions, "Shielded assets into private balance");
      continue;
    }

    if (evt.eventName === "Transact") {
      pushUnique(actions, "Executed private transaction");
      continue;
    }
  }

  return actions;
};

const formatDecodedEvent = async (
  chainName: NetworkName,
  evt: DecodedEvent,
  idx: number,
): Promise<string[]> => {
  const lines: string[] = [];
  const contractLabel = truncateHash(evt.address, 6);
  lines.push(
    `    [${idx}] ${evt.eventName.cyan.bold}  ${
      "on".grey
    } ${contractLabel.dim}  ${
      `(log #${evt.logIndex})`.dim
    }`,
  );

  // ── RAILGUN Shield: extract commitment preimages ──
  if (evt.eventName === "Shield" && evt.args.commitments) {
    try {
      const commitments = JSON.parse(evt.args.commitments);
      const arr = Array.isArray(commitments) ? commitments : [commitments];
      for (const [ci, c] of arr.entries()) {
        const token = typeof c.token === "string" ? JSON.parse(c.token) : c.token;
        const tokenAddr = token?.tokenAddress ?? "unknown";
        const rawValue = c.value ?? "0";
        try {
          const { symbol, decimals } = await getTokenInfo(chainName, tokenAddr);
          lines.push(`        ${'Commitment'.grey} [${ci}]: ${readablePrecision(BigInt(rawValue), decimals, 6)} ${symbol}`);
        } catch {
          lines.push(`        ${'Commitment'.grey} [${ci}]: ${rawValue} (${truncateHash(tokenAddr)})`);
        }
      }
    } catch {
      lines.push(`        ${'commitments'.grey}: ${evt.args.commitments}`);
    }
    lines.push(`        ${'treeNumber'.grey}: ${evt.args.treeNumber ?? "?"}`);
    lines.push(`        ${'startPosition'.grey}: ${evt.args.startPosition ?? "?"}`);
    return lines;
  }

  // ── RAILGUN Unshield: extract tuple token data ──
  if (evt.eventName === "Unshield" && evt.args.token) {
    let tokenAddr = evt.address;
    try {
      const token = JSON.parse(evt.args.token);
      tokenAddr = token?.tokenAddress ?? evt.address;
    } catch { /* use contract address */ }
    lines.push(`        ${'to'.grey}: ${evt.args.to ?? "?"}`);
    try {
      const { symbol, decimals } = await getTokenInfo(chainName, tokenAddr);
      lines.push(`        ${'amount'.grey}: ${readablePrecision(BigInt(evt.args.amount ?? "0"), decimals, 6)} ${symbol}`);
      lines.push(`        ${'fee'.grey}: ${readablePrecision(BigInt(evt.args.fee ?? "0"), decimals, 6)} ${symbol}`);
    } catch {
      lines.push(`        ${'amount'.grey}: ${evt.args.amount ?? "?"}`);
      lines.push(`        ${'fee'.grey}: ${evt.args.fee ?? "?"}`);
      lines.push(`        ${'token'.grey}: ${tokenAddr}`);
    }
    return lines;
  }

  // ── RAILGUN Transact: summarise ──
  if (evt.eventName === "Transact") {
    lines.push(`        ${'treeNumber'.grey}: ${evt.args.treeNumber ?? "?"}`);
    lines.push(`        ${'startPosition'.grey}: ${evt.args.startPosition ?? "?"}`);
    try {
      const hashes = JSON.parse(evt.args.hash ?? "[]");
      lines.push(`        ${'commitments'.grey}: ${Array.isArray(hashes) ? hashes.length : 1}`);
    } catch {
      lines.push(`        ${'hash'.grey}: ${evt.args.hash ?? "?"}`);
    }
    return lines;
  }

  // ── RAILGUN Nullified / Nullifiers ──
  if (evt.eventName === "Nullified" || evt.eventName === "Nullifiers") {
    lines.push(`        ${'treeNumber'.grey}: ${evt.args.treeNumber ?? "?"}`);
    try {
      const nullifiers = JSON.parse(evt.args.nullifier ?? "[]");
      lines.push(`        ${'nullifiers'.grey}: ${Array.isArray(nullifiers) ? nullifiers.length : 1}`);
    } catch {
      lines.push(`        ${'nullifier'.grey}: ${evt.args.nullifier ?? "?"}`);
    }
    return lines;
  }

  // ── Generic fallback (Transfer, Approval, Swap, etc.) ──
  for (const [key, val] of Object.entries(evt.args)) {
    let display = val;

    if (
      /amount|value|wad|fee|reserve/i.test(key) &&
      /^\d+$/.test(val) &&
      val.length > 6
    ) {
      if (evt.eventName === "Transfer") {
        try {
          const { symbol, decimals } = await getTokenInfo(chainName, evt.address);
          display = `${readablePrecision(BigInt(val), decimals, 6)} ${symbol}`;
        } catch { /* keep raw */ }
      }
    }

    lines.push(`        ${key.grey}: ${display}`);
  }

  return lines;
};

// ─── On-chain Query for UNKNOWN Txs ────────────────────────────────────────

const queryOnChainActions = async (
  chainName: NetworkName,
  item: TransactionHistoryItem,
  showDecodedEvents: boolean,
): Promise<string[]> => {
  const lines: string[] = [];
  const txHash = item.txid; // txid IS the on-chain transaction hash

  if (!txHash) {
    lines.push(`    ${'Transaction hash unavailable — cannot query on-chain.'.yellow}`);
    return lines;
  }

  try {
    const provider = getFirstPollingProviderForChain(chainName);
    const receipt = await provider.getTransactionReceipt(txHash);
    const tx = await provider.getTransaction(txHash).catch(() => undefined);

    

    if (!receipt || !tx) {
      lines.push(`    ${'Could not fetch transaction receipt.'.yellow}`);
      return lines;
    }

    const walletAddresses = new Set<string>();
    try {
      const walletAddress = normalizeAddress(getCurrentWalletPublicAddress());
      if (isDefined(walletAddress)) {
        walletAddresses.add(walletAddress);
      }
    } catch {
      // wallet not initialized for public-address lookup
    }

    const txFrom = normalizeAddress(tx?.from);
    if (isDefined(txFrom)) {
      walletAddresses.add(txFrom);
    }

    const decodedCall =
      isDefined(tx?.to) && isDefined(tx?.data)
        ? tryDecodeTxInput(tx.to, tx.data)
        : undefined;

    lines.push(`  ${'On-Chain Lookup'.cyan.bold}:`);
    lines.push(`    ${'TX Hash'.grey}: ${txHash}`);
    if (isDefined(tx?.from)) {
      lines.push(`    ${'From'.grey}: ${tx.from}`);
    }
    if (isDefined(tx?.to)) {
      lines.push(`    ${'To'.grey}: ${tx.to}`);
    }
    lines.push(`    ${'Block'.grey}: #${receipt.blockNumber}  ${'Status'.grey}: ${receipt.status === 1 ? 'Success'.green : 'Failed'.red}`);
    lines.push(`    ${'Gas Used'.grey}: ${receipt.gasUsed.toString()}  ${'Logs'.grey}: ${receipt.logs.length}`);
    if (isDefined(decodedCall)) {
      lines.push(`    ${'Function'.grey}: ${`${decodedCall.methodName}()`.cyan}`);
    }
    lines.push('');

    const historyActions = await inferWalletActionsFromHistoryItem(
      chainName,
      item,
    );

    // Decode all logs from the receipt
    const decoded: (DecodedEvent | { eventName: string; address: string; args: Record<string, string>; logIndex: number; raw: true })[] = [];
    for (const log of receipt.logs) {
      const d = tryDecodeLog(log);
      if (d) {
        decoded.push(d);
      } else {
        // Show undecodable logs with their topic0 so we can identify them
        const topic0 = log.topics[0] ?? 'no-topic';
        decoded.push({
          eventName: `Unknown(${topic0.slice(0, 10)}…)`,
          address: log.address,
          args: { topic0 },
          logIndex: log.index,
          raw: true,
        });
      }
    }

    const concreteDecodedEvents = decoded.filter(
      (evt): evt is DecodedEvent => !('raw' in evt),
    );
    const inferredActions = await inferWalletActionsFromDecodedData(
      chainName,
      concreteDecodedEvents,
      decodedCall,
      walletAddresses,
    );

    const mergedActions = [...historyActions];
    for (const action of inferredActions) {
      pushUnique(mergedActions, action);
    }

    lines.push(`  ${'Detected Wallet Actions'.bold} (${mergedActions.length}):`);
    if (mergedActions.length === 0) {
      lines.push(`    ${'No wallet-specific actions inferred from decoded data.'.dim}`);
    } else {
      for (const [actionIdx, action] of mergedActions.entries()) {
        lines.push(`    [${actionIdx}] ${action.green}`);
      }
    }
    lines.push('');

    if (showDecodedEvents) {
      lines.push(`  ${'Decoded Events'.bold} (${decoded.length}):`);
      lines.push('');

      for (const [evtIdx, evt] of decoded.entries()) {
        const evtLines = await formatDecodedEvent(chainName, evt, evtIdx);
        lines.push(...evtLines);
      }
    } else {
      lines.push(`  ${'Decoded Events'.bold}: ${'Hidden'.dim} (${decoded.length} available)`);
    }
  } catch (err: any) {
    lines.push(`    ${'Error querying on-chain data:'.red} ${err.message ?? err}`);
  }

  return lines;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const categoryLabel = (cat: TransactionHistoryItemCategory): string => {
  switch (cat) {
    case TransactionHistoryItemCategory.ShieldERC20s:
      return "SHIELD";
    case TransactionHistoryItemCategory.UnshieldERC20s:
      return "UNSHIELD";
    case TransactionHistoryItemCategory.TransferSendERC20s:
      return "SEND";
    case TransactionHistoryItemCategory.TransferReceiveERC20s:
      return "RECEIVE";
    default:
      return "UNKNOWN";
  }
};

const categoryColor = (cat: TransactionHistoryItemCategory): string => {
  switch (cat) {
    case TransactionHistoryItemCategory.ShieldERC20s:
      return "green";
    case TransactionHistoryItemCategory.UnshieldERC20s:
      return "yellow";
    case TransactionHistoryItemCategory.TransferSendERC20s:
      return "red";
    case TransactionHistoryItemCategory.TransferReceiveERC20s:
      return "cyan";
    default:
      return "grey";
  }
};

const colorize = (text: string, color: string): string => {
  switch (color) {
    case "green":
      return text.green;
    case "yellow":
      return text.yellow;
    case "red":
      return text.red;
    case "cyan":
      return text.cyan;
    case "grey":
      return text.grey;
    default:
      return text;
  }
};

type EvaluatedTxAction = "SHIELD" | "UNSHIELD" | "SEND" | "RECEIVE";

type EvaluatedActionWithAsset = {
  action: EvaluatedTxAction;
  assetType: AssetTypeLabel;
};

const hasPositiveAmount = (
  value: Optional<string | number | bigint>,
): boolean => {
  if (!isDefined(value)) return false;

  if (typeof value === "bigint") {
    return value > 0n;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }

  if (!/^\d+$/.test(value)) {
    return false;
  }

  return BigInt(value) > 0n;
};

const evaluateTxActionsWithAsset = (
  item: TransactionHistoryItem,
): EvaluatedActionWithAsset[] => {
  const actions: EvaluatedActionWithAsset[] = [];

  const addAction = (action: EvaluatedTxAction, assetType: AssetTypeLabel) => {
    if (!actions.find((x) => x.action === action && x.assetType === assetType)) {
      actions.push({ action, assetType });
    }
  };

  const hasShieldFee = item.receiveERC20Amounts.some((x) =>
    hasPositiveAmount(x.shieldFee),
  );

  const hasUnshieldERC20 =
    item.unshieldERC20Amounts.length > 0 ||
    item.unshieldERC20Amounts.some((x) => hasPositiveAmount(x.unshieldFee));

  const hasUnshieldNFT =
    item.unshieldNFTAmounts.length > 0 ||
    item.unshieldNFTAmounts.some((x) => hasPositiveAmount(x.unshieldFee));

  const hasSendERC20 = item.transferERC20Amounts.length > 0;
  const hasSendNFT = item.transferNFTAmounts.length > 0;

  const hasReceiveERC20 = item.receiveERC20Amounts.length > 0;
  const hasReceiveNFT = item.receiveNFTAmounts.length > 0;

  if (hasShieldFee) {
    addAction("SHIELD", "ERC20");
  }

  if (hasUnshieldERC20) {
    addAction("UNSHIELD", "ERC20");
  }

  if (hasUnshieldNFT) {
    addAction("UNSHIELD", "NFT");
  }

  if (hasSendERC20) {
    addAction("SEND", "ERC20");
  }

  if (hasSendNFT) {
    addAction("SEND", "NFT");
  }

  if (hasReceiveERC20 && !hasShieldFee) {
    addAction("RECEIVE", "ERC20");
  }

  if (hasReceiveNFT) {
    addAction("RECEIVE", "NFT");
  }

  return actions;
};

const evaluateTxActions = (
  item: TransactionHistoryItem,
): EvaluatedTxAction[] => {
  return evaluateTxActionsWithAsset(item).reduce<EvaluatedTxAction[]>(
    (list, entry) => {
      if (!list.includes(entry.action)) {
        list.push(entry.action);
      }
      return list;
    },
    [],
  );
};

const actionColor = (action: EvaluatedTxAction): string => {
  switch (action) {
    case "SHIELD":
      return "green";
    case "UNSHIELD":
      return "yellow";
    case "SEND":
      return "red";
    case "RECEIVE":
      return "cyan";
    default:
      return "grey";
  }
};

const formatActionList = (item: TransactionHistoryItem): string => {
  const actions = evaluateTxActionsWithAsset(item);
  if (actions.length === 0) {
    return "UNKNOWN".grey;
  }

  return actions
    .map((entry) =>
      colorize(`${entry.action} [${entry.assetType}]`, actionColor(entry.action)),
    )
    .join(", ");
};

const actionBadgeForSummary = (item: TransactionHistoryItem): string => {
  const actions = evaluateTxActions(item);
  if (actions.length === 0) {
    return colorize(`[${"UNKNOWN".padEnd(9, " ")}]`, "grey");
  }

  const [primary] = actions;
  return colorize(`[${primary.padEnd(9, " ")}]`, actionColor(primary));
};

const formatTimestamp = (ts: Optional<number>): string => {
  if (!isDefined(ts)) return "Unknown Date";
  return new Date(ts * 1000).toLocaleString();
};

const truncateHash = (hash: string, len = 8): string => {
  if (hash.length <= len * 2 + 2) return hash;
  return `${hash.slice(0, len + 2)}...${hash.slice(-len)}`;
};

const formatTokenAmount = (
  amount: bigint,
  decimals: number,
  symbol: string,
): string => {
  const readable = readablePrecision(amount, decimals, 6);
  return `${readable} ${symbol}`;
};

// ─── Summary Line Builder ───────────────────────────────────────────────────

type TokenSummary = { symbol: string; amount: bigint; decimals: number };

const buildTokenSummaries = async (
  chainName: NetworkName,
  amounts: Array<{ tokenAddress: string; amount: bigint }>,
): Promise<TokenSummary[]> => {
  const summaries: TokenSummary[] = [];
  for (const entry of amounts) {
    try {
      const { symbol, decimals } = await getTokenInfo(
        chainName,
        entry.tokenAddress,
      );
      summaries.push({ symbol, amount: entry.amount, decimals });
    } catch {
      summaries.push({
        symbol: truncateHash(entry.tokenAddress, 4),
        amount: entry.amount,
        decimals: 18,
      });
    }
  }
  return summaries;
};

const summaryAmountString = (summaries: TokenSummary[]): string => {
  if (summaries.length === 0) return "";
  return summaries
    .map((s) => formatTokenAmount(s.amount, s.decimals, s.symbol))
    .join(", ");
};

const formatNFTListSummary = (
  nfts: Array<{
    nftAddress: string;
    tokenSubID: string | number | bigint;
    amount: string | number | bigint;
  }>,
): string => {
  if (nfts.length === 0) return "";
  if (nfts.length === 1) {
    const [nft] = nfts;
    return `${truncateHash(nft.nftAddress, 4)}#${nft.tokenSubID.toString()} x${nft.amount.toString()}`;
  }
  return `${nfts.length} NFTs`;
};

// ─── Build Summary Line for List View ───────────────────────────────────────

const buildTxSummaryLine = async (
  chainName: NetworkName,
  item: TransactionHistoryItem,
  index: number,
): Promise<{ name: string; message: string }> => {
  const time = formatTimestamp(item.timestamp);
  const block = isDefined(item.blockNumber) ? `#${item.blockNumber}` : "";

  // Collect the primary amounts for the summary line
  let primaryAmounts: Array<{ tokenAddress: string; amount: bigint }> = [];

  const actions = evaluateTxActions(item);
  if (actions.includes("UNSHIELD")) {
    primaryAmounts = item.unshieldERC20Amounts.map((a) => ({
      tokenAddress: a.tokenAddress,
      amount: a.amount,
    }));
  } else if (actions.includes("SHIELD") || actions.includes("RECEIVE")) {
    primaryAmounts = item.receiveERC20Amounts.map((a) => ({
      tokenAddress: a.tokenAddress,
      amount: a.amount,
    }));
  } else if (actions.includes("SEND")) {
    primaryAmounts = item.transferERC20Amounts.map((a) => ({
      tokenAddress: a.tokenAddress,
      amount: a.amount,
    }));
  }

  if (primaryAmounts.length === 0) {
    primaryAmounts = [
      ...item.receiveERC20Amounts,
      ...item.transferERC20Amounts,
      ...item.unshieldERC20Amounts,
    ].map((a) => ({ tokenAddress: a.tokenAddress, amount: a.amount }));
  }

  const tokenSummaries = await buildTokenSummaries(chainName, primaryAmounts);
  const amountStr = summaryAmountString(tokenSummaries);

  let nftSummary = "";
  if (amountStr.length === 0) {
    if (actions.includes("UNSHIELD")) {
      nftSummary = formatNFTListSummary(item.unshieldNFTAmounts);
    } else if (actions.includes("SEND")) {
      nftSummary = formatNFTListSummary(item.transferNFTAmounts);
    } else if (actions.includes("SHIELD") || actions.includes("RECEIVE")) {
      nftSummary = formatNFTListSummary(item.receiveNFTAmounts);
    }

    if (nftSummary.length === 0) {
      nftSummary = formatNFTListSummary([
        ...item.receiveNFTAmounts,
        ...item.transferNFTAmounts,
        ...item.unshieldNFTAmounts,
      ]);
    }
  }

  const amountOrNft = amountStr.length > 0 ? amountStr : nftSummary.length > 0 ? `[NFT] ${nftSummary}` : "—";
  const indexStr = `[${String(index).padStart(3, " ")}]`.grey;
  const tagStr = actionBadgeForSummary(item);
  const timeStr = time.grey;
  const blockStr = block.dim;

  const message = `${indexStr} ${tagStr} ${amountOrNft} ${timeStr} ${blockStr}`;

  return { name: `tx-${index}`, message };
};

// ─── Detail View ────────────────────────────────────────────────────────────

const buildTxDetailView = async (
  chainName: NetworkName,
  item: TransactionHistoryItem,
  globalIndex: number,
): Promise<string> => {
  const evaluatedActions = evaluateTxActions(item);
  const headerLabel =
    evaluatedActions.length === 0 ? "UNKNOWN" : evaluatedActions.join("+");
  const headerColor =
    evaluatedActions.length === 1 ? actionColor(evaluatedActions[0]) : "grey";

  const lines: string[] = [];

  lines.push("");
  lines.push(`${"═".repeat(60)}`.grey);
  lines.push(
    `  ${"Transaction Detail".bold}  ${colorize(`[${headerLabel}]`, headerColor)}  ${"#".grey}${String(globalIndex).grey}`,
  );
  lines.push(`${"═".repeat(60)}`.grey);
  lines.push("");

  // ── Base Info ──
  lines.push(`  ${"TXID".grey.bold}:         ${item.txid}`);
  lines.push(
    `  ${"Version".grey.bold}:      ${item.txidVersion} (v${item.version})`,
  );
  lines.push(
    `  ${"Block".grey.bold}:        ${isDefined(item.blockNumber) ? `#${item.blockNumber}` : "Pending"}`,
  );
  lines.push(`  ${"Timestamp".grey.bold}:    ${formatTimestamp(item.timestamp)}`);
  lines.push(
    `  ${"Actions".grey.bold}:      ${formatActionList(item)}`,
  );
  lines.push("");

  // ── Received Amounts ──
  if (item.receiveERC20Amounts.length > 0) {
    lines.push(`  ${"Received ERC20s".green.bold}:`);
    for (const [i, rcv] of item.receiveERC20Amounts.entries()) {
      try {
        const { symbol, decimals } = await getTokenInfo(
          chainName,
          rcv.tokenAddress,
        );
        const amt = formatTokenAmount(rcv.amount, decimals, symbol);
        lines.push(`    [${i}] ${amt}`);
        if (isDefined(rcv.senderAddress)) {
          lines.push(`        ${"From".grey}: ${rcv.senderAddress}`);
        }
        if (isDefined(rcv.memoText) && rcv.memoText.length > 0) {
          lines.push(`        ${"Memo".grey}: ${rcv.memoText}`);
        }
        if (isDefined(rcv.shieldFee)) {
          lines.push(
            `        ${"Shield Fee".grey}: ${rcv.shieldFee}`,
          );
        }
        lines.push(
          `        ${"POI Valid".grey}: ${rcv.hasValidPOIForActiveLists ? "Yes".green : "No".red}`,
        );
        lines.push(
          `        ${"Bucket".grey}: ${rcv.balanceBucket}`,
        );
      } catch {
        lines.push(
          `    [${i}] ${truncateHash(rcv.tokenAddress)} — ${rcv.amount.toString()}`,
        );
      }
    }
    lines.push("");
  }

  // ── Sent/Transfer Amounts ──
  if (item.transferERC20Amounts.length > 0) {
    lines.push(`  ${"Transferred ERC20s".red.bold}:`);
    for (const [i, xfr] of item.transferERC20Amounts.entries()) {
      try {
        const { symbol, decimals } = await getTokenInfo(
          chainName,
          xfr.tokenAddress,
        );
        const amt = formatTokenAmount(xfr.amount, decimals, symbol);
        lines.push(`    [${i}] ${amt}`);
        if (isDefined(xfr.recipientAddress)) {
          lines.push(`        ${"To".grey}: ${xfr.recipientAddress}`);
        }
        if (isDefined(xfr.memoText) && xfr.memoText.length > 0) {
          lines.push(`        ${"Memo".grey}: ${xfr.memoText}`);
        }
        lines.push(
          `        ${"POI Valid".grey}: ${xfr.hasValidPOIForActiveLists ? "Yes".green : "No".red}`,
        );
      } catch {
        lines.push(
          `    [${i}] ${truncateHash(xfr.tokenAddress)} — ${xfr.amount.toString()}`,
        );
      }
    }
    lines.push("");
  }

  // ── Unshield Amounts ──
  if (item.unshieldERC20Amounts.length > 0) {
    lines.push(`  ${"Unshielded ERC20s".yellow.bold}:`);
    for (const [i, uns] of item.unshieldERC20Amounts.entries()) {
      try {
        const { symbol, decimals } = await getTokenInfo(
          chainName,
          uns.tokenAddress,
        );
        const amt = formatTokenAmount(uns.amount, decimals, symbol);
        lines.push(`    [${i}] ${amt}`);
        if (isDefined(uns.recipientAddress)) {
          lines.push(`        ${"To".grey}: ${uns.recipientAddress}`);
        }
        if (isDefined(uns.memoText) && uns.memoText.length > 0) {
          lines.push(`        ${"Memo".grey}: ${uns.memoText}`);
        }
        if (isDefined(uns.unshieldFee)) {
          lines.push(
            `        ${"Unshield Fee".grey}: ${uns.unshieldFee}`,
          );
        }
        lines.push(
          `        ${"POI Valid".grey}: ${uns.hasValidPOIForActiveLists ? "Yes".green : "No".red}`,
        );
      } catch {
        lines.push(
          `    [${i}] ${truncateHash(uns.tokenAddress)} — ${uns.amount.toString()}`,
        );
      }
    }
    lines.push("");
  }

  // ── Change Amounts ──
  if (item.changeERC20Amounts.length > 0) {
    lines.push(`  ${"Change ERC20s".dim.bold}:`);
    for (const [i, chg] of item.changeERC20Amounts.entries()) {
      try {
        const { symbol, decimals } = await getTokenInfo(
          chainName,
          chg.tokenAddress,
        );
        const amt = formatTokenAmount(chg.amount, decimals, symbol);
        lines.push(`    [${i}] ${amt}`);
      } catch {
        lines.push(
          `    [${i}] ${truncateHash(chg.tokenAddress)} — ${chg.amount.toString()}`,
        );
      }
    }
    lines.push("");
  }

  // ── Broadcaster Fee ──
  if (isDefined(item.broadcasterFeeERC20Amount)) {
    const fee = item.broadcasterFeeERC20Amount;
    lines.push(`  ${"Broadcaster Fee".magenta.bold}:`);
    try {
      const { symbol, decimals } = await getTokenInfo(
        chainName,
        fee.tokenAddress,
      );
      const amt = formatTokenAmount(fee.amount, decimals, symbol);
      lines.push(`    ${amt}`);
      lines.push(
        `    ${"POI Valid".grey}: ${fee.hasValidPOIForActiveLists ? "Yes".green : "No".red}`,
      );
    } catch {
      lines.push(
        `    ${truncateHash(fee.tokenAddress)} — ${fee.amount.toString()}`,
      );
    }
    lines.push("");
  }

  // ── NFT Sections ──
  if (item.receiveNFTAmounts.length > 0) {
    lines.push(`  ${"Received NFTs".green.bold}:`);
    for (const [i, nft] of item.receiveNFTAmounts.entries()) {
      lines.push(
        `    [${i}] ${truncateHash(nft.nftAddress)} (ID: ${nft.tokenSubID}) x${nft.amount}`,
      );
      if (isDefined(nft.senderAddress)) {
        lines.push(`        ${"From".grey}: ${nft.senderAddress}`);
      }
    }
    lines.push("");
  }

  if (item.transferNFTAmounts.length > 0) {
    lines.push(`  ${"Transferred NFTs".red.bold}:`);
    for (const [i, nft] of item.transferNFTAmounts.entries()) {
      lines.push(
        `    [${i}] ${truncateHash(nft.nftAddress)} (ID: ${nft.tokenSubID}) x${nft.amount}`,
      );
      if (isDefined(nft.recipientAddress)) {
        lines.push(`        ${"To".grey}: ${nft.recipientAddress}`);
      }
    }
    lines.push("");
  }

  if (item.unshieldNFTAmounts.length > 0) {
    lines.push(`  ${"Unshielded NFTs".yellow.bold}:`);
    for (const [i, nft] of item.unshieldNFTAmounts.entries()) {
      lines.push(
        `    [${i}] ${truncateHash(nft.nftAddress)} (ID: ${nft.tokenSubID}) x${nft.amount}`,
      );
      if (isDefined(nft.recipientAddress)) {
        lines.push(`        ${"To".grey}: ${nft.recipientAddress}`);
      }
      if (isDefined(nft.unshieldFee)) {
        lines.push(
          `        ${"Unshield Fee".grey}: ${nft.unshieldFee}`,
        );
      }
    }
    lines.push("");
  }

  // ── Fee / Cost Summary ──
  lines.push(`${"─".repeat(60)}`.grey);
  lines.push(`  ${"Fees & Protocol Costs".bold}:`);

  let hasFees = false;

  // Broadcaster fee line
  if (isDefined(item.broadcasterFeeERC20Amount)) {
    const fee = item.broadcasterFeeERC20Amount;
    try {
      const { symbol, decimals } = await getTokenInfo(
        chainName,
        fee.tokenAddress,
      );
      lines.push(
        `    ${"Broadcaster".grey}:  ${formatTokenAmount(fee.amount, decimals, symbol)}`,
      );
      hasFees = true;
    } catch {
      // skip
    }
  }

  // Shield fees
  for (const rcv of item.receiveERC20Amounts) {
    if (isDefined(rcv.shieldFee) && rcv.shieldFee !== "0") {
      try {
        const { symbol, decimals } = await getTokenInfo(
          chainName,
          rcv.tokenAddress,
        );
        const feeAmount = BigInt(rcv.shieldFee);
        if (feeAmount > 0n) {
          lines.push(
            `    ${"Shield Fee".grey}:    ${formatTokenAmount(feeAmount, decimals, symbol)}`,
          );
          hasFees = true;
        }
      } catch {
        // skip
      }
    }
  }

  // Unshield fees
  for (const uns of item.unshieldERC20Amounts) {
    if (isDefined(uns.unshieldFee) && uns.unshieldFee !== "0") {
      try {
        const { symbol, decimals } = await getTokenInfo(
          chainName,
          uns.tokenAddress,
        );
        const feeAmount = BigInt(uns.unshieldFee);
        if (feeAmount > 0n) {
          lines.push(
            `    ${"Unshield Fee".grey}: ${formatTokenAmount(feeAmount, decimals, symbol)}`,
          );
          hasFees = true;
        }
      } catch {
        // skip
      }
    }
  }

  if (!hasFees) {
    lines.push(`    ${"None / Self-Relayed".dim}`);
  }

  lines.push(`${"─".repeat(60)}`.grey);
  lines.push("");

  return lines.join("\n");
};

// ─── Fetch & Sort History ───────────────────────────────────────────────────

const fetchTxHistory = async (
  chainName: NetworkName,
): Promise<TransactionHistoryItem[]> => {
  const chain = getChainForName(chainName);
  const railgunWalletID = getCurrentRailgunID();
  const history = await getWalletTransactionHistory(
    chain,
    railgunWalletID,
    undefined, // startingBlock – fetch all
  );

  // Sort newest first
  return history.sort((a, b) => {
    const tsA = a.timestamp ?? 0;
    const tsB = b.timestamp ?? 0;
    return tsB - tsA;
  });
};

// ─── Paginated List Prompt ──────────────────────────────────────────────────

export const runTransactionHistoryViewer = async (
  chainName: NetworkName,
): Promise<void> => {
  clearConsoleBuffer();
  console.log(`\n  ${"Loading transaction history...".dim}\n`);

  let allItems: TransactionHistoryItem[];
  try {
    allItems = await fetchTxHistory(chainName);
  } catch (err: any) {
    console.log(`  ${"Error fetching transaction history:".red} ${err.message}`);
    await confirmPromptCatchRetry("Could not load history.");
    return;
  }

  if (allItems.length === 0) {
    await confirmPromptCatchRetry("No transaction history found.");
    return;
  }

  let currentPage = 0;

  const showPage = async (): Promise<void> => {
    const totalPages = Math.ceil(allItems.length / PAGE_SIZE);
    const startIdx = currentPage * PAGE_SIZE;
    const endIdx = Math.min(startIdx + PAGE_SIZE, allItems.length);
    const pageItems = allItems.slice(startIdx, endIdx);

    // Build choice list for this page
    const choicePromises = pageItems.map((item, i) =>
      buildTxSummaryLine(chainName, item, startIdx + i + 1),
    );
    const txChoices = await Promise.all(choicePromises);

    const navChoices: Array<{ name: string; message: string; role?: string }> =
      [];

    navChoices.push({
      name: "separator-nav",
      message: `${"─".repeat(50)}`,
      role: "separator",
    });

    if (currentPage > 0) {
      navChoices.push({
        name: "prev-page",
        message: `${"◀".grey} Previous Page`,
      });
    }
    if (currentPage < totalPages - 1) {
      navChoices.push({
        name: "next-page",
        message: `${"▶".grey} Next Page`,
      });
    }
    navChoices.push({
      name: "exit-history",
      message: "Go Back".grey,
    });

    clearConsoleBuffer();

    const pageHeader = [
      "",
      `  ${"Transaction History".bold}  —  ${chainName.green}`,
      `  ${"Page".grey} ${currentPage + 1}/${totalPages}  |  ${allItems.length} ${"total transactions".grey}`,
      `  ${"─".repeat(56)}`.grey,
      "",
    ].join("\n");

    const prompt = new Select({
      header: pageHeader,
      message: `Select a transaction to view details`,
      format: " ",
      choices: [...txChoices, ...navChoices],
      multiple: false,
    });

    const selection = await prompt.run().catch(confirmPromptCatch);

    if (!selection || selection === "exit-history") {
      return;
    }

    if (selection === "prev-page") {
      currentPage = Math.max(0, currentPage - 1);
      return showPage();
    }

    if (selection === "next-page") {
      currentPage = Math.min(totalPages - 1, currentPage + 1);
      return showPage();
    }

    // Selection is a tx – parse index
    if (typeof selection === "string" && selection.startsWith("tx-")) {
      const txIndex = parseInt(selection.replace("tx-", ""), 10) - 1;
      if (txIndex >= 0 && txIndex < allItems.length) {
        clearConsoleBuffer();
        const detail = await buildTxDetailView(
          chainName,
          allItems[txIndex],
          txIndex + 1,
        );
        console.log(detail);
        await confirmPromptCatchRetry("");
      }
      return showPage();
    }

    return showPage();
  };

  await showPage();
};
