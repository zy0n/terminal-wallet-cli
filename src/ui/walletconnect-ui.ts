import {
  isDefined,
  type RailgunERC20Amount,
  type RailgunERC20AmountRecipient,
  type RailgunERC20Recipient,
  type RailgunNFTAmount,
  type RailgunNFTAmountRecipient,
} from "@railgun-community/shared-models";
import { Interface } from "ethers";
import {
  approveWalletConnectSessionRequest,
  approveWalletConnectSessionProposal,
  clearWalletConnectCapturedBundles,
  disconnectWalletConnectSession,
  getWalletConnectPendingSessionRequests,
  listWalletConnectCapturedBundles,
  getWalletConnectSessionSummary,
  getWalletConnectPendingSessionProposals,
  initializeWalletConnectKit,
  listWalletConnectSessions,
  pairWalletConnectURI,
  rejectWalletConnectSessionRequest,
  rejectWalletConnectSessionProposal,
} from "../walletconnect/walletconnect-bridge";
import { confirmPrompt, confirmPromptCatch, confirmPromptCatchRetry } from "./confirm-ui";
import {
  getCurrentWalletPublicAddress,
  getCurrentRailgunAddress,
  getGasBalanceForAddress,
} from "../wallet/wallet-util";
import {
  getCurrentKnownEphemeralState,
  setEphemeralWalletIndex,
  setCurrentEphemeralWalletSession,
  syncCurrentEphemeralWallet,
} from "../wallet/ephemeral-wallet-manager";
import { getSaltedPassword } from "../wallet/wallet-password";
import { getCurrentNetwork } from "../engine/engine";
import { getTokenInfo } from "../balance/token-util";
import { getWrappedTokenInfoForChain } from "../network/network-util";
import { getProviderForChain } from "../network/network-util";
import { getRailgunRelayAdaptAddressForChain } from "../network/network-util";
import {
  getCrossContract7702GasEstimate,
  getProvedCrossContract7702Transaction,
} from "../transaction/private/cross-contract-7702";
import { runFeeTokenSelector } from "./token-ui";
import { sendBroadcastedTransaction } from "../transaction/transaction-builder";
import { RailgunTransaction } from "../models/transaction-models";
import { WalletConnectBundledCall } from "../models/wallet-models";
import {
  getActiveStealthProfile,
  listStealthProfiles,
  setActiveStealthProfile,
} from "../wallet/stealth-profile-manager";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Input, Select } = require("enquirer");

const ERC721_TRANSFER_INTERFACE = new Interface([
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
]);

const ERC1155_TRANSFER_INTERFACE = new Interface([
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
]);

const shortAddress = (address?: string) => {
  if (!isDefined(address) || address.length < 12) {
    return "n/a";
  }
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
};

type ConnectedAccountType = "public" | "ephemeral" | "stealth" | "other";

const getConnectedAccountTypeForAddress = (
  connectedAddress?: string,
): ConnectedAccountType => {
  if (!isDefined(connectedAddress)) {
    return "other";
  }

  const normalized = connectedAddress.toLowerCase();
  const normalizedPublic = getCurrentWalletPublicAddress().toLowerCase();
  const normalizedEphemeral = getCurrentKnownEphemeralState()?.currentAddress?.toLowerCase();

  if (normalized === normalizedPublic) {
    return "public";
  }
  if (isDefined(normalizedEphemeral) && normalized === normalizedEphemeral) {
    return "ephemeral";
  }

  const linkedStealth = listStealthProfiles().some((profile) => {
    return profile.accountAddress?.toLowerCase() === normalized;
  });
  if (linkedStealth) {
    return "stealth";
  }

  return "other";
};

const isHexAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);

const parseBigIntLike = (value: unknown): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Invalid numeric value.");
    }
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    if (/^[0-9]+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
  }
  throw new Error("Expected bigint-like value (decimal or hex string).");
};

const parseOptionalJSONArray = async <T>(
  message: string,
  parser: (item: unknown, index: number) => T,
): Promise<T[]> => {
  const prompt = new Input({
    header: " ",
    message,
  });

  const raw = (await prompt.run().catch(confirmPromptCatch)) as string | undefined;
  if (!isDefined(raw)) {
    return [];
  }

  const trimmed = raw.trim();
  if (!trimmed.length) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid JSON input.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Input must be a JSON array.");
  }

  return parsed.map(parser);
};

const parseERC20AmountArray = async (): Promise<RailgunERC20Amount[]> => {
  return parseOptionalJSONArray<RailgunERC20Amount>(
    "Optional unshield ERC20 JSON (blank for none): [{\"tokenAddress\":\"0x...\",\"amount\":\"1000000000000000000\"}]",
    (item, index) => {
      const tokenAddress = (item as any)?.tokenAddress;
      const amount = (item as any)?.amount;
      if (typeof tokenAddress !== "string" || !isHexAddress(tokenAddress.trim())) {
        throw new Error(`Invalid ERC20 tokenAddress at index ${index}.`);
      }
      const parsedAmount = parseBigIntLike(amount);
      if (parsedAmount <= 0n) {
        throw new Error(`ERC20 amount must be > 0 at index ${index}.`);
      }

      return {
        tokenAddress: tokenAddress.trim().toLowerCase(),
        amount: parsedAmount,
      };
    },
  );
};

const parseERC20RecipientArray = async (): Promise<RailgunERC20Recipient[]> => {
  return parseOptionalJSONArray<RailgunERC20Recipient>(
    "Optional shield ERC20 JSON (blank for none): [{\"tokenAddress\":\"0x...\",\"recipientAddress\":\"railgun:...\"}]",
    (item, index) => {
      const tokenAddress = (item as any)?.tokenAddress;
      const recipientAddress = (item as any)?.recipientAddress;
      if (typeof tokenAddress !== "string" || !isHexAddress(tokenAddress.trim())) {
        throw new Error(`Invalid shield ERC20 tokenAddress at index ${index}.`);
      }
      if (typeof recipientAddress !== "string" || !recipientAddress.trim().length) {
        throw new Error(`Invalid shield ERC20 recipientAddress at index ${index}.`);
      }

      return {
        tokenAddress: tokenAddress.trim().toLowerCase(),
        recipientAddress: recipientAddress.trim(),
      };
    },
  );
};

const parseNFTAmountArray = async (): Promise<RailgunNFTAmount[]> => {
  return parseOptionalJSONArray<RailgunNFTAmount>(
    "Optional unshield NFT JSON (blank for none): [{\"nftAddress\":\"0x...\",\"tokenSubID\":\"1\",\"amount\":\"1\",\"nftTokenType\":1}]",
    (item, index) => {
      const nftAddress = (item as any)?.nftAddress;
      const tokenSubID = (item as any)?.tokenSubID;
      const amount = (item as any)?.amount;
      const nftTokenType = (item as any)?.nftTokenType;

      if (typeof nftAddress !== "string" || !isHexAddress(nftAddress.trim())) {
        throw new Error(`Invalid NFT address at index ${index}.`);
      }
      const parsedTokenSubID = parseBigIntLike(tokenSubID);
      const parsedAmount = parseBigIntLike(amount);
      const parsedTokenType = Number(nftTokenType);
      if (parsedAmount <= 0n) {
        throw new Error(`NFT amount must be > 0 at index ${index}.`);
      }
      if (![1, 2].includes(parsedTokenType)) {
        throw new Error(`NFT token type must be 1 (ERC721) or 2 (ERC1155) at index ${index}.`);
      }

      return {
        nftAddress: nftAddress.trim().toLowerCase(),
        tokenSubID: parsedTokenSubID.toString(),
        amount: parsedAmount,
        nftTokenType: parsedTokenType,
      } as RailgunNFTAmount;
    },
  );
};

const parseNFTRecipientArray = async (): Promise<RailgunNFTAmountRecipient[]> => {
  return parseOptionalJSONArray<RailgunNFTAmountRecipient>(
    "Optional shield NFT JSON (blank for none): [{\"nftAddress\":\"0x...\",\"tokenSubID\":\"1\",\"amount\":\"1\",\"recipientAddress\":\"railgun:...\",\"nftTokenType\":1}]",
    (item, index) => {
      const nftAddress = (item as any)?.nftAddress;
      const tokenSubID = (item as any)?.tokenSubID;
      const amount = (item as any)?.amount;
      const recipientAddress = (item as any)?.recipientAddress;
      const nftTokenType = (item as any)?.nftTokenType;

      if (typeof nftAddress !== "string" || !isHexAddress(nftAddress.trim())) {
        throw new Error(`Invalid shield NFT address at index ${index}.`);
      }
      if (typeof recipientAddress !== "string" || !recipientAddress.trim().length) {
        throw new Error(`Invalid shield NFT recipientAddress at index ${index}.`);
      }

      const parsedTokenSubID = parseBigIntLike(tokenSubID);
      const parsedAmount = parseBigIntLike(amount);
      const parsedTokenType = Number(nftTokenType);
      if (parsedAmount <= 0n) {
        throw new Error(`Shield NFT amount must be > 0 at index ${index}.`);
      }
      if (![1, 2].includes(parsedTokenType)) {
        throw new Error(`Shield NFT token type must be 1 (ERC721) or 2 (ERC1155) at index ${index}.`);
      }

      return {
        nftAddress: nftAddress.trim().toLowerCase(),
        tokenSubID: parsedTokenSubID.toString(),
        amount: parsedAmount,
        recipientAddress: recipientAddress.trim(),
        nftTokenType: parsedTokenType,
      } as RailgunNFTAmountRecipient;
    },
  );
};

const collectAutoShieldERC20Recipients = async (
  chainName: ReturnType<typeof getCurrentNetwork>,
  bundleCalls: WalletConnectBundledCall[],
  currentShieldRecipients: RailgunERC20Recipient[],
  unshieldERC20Amounts: RailgunERC20Amount[],
) => {
  const currentRailgunAddress = getCurrentRailgunAddress();
  const existingTokenSet = new Set(
    currentShieldRecipients.map((recipient) => recipient.tokenAddress.toLowerCase()),
  );

  unshieldERC20Amounts.forEach((entry) => {
    existingTokenSet.add(entry.tokenAddress.toLowerCase());
  });

  const interactedCandidates = new Set<string>();
  bundleCalls.forEach((call) => {
    const normalized = call.to?.trim().toLowerCase();
    if (normalized && isHexAddress(normalized)) {
      interactedCandidates.add(normalized);
    }
  });

  const autoRecipients: RailgunERC20Recipient[] = [];
  for (const tokenAddress of interactedCandidates) {
    if (existingTokenSet.has(tokenAddress)) {
      continue;
    }

    const tokenInfo = await getTokenInfo(chainName, tokenAddress).catch(() => undefined);
    if (!isDefined(tokenInfo)) {
      continue;
    }

    autoRecipients.push({
      tokenAddress,
      recipientAddress: currentRailgunAddress,
    });
    existingTokenSet.add(tokenAddress);
  }

  return autoRecipients;
};

const formatSessionLine = (session: {
  topic: string;
  version: number;
  relayProtocol?: string;
  connectedAddress?: string;
  scopeID?: string;
  status: string;
  updatedAt: number;
}) => {
  const updatedAt = new Date(session.updatedAt).toISOString();
  const accountInfo = session.connectedAddress
    ? ` · account=${session.connectedAddress}`
    : "";
  const scopeInfo = session.scopeID ? ` · scope=${session.scopeID}` : "";
  const relayInfo = session.relayProtocol ? ` · relay=${session.relayProtocol}` : "";
  return `${session.topic} · v${session.version} · ${session.status}${accountInfo}${scopeInfo}${relayInfo} · updated=${updatedAt}`;
};

const printWalletConnectSessions = () => {
  const sessions = listWalletConnectSessions();
  if (!sessions.length) {
    console.log("No WalletConnect sessions found.".yellow);
    return;
  }

  sessions.forEach((session) => {
    console.log(formatSessionLine(session).grey);
  });
};

const buildWalletConnectCardHeader = async () => {
  try {
    await initializeWalletConnectKit();
  } catch {
    // show cached card state if WalletConnect runtime cannot initialize yet
  }

  const summary = getWalletConnectSessionSummary();
  const sessions = listWalletConnectSessions().slice(0, 3);
  const pendingCount = summary.pendingProposals;
  const pendingRequestCount = summary.pendingRequests;

  const cardRows = [
    `${"┌─ WalletConnect Console".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} paired=${summary.paired.toString().green} disconnected=${summary.disconnected
      .toString()
      .grey} scoped=${summary.scoped.toString().cyan} proposals=${pendingCount
      .toString()
      .yellow} requests=${pendingRequestCount
      .toString()
      .yellow}`,
    `${"│".grey} captured-bundles=${summary.capturedBundles.toString().magenta}`,
    `${"│".grey} latest-account=${shortAddress(summary.latestConnectedAddress)}`,
    `${"│".grey} acct: public | ephemeral | stealth | other`,
  ];

  if (!sessions.length) {
    cardRows.push(`${"│".grey} sessions: none`);
  } else {
    cardRows.push(`${"│".grey} recent sessions:`);
    sessions.forEach((session) => {
      const statusColor = session.status === "paired" ? "green" : "grey";
      const accountType = getConnectedAccountTypeForAddress(session.connectedAddress);
      cardRows.push(
        `${"│".grey} - ${session.topic.slice(0, 16)}... ${
          session.status[statusColor]
        } ${`acct=${accountType}`.cyan} ${session.scopeID ? `scope=${session.scopeID}` : ""}`.trimEnd(),
      );
    });
  }

  cardRows.push(`${"└─".grey}`);
  return cardRows.join("\n");
};

const printPendingWalletConnectProposals = async () => {
  const proposals = await getWalletConnectPendingSessionProposals();
  if (!proposals.length) {
    console.log("No pending WalletConnect session proposals.".yellow);
    return;
  }

  proposals.forEach((proposal) => {
    const requiredNamespaces = Object.keys(proposal.requiredNamespaces).join(", ");
    const optionalNamespaces = Object.keys(proposal.optionalNamespaces ?? {}).join(", ");
    console.log(
      [
        `Proposal #${proposal.id} from ${proposal.proposerName}`,
        `pairingTopic=${proposal.pairingTopic}`,
        `required=[${requiredNamespaces || "none"}]`,
        `optional=[${optionalNamespaces || "none"}]`,
      ].join(" · ").grey,
    );
  });
};

const printPendingWalletConnectRequests = async () => {
  const requests = await getWalletConnectPendingSessionRequests();
  if (!requests.length) {
    console.log("No pending WalletConnect session requests.".yellow);
    return;
  }

  requests.forEach((request) => {
    const expiresAt = isDefined(request.expiryTimestamp)
      ? new Date(request.expiryTimestamp * 1000).toISOString()
      : "n/a";
    const accountType = getConnectedAccountContext(request.topic).type;
    console.log(
      [
        `Request #${request.id}`,
        `topic=${request.topic}`,
        `method=${request.method}`,
        `acct=${accountType}`,
        `chain=${request.chainId ?? "n/a"}`,
        `origin=${request.origin ?? "n/a"}`,
        `expires=${expiresAt}`,
      ].join(" · ").grey,
    );
  });
};

const selectPendingRequestID = async (): Promise<Optional<number>> => {
  const requests = await getWalletConnectPendingSessionRequests();
  if (!requests.length) {
    console.log("No pending WalletConnect session requests.".yellow);
    return undefined;
  }

  const prompt = new Select({
    header: " ",
    message: "Select pending WalletConnect request",
    choices: [
      ...requests.map((request) => ({
        name: request.id.toString(),
        message: `#${request.id} ${request.method} (${request.topic.slice(0, 16)}...)`,
      })),
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return undefined;
  }

  const requestID = Number(selection);
  if (!Number.isInteger(requestID)) {
    return undefined;
  }
  return requestID;
};

const isTxExecutionMethod = (method: string) => {
  return method === "eth_sendTransaction" || method === "wallet_sendCalls";
};

const getConnectedAccountContext = (topic: string): {
  connectedAddress?: string;
  type: ConnectedAccountType;
} => {
  const sessions = listWalletConnectSessions();
  const connectedAddress = sessions.find((session) => {
    return session.topic === topic;
  })?.connectedAddress?.toLowerCase();

  if (!isDefined(connectedAddress)) {
    return { connectedAddress: undefined, type: "other" };
  }

  return {
    connectedAddress,
    type: getConnectedAccountTypeForAddress(connectedAddress),
  };
};

const getRequestedFromAddressForRequest = (
  method: string,
  params: unknown,
): Optional<string> => {
  if (method === "eth_sendTransaction") {
    if (!Array.isArray(params) || params.length < 1) {
      return undefined;
    }
    const txLike = params[0] as Record<string, unknown>;
    const from = typeof txLike?.from === "string" ? txLike.from.trim().toLowerCase() : "";
    return isHexAddress(from) ? from : undefined;
  }

  if (method === "wallet_sendCalls") {
    const root = Array.isArray(params) ? params[0] : params;
    const from = typeof (root as any)?.from === "string"
      ? ((root as any).from as string).trim().toLowerCase()
      : "";
    return isHexAddress(from) ? from : undefined;
  }

  return undefined;
};

const getSigningContextForRequest = (
  topicContext: { connectedAddress?: string; type: ConnectedAccountType },
  method: string,
  params: unknown,
): { connectedAddress?: string; type: ConnectedAccountType } => {
  const requestedFrom = getRequestedFromAddressForRequest(method, params);
  if (!isDefined(requestedFrom)) {
    return topicContext;
  }

  return {
    connectedAddress: requestedFrom,
    type: getConnectedAccountTypeForAddress(requestedFrom),
  };
};

const getCapturedBundleForRequest = (requestID: number, topic: string) => {
  return listWalletConnectCapturedBundles().find((bundle) => {
    return bundle.requestId === requestID && bundle.topic === topic;
  });
};

const getStealthSignerScopeForAddress = (connectedAddress: string) => {
  const normalized = connectedAddress.toLowerCase();
  const profile = listStealthProfiles().find((item) => {
    return item.accountAddress?.toLowerCase() === normalized;
  });
  if (!isDefined(profile)) {
    return undefined;
  }

  if (isDefined(profile.signerStrategyScopeID) && profile.signerStrategyScopeID.trim().length) {
    return profile.signerStrategyScopeID.trim();
  }
  if (isDefined(profile.scopeID) && profile.scopeID.trim().length) {
    return profile.scopeID.trim();
  }
  if (isDefined(profile.slot)) {
    return `slot-${profile.slot}`;
  }

  return undefined;
};

const getStealthSignerScopeCandidatesForAddress = (connectedAddress: string) => {
  const normalized = connectedAddress.toLowerCase();
  const profile = listStealthProfiles().find((item) => {
    return item.accountAddress?.toLowerCase() === normalized;
  });
  if (!isDefined(profile)) {
    return [] as string[];
  }

  const candidates: string[] = [];
  const add = (value?: string) => {
    if (!isDefined(value)) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed.length) {
      return;
    }
    if (!candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  add(profile.signerStrategyScopeID);
  add(profile.scopeID);
  if (isDefined(profile.slot)) {
    add(`slot-${profile.slot}`);
  }

  if (isDefined(profile.signerStrategyScopeID)) {
    const maybeNumber = Number(profile.signerStrategyScopeID);
    if (Number.isInteger(maybeNumber) && maybeNumber >= 0) {
      add(`slot-${maybeNumber}`);
    }
  }

  return candidates;
};

const getStealthProfileForAddress = (connectedAddress: string) => {
  const normalized = connectedAddress.toLowerCase();
  return listStealthProfiles().find((item) => {
    return item.accountAddress?.toLowerCase() === normalized;
  });
};

const getPreferredScopeForProfile = (profile: {
  scopeID?: string;
  signerStrategyScopeID?: string;
  slot?: number;
}) => {
  if (isDefined(profile.signerStrategyScopeID) && profile.signerStrategyScopeID.trim().length) {
    return profile.signerStrategyScopeID.trim();
  }
  if (isDefined(profile.scopeID) && profile.scopeID.trim().length) {
    return profile.scopeID.trim();
  }
  if (isDefined(profile.slot)) {
    return `slot-${profile.slot}`;
  }
  return undefined;
};

const prepareSignerForConnectedSessionAddress = async (context: {
  connectedAddress?: string;
  type: ConnectedAccountType;
}) => {
  if (!isDefined(context.connectedAddress)) {
    throw new Error("Connected session address is missing.");
  }

  let resolvedAddress: Optional<string>;

  if (context.type === "ephemeral") {
    const encryptionKey = await getSaltedPassword();
    if (!isDefined(encryptionKey)) {
      throw new Error("Missing wallet password for ephemeral signer sync.");
    }
    const session = await setCurrentEphemeralWalletSession(encryptionKey);
    resolvedAddress = session?.currentAddress?.toLowerCase();
  }

  if (context.type === "stealth") {
    const encryptionKey = await getSaltedPassword();
    if (!isDefined(encryptionKey)) {
      throw new Error("Missing wallet password for stealth signer sync.");
    }

    const stealthProfile = getStealthProfileForAddress(context.connectedAddress);
    const scopeCandidates = getStealthSignerScopeCandidatesForAddress(
      context.connectedAddress,
    );
    let matchedScope: Optional<string>;

    const profileSlot = stealthProfile?.slot;
    if (typeof profileSlot === "number") {
      for (const scopeID of scopeCandidates) {
        const indexed = await setEphemeralWalletIndex(
          encryptionKey,
          profileSlot,
          scopeID,
        );
        const indexedAddress = indexed?.currentAddress?.toLowerCase();
        if (indexedAddress === context.connectedAddress.toLowerCase()) {
          matchedScope = scopeID;
          resolvedAddress = indexedAddress;
          await setCurrentEphemeralWalletSession(encryptionKey, scopeID);
          break;
        }
      }

      if (!isDefined(matchedScope)) {
        const indexed = await setEphemeralWalletIndex(
          encryptionKey,
          profileSlot,
        );
        const indexedAddress = indexed?.currentAddress?.toLowerCase();
        if (indexedAddress === context.connectedAddress.toLowerCase()) {
          matchedScope = "<slot-default>";
          resolvedAddress = indexedAddress;
          await setCurrentEphemeralWalletSession(encryptionKey);
        }
      }
    }

    if (!isDefined(matchedScope)) {
      for (const scopeID of scopeCandidates) {
        const session = await setCurrentEphemeralWalletSession(encryptionKey, scopeID);
        const currentAddress = session?.currentAddress?.toLowerCase();
        if (currentAddress === context.connectedAddress.toLowerCase()) {
          matchedScope = scopeID;
          resolvedAddress = currentAddress;
          break;
        }
      }
    }

    if (!isDefined(matchedScope)) {
      const fallback = await setCurrentEphemeralWalletSession(encryptionKey);
      const fallbackAddress = fallback?.currentAddress?.toLowerCase();
      if (fallbackAddress === context.connectedAddress.toLowerCase()) {
        matchedScope = "<default>";
        resolvedAddress = fallbackAddress;
      }
    }

    if (isDefined(matchedScope)) {
      console.log(`Stealth signer session matched via scope ${matchedScope}.`.grey);
    }
  }

  const connectedAddress = context.connectedAddress.toLowerCase();
  if (
    (context.type === "ephemeral" || context.type === "stealth")
    && resolvedAddress !== connectedAddress
  ) {
    if (context.type === "stealth") {
      const scopeID = getStealthSignerScopeForAddress(connectedAddress);
      throw new Error(
        `Connected stealth address ${connectedAddress} was not resolved by stealth signer session sync. Update this stealth profile signer scope${isDefined(scopeID) ? ` (currently ${scopeID})` : ""} and resync signer session.`,
      );
    }
    throw new Error(
      `Connected address ${connectedAddress} was not resolved by signer session sync.`,
    );
  }
};

const deriveNFTActionsFromBundledCalls = (
  calls: WalletConnectBundledCall[],
  recipientAddress: string,
): {
  unshieldNFTAmounts: RailgunNFTAmount[];
  shieldNFTRecipients: RailgunNFTAmountRecipient[];
} => {
  const unshieldNFTAmounts: RailgunNFTAmount[] = [];
  const shieldNFTRecipients: RailgunNFTAmountRecipient[] = [];
  const seen = new Set<string>();

  const pushNFT = (
    nftAddress: string,
    tokenSubID: bigint,
    amount: bigint,
    nftTokenType: 1 | 2,
  ) => {
    if (amount <= 0n) {
      return;
    }

    const normalizedAddress = nftAddress.toLowerCase();
    const tokenSubIDString = tokenSubID.toString();
    const key = `${normalizedAddress}:${tokenSubIDString}:${amount.toString()}:${nftTokenType}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    unshieldNFTAmounts.push({
      nftAddress: normalizedAddress,
      tokenSubID: tokenSubIDString,
      amount,
      nftTokenType,
    } as RailgunNFTAmount);

    shieldNFTRecipients.push({
      nftAddress: normalizedAddress,
      tokenSubID: tokenSubIDString,
      amount,
      recipientAddress,
      nftTokenType,
    } as RailgunNFTAmountRecipient);
  };

  calls.forEach((call) => {
    const to = call.to?.trim();
    const data = call.data?.trim();
    if (!to || !isHexAddress(to) || !data || !/^0x[0-9a-fA-F]+$/.test(data)) {
      return;
    }

    try {
      const parsed1155 = ERC1155_TRANSFER_INTERFACE.parseTransaction({ data });
      if (parsed1155?.name === "safeTransferFrom") {
        const tokenSubID = BigInt(parsed1155.args[2].toString());
        const amount = BigInt(parsed1155.args[3].toString());
        pushNFT(to, tokenSubID, amount, 2);
        return;
      }
    } catch {
      // not an ERC1155 transfer
    }

    try {
      const parsed721 = ERC721_TRANSFER_INTERFACE.parseTransaction({ data });
      if (
        parsed721?.name === "transferFrom"
        || parsed721?.name === "safeTransferFrom"
      ) {
        const tokenSubID = BigInt(parsed721.args[2].toString());
        pushNFT(to, tokenSubID, 1n, 1);
      }
    } catch {
      // not an ERC721 transfer
    }
  });

  return { unshieldNFTAmounts, shieldNFTRecipients };
};

const parseBundledCallValueToBigInt = (value: string): bigint => {
  const trimmed = value?.trim?.() ?? "";
  if (!trimmed.length) {
    return 0n;
  }
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    return BigInt(trimmed);
  }
  if (/^[0-9]+$/.test(trimmed)) {
    return BigInt(trimmed);
  }
  return 0n;
};

const getTotalBundledCallNativeValue = (calls: WalletConnectBundledCall[]): bigint => {
  return calls.reduce((total, call) => {
    return total + parseBundledCallValueToBigInt(call.value);
  }, 0n);
};

const runBundledCallPreflight = async (
  chainName: ReturnType<typeof getCurrentNetwork>,
  calls: WalletConnectBundledCall[],
  fromAddress?: string,
  label = "preflight",
): Promise<boolean> => {
  const provider = getProviderForChain(chainName) as any;
  let allPassed = true;
  console.log('calls', calls)
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    try {
      await provider.call({
        from: fromAddress,
        to: call.to,
        data: call.data,
        value: parseBundledCallValueToBigInt(call.value),
      });
    } catch (error) {
      allPassed = false;
      const err = error as any;
      const reason =
        err?.shortMessage
        ?? err?.reason
        ?? err?.error?.message
        ?? err?.message
        ?? "unknown call revert";
      console.log(
        `${label} failed at call index ${index}: ${reason}`.red,
      );
    }
  }

  if (!allPassed) {
    console.log(
      `One or more bundled calls failed ${label} simulation. Review failing call index(es) before generating/sending 7702 tx.`.yellow,
    );
  }

  return allPassed;
};

const runApproveRequestPrompt = async () => {
  const requestID = await selectPendingRequestID();
  if (!isDefined(requestID)) {
    return;
  }

  const requests = await getWalletConnectPendingSessionRequests();
  const selected = requests.find((request) => request.id === requestID);
  if (!isDefined(selected)) {
    console.log(`Request #${requestID} not found.`.yellow);
    return;
  }

  console.log(
    [
      `Request #${selected.id}`,
      `method=${selected.method}`,
      `chain=${selected.chainId ?? "n/a"}`,
      `origin=${selected.origin ?? "n/a"}`,
      `acct=${getConnectedAccountContext(selected.topic).type}`,
    ].join(" · ").yellow,
  );

  if (isDefined(selected.params)) {
    const rawParams = JSON.stringify(selected.params);
    const preview = rawParams.length > 220
      ? `${rawParams.slice(0, 220)}...`
      : rawParams;
    console.log(`params=${preview}`.grey);
  }

  const confirmed = await confirmPrompt(
    `Approve WalletConnect request #${selected.id}?`,
    { initial: false },
  );
  if (!confirmed) {
    console.log("Approval canceled.".yellow);
    return;
  }

  const topicContext = getConnectedAccountContext(selected.topic);
  const context = getSigningContextForRequest(
    topicContext,
    selected.method,
    selected.params,
  );
  if (
    isTxExecutionMethod(selected.method)
    && (context.type === "ephemeral" || context.type === "stealth")
  ) {
    if (!isDefined(context.connectedAddress)) {
      console.log(
        "Connected session address is missing; unable to route request policy.".yellow,
      );
      return;
    }

    const gasBalance = await getGasBalanceForAddress(context.connectedAddress);
    const hasEthBalance = gasBalance > 0n;

    const capturedBundle = getCapturedBundleForRequest(selected.id, selected.topic);
    const bundleNativeValueTotal = (capturedBundle?.calls ?? []).reduce((total, call) => {
      const rawValue = call.value?.trim?.() ?? "";
      if (/^0x[0-9a-fA-F]+$/.test(rawValue)) {
        return total + BigInt(rawValue);
      }
      if (/^[0-9]+$/.test(rawValue)) {
        return total + BigInt(rawValue);
      }
      return total;
    }, 0n);

    if (hasEthBalance && bundleNativeValueTotal > 0n) {
      console.log(
        "Detected non-zero call value and available account ETH; routing via public-send so value is funded by connected signer.".yellow,
      );

      await prepareSignerForConnectedSessionAddress(context);

      const approved = await approveWalletConnectSessionRequest(selected.id);
      console.log(
        `Approved request #${approved.id} (${approved.method}) on topic ${approved.topic} via public-send.`.green,
      );
      return;
    }

    if (hasEthBalance) {
      const executionPrompt = new Select({
        header: " ",
        message: "Stealth/Ephemeral account has ETH. Choose execution path",
        choices: [
          {
            name: "public-send",
            message: "Public Send (direct signer send for this connected account)",
          },
          {
            name: "broadcaster-7702",
            message: "Broadcaster 7702 Relay (cross-contract call bundle)",
          },
          { name: "cancel", message: "Cancel".grey },
        ],
        multiple: false,
      });

      const executionSelection = await executionPrompt.run().catch(confirmPromptCatch);
      if (!executionSelection || executionSelection === "cancel") {
        console.log("Approval canceled.".yellow);
        return;
      }

      if (executionSelection === "broadcaster-7702") {
        if (!isDefined(capturedBundle) || !capturedBundle.calls.length) {
          console.log(
            "No captured bundle found for this request. Use public send or capture request again.".yellow,
          );
          return;
        }

        const txHash = await buildAndSendCrossContract7702FromBundle(capturedBundle);
        if (!isDefined(txHash)) {
          return;
        }

        const approved = await approveWalletConnectSessionRequest(selected.id, {
          approvedResultOverride: txHash,
        });
        console.log(
          `Approved request #${approved.id} (${approved.method}) via 7702 broadcaster on topic ${approved.topic}.`.green,
        );
        return;
      }

      await prepareSignerForConnectedSessionAddress(context);
    } else {
      console.log(
        "Stealth/Ephemeral account has no ETH balance: routing to 7702 broadcaster flow.".yellow,
      );
      const capturedBundle = getCapturedBundleForRequest(selected.id, selected.topic);
      if (!isDefined(capturedBundle) || !capturedBundle.calls.length) {
        console.log(
          "No captured bundle found for this request. Cannot run 7702 broadcaster flow.".yellow,
        );
        return;
      }

      const txHash = await buildAndSendCrossContract7702FromBundle(capturedBundle);
      if (!isDefined(txHash)) {
        return;
      }

      const approved = await approveWalletConnectSessionRequest(selected.id, {
        approvedResultOverride: txHash,
      });
      console.log(
        `Approved request #${approved.id} (${approved.method}) via 7702 broadcaster on topic ${approved.topic}.`.green,
      );
      return;
    }
  }

  const approved = await approveWalletConnectSessionRequest(selected.id);
  console.log(
    `Approved request #${approved.id} (${approved.method}) on topic ${approved.topic}.`.green,
  );
};

const runRejectRequestPrompt = async () => {
  const requestID = await selectPendingRequestID();
  if (!isDefined(requestID)) {
    return;
  }

  const requests = await getWalletConnectPendingSessionRequests();
  const selected = requests.find((request) => request.id === requestID);
  if (!isDefined(selected)) {
    console.log(`Request #${requestID} not found.`.yellow);
    return;
  }

  const confirmed = await confirmPrompt(
    `Reject WalletConnect request #${selected.id} (${selected.method})?`,
    { initial: false },
  );
  if (!confirmed) {
    console.log("Rejection canceled.".yellow);
    return;
  }

  const rejected = await rejectWalletConnectSessionRequest(selected.id);
  console.log(
    `Rejected request #${rejected.id} (${rejected.method}) on topic ${rejected.topic}.`.green,
  );
};

const printCapturedWalletConnectBundles = () => {
  const bundles = listWalletConnectCapturedBundles();
  if (!bundles.length) {
    console.log("No captured WalletConnect bundles yet.".yellow);
    return;
  }

  bundles.forEach((bundle) => {
    const ts = new Date(bundle.createdAt).toISOString();
    console.log(
      [
        `bundle=${bundle.key}`,
        `method=${bundle.method}`,
        `topic=${bundle.topic}`,
        `requestId=${bundle.requestId}`,
        `chain=${bundle.chainId ?? "n/a"}`,
        `calls=${bundle.calls.length}`,
        `at=${ts}`,
      ].join(" · ").grey,
    );

    bundle.calls.forEach((call, index) => {
      const shortData = call.data.length > 26
        ? `${call.data.slice(0, 26)}...`
        : call.data;
      console.log(
        [
          `  #${index + 1}`,
          `to=${call.to}`,
          `value=${call.value}`,
          `op=${call.operation}`,
          `data=${shortData}`,
        ].join(" · ").grey,
      );
    });
  });
};

const selectCapturedBundle = async (): Promise<
  Optional<ReturnType<typeof listWalletConnectCapturedBundles>[number]>
> => {
  const bundles = listWalletConnectCapturedBundles();
  if (!bundles.length) {
    console.log("No captured WalletConnect bundles yet.".yellow);
    return undefined;
  }

  const prompt = new Select({
    header: " ",
    message: "Select captured bundle",
    choices: [
      ...bundles.map((bundle) => ({
        name: bundle.key,
        message: `#${bundle.requestId} ${bundle.method} · ${bundle.calls.length} call(s) · ${bundle.topic.slice(0, 16)}...`,
      })),
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selectedKey = await prompt.run().catch(confirmPromptCatch);
  if (!selectedKey || selectedKey === "exit-menu") {
    return undefined;
  }

  return bundles.find((bundle) => bundle.key === selectedKey);
};

const buildAndSendCrossContract7702FromBundle = async (
  selectedBundle: ReturnType<typeof listWalletConnectCapturedBundles>[number],
): Promise<Optional<string>> => {
  if (!isDefined(selectedBundle)) {
    return undefined;
  }
  if (!selectedBundle.calls.length) {
    console.log("Selected bundle has no executable calls.".yellow);
    return undefined;
  }

  const chainName = getCurrentNetwork();

  const sessions = listWalletConnectSessions();
  const connectedAddress = sessions.find((session) => {
    return session.topic === selectedBundle.topic;
  })?.connectedAddress;
  const relayAdaptAddress = connectedAddress; //getRailgunRelayAdaptAddressForChain(chainName);

  const eoaPreflightPassed = await runBundledCallPreflight(
    chainName,
    selectedBundle.calls,
    connectedAddress,
    "EOA preflight",
  );
  const relayPreflightPassed = await runBundledCallPreflight(
    chainName,
    selectedBundle.calls,
    relayAdaptAddress,
    "RelayAdapt preflight",
  );

  if (!relayPreflightPassed && eoaPreflightPassed) {
    console.log(
      "Calls pass as connected EOA but fail as RelayAdapt sender. This bundle likely depends on msg.sender context and is incompatible with relayed 7702 multicall.".red,
    );
    return undefined;
  }

  if (!eoaPreflightPassed || !relayPreflightPassed) {
    const continueDespiteFailure = await confirmPrompt(
      "Preflight simulation failed. Continue anyway?",
      { initial: false },
    );
    if (!continueDespiteFailure) {
      return undefined;
    }
  }

  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) {
    console.log("Canceled (missing wallet password).".yellow);
    return undefined;
  }

  const unshieldERC20Amounts = await parseERC20AmountArray();
  let shieldERC20Recipients = await parseERC20RecipientArray();
  const currentRailgunAddress = getCurrentRailgunAddress();

  const totalNativeCallValue = getTotalBundledCallNativeValue(selectedBundle.calls);
  if (totalNativeCallValue > 0n) {
    const wrappedTokenInfo = getWrappedTokenInfoForChain(chainName);
    const wrappedTokenAddress = wrappedTokenInfo.wrappedAddress.toLowerCase();
    const existingWrappedUnshield = unshieldERC20Amounts.find((entry) => {
      return entry.tokenAddress.toLowerCase() === wrappedTokenAddress;
    });

    if (!isDefined(existingWrappedUnshield)) {
      unshieldERC20Amounts.push({
        tokenAddress: wrappedTokenAddress,
        amount: totalNativeCallValue,
      });
      console.log(
        `Detected bundled call value; auto-adding unshield ${wrappedTokenInfo.wrappedSymbol}=${totalNativeCallValue.toString()} for relay value forwarding.`.yellow,
      );
    } else if (existingWrappedUnshield.amount < totalNativeCallValue) {
      existingWrappedUnshield.amount = totalNativeCallValue;
      console.log(
        `Adjusted ${wrappedTokenInfo.wrappedSymbol} unshield to ${totalNativeCallValue.toString()} to satisfy bundled call value.`.yellow,
      );
    }
  }

  let {
    unshieldNFTAmounts,
    shieldNFTRecipients,
  } = deriveNFTActionsFromBundledCalls(selectedBundle.calls, currentRailgunAddress);
  if (unshieldNFTAmounts.length) {
    console.log(
      `Detected ${unshieldNFTAmounts.length} NFT transfer(s) from bundled calls; auto-adding NFT unshield/shield entries.`.grey,
    );
  }

  const hasUnshieldActions =
    unshieldERC20Amounts.length > 0 || unshieldNFTAmounts.length > 0;
  let includeReshield = true;
  if (hasUnshieldActions) {
    includeReshield = await confirmPrompt(
      "Unshield detected. Re-shield remaining assets after execution?",
      { initial: false },
    );
  }

  if (includeReshield) {
    const autoShieldRecipients = await collectAutoShieldERC20Recipients(
      chainName,
      selectedBundle.calls,
      shieldERC20Recipients,
      unshieldERC20Amounts,
    );
    if (autoShieldRecipients.length) {
      console.log(
        `Auto-shielding ${autoShieldRecipients.length} interacted ERC20 token(s) to current Railgun address.`.grey,
      );
      shieldERC20Recipients.push(...autoShieldRecipients);
    }
  } else {
    shieldERC20Recipients = [];
    shieldNFTRecipients = [];
    console.log("Proceeding without re-shield outputs.".yellow);
  }

  const amountRecipients: RailgunERC20AmountRecipient[] = unshieldERC20Amounts.map(
    (entry) => ({
      tokenAddress: entry.tokenAddress,
      amount: entry.amount,
      recipientAddress: currentRailgunAddress,
    }),
  );

  const broadcasterSelection = await runFeeTokenSelector(
    chainName,
    amountRecipients,
    undefined,
    true,
  );
  const bestBroadcaster = broadcasterSelection?.bestBroadcaster;
  if (!isDefined(bestBroadcaster)) {
    console.log(
      "No 7702-capable broadcaster available for selected fee token/route.".yellow,
    );
    return undefined;
  }

  const privateGasEstimate = await getCrossContract7702GasEstimate(
    chainName,
    selectedBundle.calls,
    encryptionKey,
    bestBroadcaster,
    unshieldERC20Amounts,
    unshieldNFTAmounts,
    shieldERC20Recipients,
    shieldNFTRecipients,
  );
  if (!isDefined(privateGasEstimate)) {
    console.log("Failed to estimate gas for 7702 cross-contract bundle.".yellow);
    return undefined;
  }

  const provedTransaction = await getProvedCrossContract7702Transaction(
    encryptionKey,
    selectedBundle.calls,
    privateGasEstimate,
    unshieldERC20Amounts,
    unshieldNFTAmounts,
    shieldERC20Recipients,
    shieldNFTRecipients,
  );
  if (!isDefined(provedTransaction)) {
    console.log("Failed to generate 7702 cross-contract proof/transaction.".yellow);
    return undefined;
  }

  const shouldSend = await confirmPrompt(
    `Send built 7702 transaction for bundle #${selectedBundle.requestId}?`,
    { initial: true },
  );
  if (!shouldSend) {
    console.log("Built 7702 transaction; send canceled by user.".yellow);
    return undefined;
  }

  const sendResult = await sendBroadcastedTransaction(
    RailgunTransaction.Private0XSwap,
    provedTransaction,
    bestBroadcaster,
    chainName,
    encryptionKey,
  );

  const txHash =
    typeof sendResult === "string"
      ? sendResult
      : (sendResult as Optional<{ hash?: string }>)?.hash;
  if (!isDefined(txHash) || !txHash.length) {
    throw new Error("Failed to resolve transaction hash from broadcast send result.");
  }

  console.log(
    `Submitted 7702 cross-contract transaction for bundle #${selectedBundle.requestId}.`.green,
  );
  return txHash;
};

const runBuildCrossContract7702FromBundlePrompt = async () => {
  const selectedBundle = await selectCapturedBundle();
  if (!isDefined(selectedBundle)) {
    return;
  }

  await buildAndSendCrossContract7702FromBundle(selectedBundle);
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => {
    return typeof item === "string";
  }) as string[];
};

const printProposalPermissions = (proposal: {
  id: number;
  proposerName: string;
  proposerUrl: string;
  requiredNamespaces: Record<string, unknown>;
  optionalNamespaces?: Record<string, unknown>;
}) => {
  console.log(`Reviewing proposal #${proposal.id} from ${proposal.proposerName}`.cyan);
  console.log(`Proposer URL: ${proposal.proposerUrl}`.grey);

  const printNamespaceBlock = (
    label: string,
    namespaces: Record<string, unknown>,
  ) => {
    const namespaceEntries = Object.entries(namespaces);
    if (!namespaceEntries.length) {
      console.log(`${label}: none`.grey);
      return;
    }

    console.log(`${label}:`.yellow);
    namespaceEntries.forEach(([namespaceKey, rawNamespace]) => {
      const namespace = rawNamespace as {
        chains?: unknown;
        methods?: unknown;
        events?: unknown;
      };
      const chains = toStringArray(namespace.chains);
      const methods = toStringArray(namespace.methods);
      const events = toStringArray(namespace.events);

      console.log(
        [
          `  ${namespaceKey}`,
          `chains=[${chains.join(", ") || "none"}]`,
          `methods=[${methods.join(", ") || "none"}]`,
          `events=[${events.join(", ") || "none"}]`,
        ].join(" · ").grey,
      );
    });
  };

  printNamespaceBlock("Required", proposal.requiredNamespaces);
  printNamespaceBlock("Optional", proposal.optionalNamespaces ?? {});
};

const selectPendingProposalID = async (): Promise<Optional<number>> => {
  const proposals = await getWalletConnectPendingSessionProposals();
  if (!proposals.length) {
    console.log("No pending WalletConnect session proposals.".yellow);
    return undefined;
  }

  const prompt = new Select({
    header: " ",
    message: "Select pending WalletConnect proposal",
    choices: [
      ...proposals.map((proposal) => ({
        name: proposal.id.toString(),
        message: `#${proposal.id} ${proposal.proposerName} (${proposal.pairingTopic})`,
      })),
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return undefined;
  }

  const proposalID = Number(selection);
  if (!Number.isInteger(proposalID)) {
    return undefined;
  }
  return proposalID;
};

const runApprovePrompt = async () => {
  const proposalID = await selectPendingProposalID();
  if (!isDefined(proposalID)) {
    return;
  }

  const proposals = await getWalletConnectPendingSessionProposals();
  const selectedProposal = proposals.find((proposal) => {
    return proposal.id === proposalID;
  });
  if (!isDefined(selectedProposal)) {
    console.log(`Proposal #${proposalID} not found.`.yellow);
    return;
  }

  printProposalPermissions(selectedProposal);
  const confirmApprove = await confirmPrompt(
    `Approve WalletConnect proposal #${proposalID}?`,
    { initial: false },
  );
  if (!confirmApprove) {
    console.log("Approval canceled.".yellow);
    return;
  }

  const accountPrompt = new Select({
    header: " ",
    message: "Connect using which account?",
    choices: [
      { name: "public", message: `Public (${getCurrentWalletPublicAddress()})` },
      {
        name: "ephemeral",
        message: `Ephemeral (${getCurrentKnownEphemeralState()?.currentAddress ?? "not synced"})`,
      },
      {
        name: "stealth-profile",
        message: `Stealth Profile (${getActiveStealthProfile()?.name ?? "none active"})`,
      },
      { name: "exit-menu", message: "Cancel".grey },
    ],
    multiple: false,
  });

  const accountSelection = await accountPrompt.run().catch(confirmPromptCatch);
  if (!accountSelection || accountSelection === "exit-menu") {
    console.log("Approval canceled.".yellow);
    return;
  }

  let approvalAddress = getCurrentWalletPublicAddress();
  let approvalScopeID: Optional<string>;
  if (accountSelection === "ephemeral") {
    let ephemeralAddress = getCurrentKnownEphemeralState()?.currentAddress;
    if (!isDefined(ephemeralAddress)) {
      const shouldSyncEphemeral = await confirmPrompt(
        "No cached ephemeral address found. Sync now?",
        { initial: true },
      );
      if (!shouldSyncEphemeral) {
        console.log("Approval canceled (ephemeral not available).".yellow);
        return;
      }

      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        console.log("Approval canceled (missing wallet password).".yellow);
        return;
      }

      const synced = await syncCurrentEphemeralWallet(encryptionKey);
      ephemeralAddress = synced?.currentAddress;
    }

    if (!isDefined(ephemeralAddress)) {
      console.log("Approval canceled (failed to resolve ephemeral address).".yellow);
      return;
    }

    approvalAddress = ephemeralAddress;

    const activeProfile = getActiveStealthProfile();
    if (
      isDefined(activeProfile)
      && activeProfile.accountAddress?.toLowerCase() === ephemeralAddress.toLowerCase()
    ) {
      approvalScopeID = getPreferredScopeForProfile(activeProfile);
    }
  }

  if (accountSelection === "stealth-profile") {
    const profiles = listStealthProfiles().filter((profile) => {
      return isDefined(profile.accountAddress);
    });
    if (!profiles.length) {
      console.log(
        "Approval canceled (no linked external stealth profiles configured).".yellow,
      );
      return;
    }

    const profilePrompt = new Select({
      header: " ",
      message: "Select external stealth profile",
      choices: [
        ...profiles.map((profile) => ({
          name: profile.id,
          message: `${profile.name} (${profile.accountAddress})${
            profile.scopeID ? ` · scope=${profile.scopeID}` : ""
          }`,
        })),
        { name: "exit-menu", message: "Cancel".grey },
      ],
      multiple: false,
    });

    const profileSelection = await profilePrompt.run().catch(confirmPromptCatch);
    if (!profileSelection || profileSelection === "exit-menu") {
      console.log("Approval canceled.".yellow);
      return;
    }

    const selectedProfile = profiles.find((profile) => profile.id === profileSelection);
    if (!isDefined(selectedProfile)) {
      console.log("Approval canceled (profile not found).".yellow);
      return;
    }
    if (!isDefined(selectedProfile.accountAddress)) {
      console.log("Approval canceled (selected profile is unlinked).".yellow);
      return;
    }

    setActiveStealthProfile(selectedProfile.id);
    approvalAddress = selectedProfile.accountAddress;
    approvalScopeID = getPreferredScopeForProfile(selectedProfile);
  }

  const approved = await approveWalletConnectSessionProposal(proposalID, {
    accountAddress: approvalAddress,
    scopeID: approvalScopeID,
  });

  console.log(
    `Approved proposal #${proposalID} -> topic ${approved.topic} via ${approved.accountAddress}`
      .green,
  );
  if (approved.scopeID) {
    console.log(`Scoped to ${approved.scopeID}`.grey);
  }
};

const runRejectPrompt = async () => {
  const proposalID = await selectPendingProposalID();
  if (!isDefined(proposalID)) {
    return;
  }

  const proposals = await getWalletConnectPendingSessionProposals();
  const selectedProposal = proposals.find((proposal) => {
    return proposal.id === proposalID;
  });
  if (isDefined(selectedProposal)) {
    const requiredNamespaceCount = Object.keys(
      selectedProposal.requiredNamespaces,
    ).length;
    const optionalNamespaceCount = Object.keys(
      selectedProposal.optionalNamespaces ?? {},
    ).length;
    console.log(
      [
        `Proposal #${proposalID}`,
        `proposer=${selectedProposal.proposerName}`,
        `required-namespaces=${requiredNamespaceCount}`,
        `optional-namespaces=${optionalNamespaceCount}`,
      ].join(" · ").yellow,
    );
  }

  const confirmReject = await confirmPrompt(
    `Reject WalletConnect proposal #${proposalID}?`,
    { initial: false },
  );
  if (!confirmReject) {
    console.log("Rejection canceled.".yellow);
    return;
  }

  await rejectWalletConnectSessionProposal(proposalID);
  console.log(`Rejected WalletConnect proposal #${proposalID}.`.green);
};

const runPairPrompt = async () => {
  const uriPrompt = new Input({
    header: " ",
    message: "Paste WalletConnect URI (wc:...)",
    validate: (value: string) => value.trim().startsWith("wc:"),
  });

  const wcURI = (await uriPrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(wcURI)) {
    return;
  }
  const activeProfile = getActiveStealthProfile();
  const scopeID = isDefined(activeProfile)
    ? getPreferredScopeForProfile(activeProfile)
    : undefined;
  const paired = await pairWalletConnectURI(wcURI.trim(), {
    scopeID,
  });

  console.log(
    `Paired WalletConnect topic ${paired.topic} (v${paired.version}) as ${paired.status}.`.green,
  );
  if (paired.scopeID) {
    console.log(`Scoped to ${paired.scopeID}`.grey);
  }
};

const runDisconnectPrompt = async () => {
  const sessions = listWalletConnectSessions().filter(
    (session) => session.status !== "disconnected",
  );

  if (!sessions.length) {
    console.log("No active WalletConnect sessions to disconnect.".yellow);
    return;
  }

  const prompt = new Select({
    header: " ",
    message: "Select WalletConnect session to disconnect",
    choices: [
      ...sessions.map((session) => ({
        name: session.topic,
        message: formatSessionLine(session),
      })),
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  const disconnected = await disconnectWalletConnectSession(selection);
  if (!disconnected) {
    console.log("Session not found.".yellow);
    return;
  }

  console.log(`Disconnected WalletConnect topic ${selection}.`.green);
};

export const runWalletConnectManagerPrompt = async (): Promise<void> => {
  const cardHeader = await buildWalletConnectCardHeader();
  const summary = getWalletConnectSessionSummary();

  const prompt = new Select({
    header: cardHeader,
    message: "WalletConnect Tools (interactive)",
    choices: [
      {
        name: "pair",
        message: "Pair WalletConnect URI",
      },
      {
        name: "pending",
        message: `View Pending Session Proposals (${summary.pendingProposals})`,
      },
      {
        name: "pending-requests",
        message: `View Pending Session Requests (${summary.pendingRequests})`,
      },
      {
        name: "approve",
        message: `Approve Pending Session Proposal (${summary.pendingProposals})`,
        disabled: summary.pendingProposals === 0 ? "No pending proposals" : false,
      },
      {
        name: "approve-request",
        message: `Approve Pending Session Request (${summary.pendingRequests})`,
        disabled: summary.pendingRequests === 0 ? "No pending requests" : false,
      },
      {
        name: "reject",
        message: `Reject Pending Session Proposal (${summary.pendingProposals})`,
        disabled: summary.pendingProposals === 0 ? "No pending proposals" : false,
      },
      {
        name: "reject-request",
        message: `Reject Pending Session Request (${summary.pendingRequests})`,
        disabled: summary.pendingRequests === 0 ? "No pending requests" : false,
      },
      {
        name: "list",
        message: `List WalletConnect Sessions (${summary.total})`,
      },
      {
        name: "disconnect",
        message: `Disconnect WalletConnect Session (${summary.paired} paired)`,
        disabled: summary.paired === 0 ? "No paired sessions" : false,
      },
      {
        name: "bundles",
        message: `View Captured Bundles (${summary.capturedBundles})`,
      },
      {
        name: "build-7702",
        message: `Build 7702 Tx from Captured Bundle (${summary.capturedBundles})`,
        disabled: summary.capturedBundles === 0 ? "No captured bundles" : false,
      },
      {
        name: "clear-bundles",
        message: "Clear Captured Bundles",
        disabled: summary.capturedBundles === 0 ? "No captured bundles" : false,
      },
      { name: "refresh-card", message: "Refresh Card".cyan },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  const shouldPauseForContinue = selection !== "refresh-card";

  try {
    await initializeWalletConnectKit();

    switch (selection) {
      case "pair":
        await runPairPrompt();
        break;
      case "refresh-card":
        break;
      case "list":
        printWalletConnectSessions();
        break;
      case "pending":
        await printPendingWalletConnectProposals();
        break;
      case "pending-requests":
        await printPendingWalletConnectRequests();
        break;
      case "approve":
        await runApprovePrompt();
        break;
      case "approve-request":
        await runApproveRequestPrompt();
        break;
      case "reject":
        await runRejectPrompt();
        break;
      case "reject-request":
        await runRejectRequestPrompt();
        break;
      case "disconnect":
        await runDisconnectPrompt();
        break;
      case "bundles":
        printCapturedWalletConnectBundles();
        break;
      case "build-7702":
        await runBuildCrossContract7702FromBundlePrompt();
        break;
      case "clear-bundles": {
        const cleared = clearWalletConnectCapturedBundles();
        console.log(`Cleared ${cleared} captured WalletConnect bundle(s).`.green);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.log(`WalletConnect tools failed: ${(error as Error).message}`.red);
  }

  if (shouldPauseForContinue) {
    await confirmPromptCatchRetry("");
  }
  return runWalletConnectManagerPrompt();
};
