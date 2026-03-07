import {
  isDefined,
  RailgunWalletBalanceBucket,
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
  setWalletConnectSignerOverrideForTopic,
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
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { confirmPrompt, confirmPromptCatch, confirmPromptCatchRetry } from "./confirm-ui";
import { createLiveSelect } from "./live-select";
import {
  getCurrentWalletPublicAddress,
  getCurrentRailgunAddress,
  getGasBalanceForAddress,
} from "../wallet/wallet-util";
import {
  getCurrentKnownEphemeralState,
  getKnownEphemeralAddresses,
  getKnownEphemeralIndexForAddress,
  listEphemeralSessionScopes,
  setEphemeralWalletIndex,
  setCurrentEphemeralWalletSession,
  syncCurrentEphemeralWallet,
} from "../wallet/ephemeral-wallet-manager";
import { getSaltedPassword } from "../wallet/wallet-password";
import { getCurrentNetwork } from "../engine/engine";
import { getTokenInfo } from "../balance/token-util";
import { getProviderForChain } from "../network/network-util";
import { getChainForName } from "../network/network-util";
import {
  getCrossContract7702GasEstimate,
  getProvedCrossContract7702Transaction,
} from "../transaction/private/cross-contract-7702";
import {
  runFeeTokenSelector,
  tokenAmountSelectionPrompt,
  tokenSelectionPrompt,
} from "./token-ui";
import { sendBroadcastedTransaction } from "../transaction/transaction-builder";
import { RailgunTransaction } from "../models/transaction-models";
import { WalletConnectBundledCall } from "../models/wallet-models";
import {
  getActiveStealthProfile,
  listStealthProfiles,
  setActiveStealthProfile,
} from "../wallet/stealth-profile-manager";
import { launchPilot } from "../mech";
import { getPrivateERC20BalancesForChain } from "../balance/balance-util";
import type { Balances } from "../mech/pilot";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Input, Select, MultiSelect } = require("enquirer");

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
  const linkedStealth = listStealthProfiles().some((profile) => {
    return profile.accountAddress?.toLowerCase() === normalized;
  });

  if (normalized === normalizedPublic) {
    return "public";
  }
  if (linkedStealth) {
    return "stealth";
  }
  if (isDefined(normalizedEphemeral) && normalized === normalizedEphemeral) {
    return "ephemeral";
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

const normalizeAndDedupeERC20Recipients = (
  recipients: RailgunERC20Recipient[],
): RailgunERC20Recipient[] => {
  const dedupedRecipients: RailgunERC20Recipient[] = [];
  const seenTokenAddresses = new Set<string>();

  recipients.forEach((recipient) => {
    const normalizedTokenAddress = recipient.tokenAddress?.trim?.().toLowerCase();
    if (!normalizedTokenAddress || !isHexAddress(normalizedTokenAddress)) {
      return;
    }
    if (seenTokenAddresses.has(normalizedTokenAddress)) {
      return;
    }

    seenTokenAddresses.add(normalizedTokenAddress);
    dedupedRecipients.push({
      ...recipient,
      tokenAddress: normalizedTokenAddress,
    });
  });

  return dedupedRecipients;
};

const promptAutoReshieldTokenSelection = async (
  recipients: RailgunERC20Recipient[],
): Promise<RailgunERC20Recipient[]> => {
  if (!recipients.length) {
    return [];
  }

  const uniqueRecipients = normalizeAndDedupeERC20Recipients(recipients);
  if (!uniqueRecipients.length) {
    return [];
  }

  const prompt = new MultiSelect({
    header: " ",
    message: "Select detected ERC20 tokens to re-shield",
    choices: uniqueRecipients.map((recipient) => ({
      name: recipient.tokenAddress,
      message: recipient.tokenAddress,
      enabled: true,
    })),
  });

  const selection = (await prompt.run().catch(confirmPromptCatch)) as
    | string[]
    | undefined;
  if (!Array.isArray(selection) || !selection.length) {
    return [];
  }

  const selectedSet = new Set(selection.map((entry) => entry.toLowerCase()));
  return uniqueRecipients.filter((recipient) =>
    selectedSet.has(recipient.tokenAddress.toLowerCase()),
  );
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

const printWalletConnectPairedSessions = () => {
  const sessions = listWalletConnectSessions().filter((session) => {
    return session.status === "paired";
  });
  if (!sessions.length) {
    console.log("No active paired WalletConnect sessions.".yellow);
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
  const sessions = listWalletConnectSessions();
  const pairedSessions = sessions
    .filter((session) => session.status === "paired")
    .slice(0, 4);
  const pendingCount = summary.pendingProposals;
  const pendingRequestCount = summary.pendingRequests;
  const activeAccount = summary.activeConnectedAddress ?? summary.latestConnectedAddress;
  const activeAccountType = isDefined(activeAccount)
    ? getConnectedAccountTypeForAddress(activeAccount)
    : "other";
  const suggestedAction = summary.pendingRequests > 0
    ? "Approve pending request".cyan
    : summary.pendingProposals > 0
      ? "Approve pending proposal".cyan
      : summary.capturedBundles > 0
        ? "Build 7702 transaction".magenta
        : summary.paired > 0
          ? "Review paired sessions".yellow
          : "Pair a WalletConnect URI".green;

  const cardRows = [
    `${"┌─ WalletConnect Console".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} sessions=${summary.paired.toString().green} paired · ${summary.disconnected
      .toString()
      .grey} disconnected · ${summary.scoped.toString().cyan} scoped`,
    `${"│".grey} pending=${pendingRequestCount.toString().yellow} requests · ${pendingCount
      .toString()
      .yellow} proposals · ${summary.capturedBundles.toString().magenta} bundles`,
    `${"│".grey} active account=${shortAddress(activeAccount)} (${activeAccountType.cyan})`,
    `${"│".grey} next best action=${suggestedAction}`,
  ];

  if (!pairedSessions.length) {
    cardRows.push(`${"│".grey} paired sessions: none`);
  } else {
    cardRows.push(`${"│".grey} paired sessions:`);
    pairedSessions.forEach((session) => {
      const accountType = getConnectedAccountTypeForAddress(session.connectedAddress);
      cardRows.push(
        [
          `${"│".grey} • ${session.topic.slice(0, 12)}...`,
          shortAddress(session.connectedAddress),
          `${accountType}`.cyan,
          session.scopeID ? `scope=${session.scopeID}` : undefined,
        ]
          .filter((part) => isDefined(part) && `${part}`.length > 0)
          .join(" · "),
      );
    });
  }

  cardRows.push(`${"└─".grey}`);
  return cardRows.join("\n");
};

const buildWalletConnectManagerChoices = () => {
  const summary = getWalletConnectSessionSummary();
  const choices: any[] = [];

  if (summary.pendingRequests > 0) {
    choices.push({
      name: "approve-request",
      message: `Approve next request (${summary.pendingRequests})`.cyan,
    });
  } else if (summary.pendingProposals > 0) {
    choices.push({
      name: "approve",
      message: `Approve next proposal (${summary.pendingProposals})`.cyan,
    });
  } else if (summary.capturedBundles > 0) {
    choices.push({
      name: "build-7702",
      message: `Build 7702 transaction (${summary.capturedBundles} bundles)`.magenta,
    });
  } else if (summary.paired === 0) {
    choices.push({
      name: "pair",
      message: "Pair new WalletConnect URI".green,
    });
  }

  choices.push(
    {
      message: ` >> ${"WalletConnect".grey.bold} <<`,
      role: "separator",
    },
    {
      name: "sessions-menu",
      message: `Sessions${summary.paired ? ` (${summary.paired} paired)` : ""}`,
    },
  );

  if (summary.pendingProposals > 0 || summary.pendingRequests > 0) {
    choices.push({
      name: "pending-menu",
      message: `Pending approvals (${summary.pendingRequests + summary.pendingProposals})`,
    });
  }

  if (summary.capturedBundles > 0) {
    choices.push({
      name: "bundles-menu",
      message: `Bundles & 7702 (${summary.capturedBundles})`,
    });
  }

  choices.push(
    // {
    //   message: ` >> ${"Advanced".grey.bold} <<`,
    //   role: "separator",
    // },
    // { name: "mech-test", message: "Test 7702 mech pilot".cyan },
    { name: "exit-menu", message: "Go Back".grey },
  );

  return choices;
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

const getUnsupportedBundleFieldsFor7702 = (
  method: string,
  params: unknown,
): string[] => {
  const unsupported = new Set<string>();

  const addUnsupported = (label: string) => {
    if (label.trim().length) {
      unsupported.add(label);
    }
  };

  if (method === "eth_sendTransaction") {
    const txLike = Array.isArray(params) ? params[0] : params;
    if (!isDefined(txLike) || typeof txLike !== "object") {
      return [];
    }

    const tx = txLike as Record<string, unknown>;
    if (isDefined(tx.accessList)) {
      addUnsupported("accessList");
    }
    if (isDefined(tx.authorizationList)) {
      addUnsupported("authorizationList");
    }
    if (isDefined(tx.maxFeePerBlobGas) || isDefined(tx.blobVersionedHashes)) {
      addUnsupported("blob tx fields");
    }

    return [...unsupported.values()];
  }

  if (method === "wallet_sendCalls") {
    const root = Array.isArray(params) ? params[0] : params;
    if (!isDefined(root) || typeof root !== "object") {
      return [];
    }

    const envelope = root as {
      capabilities?: unknown;
      atomicRequired?: unknown;
      calls?: unknown;
    };

    if (isDefined(envelope.capabilities)) {
      addUnsupported("top-level capabilities");
    }
    if (envelope.atomicRequired === false) {
      addUnsupported("atomicRequired=false");
    }

    const calls = Array.isArray(envelope.calls) ? envelope.calls : [];
    calls.forEach((rawCall, index) => {
      if (!isDefined(rawCall) || typeof rawCall !== "object") {
        return;
      }

      const call = rawCall as Record<string, unknown>;
      if (isDefined(call.capabilities)) {
        addUnsupported(`call[${index}] capabilities`);
      }
      if (isDefined(call.operation) && Number(call.operation) !== 0) {
        addUnsupported(`call[${index}] operation!=0`);
      }
      if (isDefined(call.accessList)) {
        addUnsupported(`call[${index}] accessList`);
      }
      if (isDefined(call.authorizationList)) {
        addUnsupported(`call[${index}] authorizationList`);
      }
    });

    return [...unsupported.values()];
  }

  return [];
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

const getStealthSignerScopeCandidatesForProfile = (profile: {
  scopeID?: string;
  signerStrategyScopeID?: string;
  slot?: number;
}) => {
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

const getStealthSignerScopeCandidatesForAddress = (connectedAddress: string) => {
  const normalized = connectedAddress.toLowerCase();
  const profile = listStealthProfiles().find((item) => {
    return item.accountAddress?.toLowerCase() === normalized;
  });
  if (!isDefined(profile)) {
    return [] as string[];
  }

  return getStealthSignerScopeCandidatesForProfile(profile);
};

const getStealthProfileByID = (profileID?: string) => {
  if (!isDefined(profileID)) {
    return undefined;
  }
  return listStealthProfiles().find((profile) => profile.id === profileID);
};

const getStealthProfileForAddress = (connectedAddress: string) => {
  const normalized = connectedAddress.toLowerCase();
  return listStealthProfiles().find((item) => {
    return item.accountAddress?.toLowerCase() === normalized;
  });
};

const getStealthProfileIDForAddress = (connectedAddress?: string): Optional<string> => {
  if (!isDefined(connectedAddress)) {
    return undefined;
  }
  const profile = getStealthProfileForAddress(connectedAddress);
  return profile?.id;
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
  stealthProfileID?: string;
}) => {
  if (!isDefined(context.connectedAddress)) {
    throw new Error("Connected session address is missing.");
  }

  let resolvedAddress: Optional<string>;
  let resolvedSigner: Optional<any>;

  if (context.type === "ephemeral") {
    const encryptionKey = await getSaltedPassword();
    if (!isDefined(encryptionKey)) {
      throw new Error("Missing wallet password for ephemeral signer sync.");
    }
    const session = await setCurrentEphemeralWalletSession(encryptionKey);
    resolvedAddress = session?.currentAddress?.toLowerCase();
    resolvedSigner = session?.signer;
  }

  if (context.type === "stealth") {
    const encryptionKey = await getSaltedPassword();
    if (!isDefined(encryptionKey)) {
      throw new Error("Missing wallet password for stealth signer sync.");
    }

    const connectedAddress = context.connectedAddress.toLowerCase();
    const stealthProfile = isDefined(context.stealthProfileID)
      ? getStealthProfileByID(context.stealthProfileID)
      : getStealthProfileForAddress(context.connectedAddress);
    if (!isDefined(stealthProfile)) {
      throw new Error("Connected stealth profile was not found.");
    }
    if (stealthProfile.accountAddress?.toLowerCase() !== connectedAddress) {
      throw new Error(
        `Selected stealth profile does not match connected address ${connectedAddress}.`,
      );
    }

    const uniqueScopeCandidates = new Set<string>();
    for (const scopeID of getStealthSignerScopeCandidatesForProfile(stealthProfile)) {
      uniqueScopeCandidates.add(scopeID);
    }
    for (const sessionScope of listEphemeralSessionScopes()) {
      if (sessionScope.lastKnownAddress?.toLowerCase() === connectedAddress) {
        uniqueScopeCandidates.add(sessionScope.scopeID);
      }
    }

    const uniqueIndexCandidates = new Set<number>();
    if (typeof stealthProfile.slot === "number") {
      uniqueIndexCandidates.add(stealthProfile.slot);
    }
    const knownIndex = getKnownEphemeralIndexForAddress(connectedAddress);
    if (typeof knownIndex === "number") {
      uniqueIndexCandidates.add(knownIndex);
    }
    for (const sessionScope of listEphemeralSessionScopes()) {
      if (
        sessionScope.lastKnownAddress?.toLowerCase() === connectedAddress
        && typeof sessionScope.lastKnownIndex === "number"
      ) {
        uniqueIndexCandidates.add(sessionScope.lastKnownIndex);
      }
    }

    const scopeCandidates = [...uniqueScopeCandidates.values()];
    const indexCandidates = [...uniqueIndexCandidates.values()];

    const tryResolveStealthSession = async (
      scopeID?: string,
      index?: number,
    ): Promise<Optional<{ currentAddress: string; signer: any }>> => {
      if (typeof index === "number") {
        const indexed = await setEphemeralWalletIndex(encryptionKey, index, scopeID);
        const indexedAddress = indexed?.currentAddress?.toLowerCase();
        if (indexedAddress !== connectedAddress) {
          return undefined;
        }
      }

      const session = await setCurrentEphemeralWalletSession(
        encryptionKey,
        scopeID,
        { skipAutoSync: true },
      );
      if (!isDefined(session)) {
        return undefined;
      }
      const sessionAddress = session?.currentAddress?.toLowerCase();
      if (sessionAddress !== connectedAddress || !isDefined(session.signer)) {
        return undefined;
      }
      const { signer } = session;

      return {
        currentAddress: sessionAddress,
        signer,
      };
    };

    let matchedScope: Optional<string>;
    let matchedIndex: Optional<number>;

    for (const scopeID of [...scopeCandidates, undefined]) {
      for (const index of indexCandidates) {
        const resolved = await tryResolveStealthSession(scopeID, index);
        if (!isDefined(resolved)) {
          continue;
        }
        resolvedAddress = resolved.currentAddress;
        resolvedSigner = resolved.signer;
        matchedScope = scopeID;
        matchedIndex = index;
        break;
      }
      if (isDefined(resolvedSigner)) {
        break;
      }

      const resolved = await tryResolveStealthSession(scopeID);
      if (!isDefined(resolved)) {
        continue;
      }
      resolvedAddress = resolved.currentAddress;
      resolvedSigner = resolved.signer;
      matchedScope = scopeID;
      break;
    }

    if (!isDefined(resolvedSigner)) {
      const knownIndices = getKnownEphemeralAddresses().map((entry) => entry.index);
      const fallbackIndexSet = new Set<number>([...indexCandidates, ...knownIndices]);
      const highestKnownIndex = fallbackIndexSet.size
        ? Math.max(...[...fallbackIndexSet.values()])
        : 0;
      const fallbackUpperBound = Math.min(Math.max(highestKnownIndex + 8, 32), 128);
      for (let index = 0; index <= fallbackUpperBound; index += 1) {
        fallbackIndexSet.add(index);
      }

      const fallbackIndices = [...fallbackIndexSet.values()].sort((left, right) => {
        return left - right;
      });

      for (const scopeID of [...scopeCandidates, undefined]) {
        for (const index of fallbackIndices) {
          const resolved = await tryResolveStealthSession(scopeID, index);
          if (!isDefined(resolved)) {
            continue;
          }
          resolvedAddress = resolved.currentAddress;
          resolvedSigner = resolved.signer;
          matchedScope = scopeID;
          matchedIndex = index;
          break;
        }
        if (isDefined(resolvedSigner)) {
          break;
        }
      }
    }

    if (!isDefined(resolvedSigner)) {
      throw new Error(
        `Connected stealth address ${connectedAddress} is not derivable for profile ${stealthProfile.id} using current scope/index metadata.`,
      );
    }

    const matchedScopeLabel = isDefined(matchedScope) ? matchedScope : "<default>";
    const matchedIndexLabel = isDefined(matchedIndex) ? matchedIndex.toString() : "<current>";
    console.log(
      `Stealth signer session matched via scope ${matchedScopeLabel} @ index ${matchedIndexLabel}.`.grey,
    );
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

  if ((context.type === "ephemeral" || context.type === "stealth") && !isDefined(resolvedSigner)) {
    throw new Error("Resolved signer is unavailable for connected session address.");
  }

  if (isDefined(resolvedSigner)) {
    const provider = getProviderForChain(getCurrentNetwork()) as any;
    return resolvedSigner.connect(provider);
  }

  return resolvedSigner;
};

const parseRpcQuantityToBigInt = (value: unknown): Optional<bigint> => {
  if (!isDefined(value)) {
    return undefined;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Invalid numeric quantity.");
    }
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized.length) {
      return undefined;
    }
    if (/^0x[0-9a-fA-F]+$/.test(normalized) || /^[0-9]+$/.test(normalized)) {
      return BigInt(normalized);
    }
  }
  throw new Error("Invalid quantity value.");
};

const parseRpcQuantityToNumber = (value: unknown): Optional<number> => {
  const asBigInt = parseRpcQuantityToBigInt(value);
  if (!isDefined(asBigInt)) {
    return undefined;
  }
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Quantity exceeds safe integer range.");
  }
  return Number(asBigInt);
};

const parseEthSendTransactionInput = (params: unknown) => {
  if (!Array.isArray(params) || params.length < 1) {
    throw new Error("Invalid eth_sendTransaction params.");
  }

  const txLike = params[0] as Record<string, unknown>;
  if (!isDefined(txLike) || typeof txLike !== "object") {
    throw new Error("Missing eth_sendTransaction payload.");
  }

  const requestedAddress =
    typeof txLike.from === "string" && isHexAddress(txLike.from)
      ? txLike.from.toLowerCase()
      : undefined;

  const to = typeof txLike.to === "string" ? txLike.to.trim() : undefined;
  if (isDefined(to) && to.length && !isHexAddress(to)) {
    throw new Error("Invalid eth_sendTransaction recipient address.");
  }

  const currentChain = getChainForName(getCurrentNetwork());
  const txChainID = parseRpcQuantityToBigInt(txLike.chainId);
  if (isDefined(txChainID) && txChainID !== BigInt(currentChain.id)) {
    throw new Error(
      `eth_sendTransaction chain mismatch. request=0x${txChainID.toString(16)} wallet=0x${BigInt(currentChain.id).toString(16)}`,
    );
  }

  return {
    requestedAddress,
    transactionRequest: {
      to,
      data: typeof txLike.data === "string" ? txLike.data : undefined,
      value: parseRpcQuantityToBigInt(txLike.value),
      nonce: parseRpcQuantityToNumber(txLike.nonce),
      gasLimit: parseRpcQuantityToBigInt(txLike.gas),
      gasPrice: parseRpcQuantityToBigInt(txLike.gasPrice),
      maxFeePerGas: parseRpcQuantityToBigInt(txLike.maxFeePerGas),
      maxPriorityFeePerGas: parseRpcQuantityToBigInt(txLike.maxPriorityFeePerGas),
      chainId: txChainID,
    },
  };
};

const executeDirectEthSendForConnectedSigner = async (
  params: unknown,
  context: { connectedAddress?: string; type: ConnectedAccountType },
) => {
  const signer = await prepareSignerForConnectedSessionAddress(context);
  if (!isDefined(signer)) {
    throw new Error("Signer unavailable for direct eth_sendTransaction flow.");
  }

  const { requestedAddress, transactionRequest } = parseEthSendTransactionInput(params);
  if (
    isDefined(requestedAddress)
    && isDefined(context.connectedAddress)
    && requestedAddress !== context.connectedAddress.toLowerCase()
  ) {
    throw new Error(
      `Requested signer ${requestedAddress} does not match connected WalletConnect address ${context.connectedAddress.toLowerCase()}.`,
    );
  }

  const txResponse = await signer.sendTransaction(transactionRequest);
  return txResponse.hash;
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

const promptUnshieldERC20AmountsFromPrivateSelection = async (
  chainName: ReturnType<typeof getCurrentNetwork>,
): Promise<RailgunERC20Amount[]> => {
  const shouldAdd = await confirmPrompt(
    "Add private tokens to unshield for this bundle?",
    { initial: false },
  );
  if (!shouldAdd) {
    return [];
  }

  const selectedBalances = await tokenSelectionPrompt(
    chainName,
    "Select Private Tokens to Unshield",
    true,
    false,
  );
  if (!isDefined(selectedBalances) || !selectedBalances.length) {
    return [];
  }

  const selectedAmounts = await tokenAmountSelectionPrompt(
    selectedBalances,
    false,
    false,
    false,
    getCurrentRailgunAddress(),
  );

  return selectedAmounts.map((entry) => ({
    tokenAddress: entry.tokenAddress,
    amount: entry.selectedAmount,
  }));
};

const promptReshieldERC20RecipientsFromPrivateSelection = async (
  chainName: ReturnType<typeof getCurrentNetwork>,
): Promise<RailgunERC20Recipient[]> => {
  const shouldAdd = await confirmPrompt(
    "Add tokens to re-shield by token address?",
    { initial: false },
  );
  if (!shouldAdd) {
    return [];
  }

  const selectedBalances = await tokenSelectionPrompt(
    chainName,
    "Select Tokens to Re-shield (token-address only)",
    true,
    false,
  );
  if (!isDefined(selectedBalances) || !selectedBalances.length) {
    return [];
  }

  const recipientAddress = getCurrentRailgunAddress();
  return normalizeAndDedupeERC20Recipients(
    selectedBalances.map((entry: any) => ({
      tokenAddress: entry.tokenAddress,
      recipientAddress,
    })),
  );
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

    if (
      selected.method === "eth_sendTransaction"
      && hasEthBalance
      && bundleNativeValueTotal > 0n
    ) {
      console.log(
        "Detected non-zero call value and available account ETH; routing via public-send so value is funded by connected signer.".yellow,
      );

      const txHash = await executeDirectEthSendForConnectedSigner(
        selected.params,
        context,
      );
      const approved = await approveWalletConnectSessionRequest(selected.id, {
        approvedResultOverride: txHash,
      });
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

      const resolvedSigner = await prepareSignerForConnectedSessionAddress(context);

      if (selected.method === "eth_sendTransaction") {
        const txHash = await executeDirectEthSendForConnectedSigner(
          selected.params,
          context,
        );
        const approved = await approveWalletConnectSessionRequest(selected.id, {
          approvedResultOverride: txHash,
        });
        console.log(
          `Approved request #${approved.id} (${approved.method}) on topic ${approved.topic} via public-send.`.green,
        );
        return;
      }

      if (selected.method === "wallet_sendCalls" && isDefined(resolvedSigner)) {
        setWalletConnectSignerOverrideForTopic(selected.topic, resolvedSigner);
      }

      const approved = await approveWalletConnectSessionRequest(selected.id);
      console.log(
        `Approved request #${approved.id} (${approved.method}) on topic ${approved.topic} via public-send.`.green,
      );
      return;
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

const formatCompactTimestamp = (timestamp: number): string => {
  return new Date(timestamp)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
};

const normalizeImportedBundledCall = (call: any): WalletConnectBundledCall => {
  const to = typeof call?.to === "string" ? call.to.trim().toLowerCase() : "";
  if (!/^0x[0-9a-f]{40}$/.test(to)) {
    throw new Error("Each bundle call must include a valid 'to' address.");
  }

  const rawValue = typeof call?.value === "string" ? call.value.trim() : "0x0";
  const value = /^0x[0-9a-fA-F]+$/.test(rawValue)
    ? rawValue.toLowerCase()
    : /^[0-9]+$/.test(rawValue)
      ? `0x${BigInt(rawValue).toString(16)}`
      : "0x0";

  const data = typeof call?.data === "string" && /^0x[0-9a-fA-F]*$/.test(call.data.trim())
    ? call.data.trim().toLowerCase()
    : "0x";

  const operation = call?.operation === 1 ? 1 : 0;
  return { to, value, data, operation };
};

const normalizeImportedCapturedBundle = (
  input: any,
): ReturnType<typeof listWalletConnectCapturedBundles>[number] => {
  const callsSource = Array.isArray(input?.calls) ? input.calls : undefined;
  if (!callsSource?.length) {
    throw new Error("Bundle JSON must include a non-empty 'calls' array.");
  }

  const now = Date.now();
  const createdAt = typeof input?.createdAt === "number"
    ? input.createdAt
    : now;
  const topic = typeof input?.topic === "string" && input.topic.trim().length
    ? input.topic.trim()
    : "imported-bundle";
  const requestId = Number.isInteger(input?.requestId) ? Number(input.requestId) : now;
  const method = typeof input?.method === "string" && input.method.trim().length
    ? input.method.trim()
    : "wallet_sendCalls";

  return {
    key: typeof input?.key === "string" && input.key.trim().length
      ? input.key.trim()
      : `imported:${requestId}`,
    topic,
    requestId,
    chainId: typeof input?.chainId === "string" ? input.chainId.trim() : undefined,
    method,
    calls: callsSource.map(normalizeImportedBundledCall),
    rawParams: input?.rawParams,
    createdAt,
  };
};

const promptBundleFilePath = async (
  message: string,
  initial = "./walletconnect-bundle.json",
): Promise<Optional<string>> => {
  const prompt = new Input({
    header: " ",
    message,
    initial,
  });

  const filePath = (await prompt.run().catch(confirmPromptCatch)) as string | undefined;
  if (!isDefined(filePath) || !filePath.trim().length) {
    return undefined;
  }

  return resolve(filePath.trim());
};

const exportCapturedBundleToFile = async () => {
  const selectedBundle = await selectCapturedBundle();
  if (!isDefined(selectedBundle)) {
    return;
  }

  const filePath = await promptBundleFilePath(
    "Save selected bundle JSON to file",
    `./walletconnect-bundle-${selectedBundle.requestId}.json`,
  );
  if (!isDefined(filePath)) {
    return;
  }

  const payload = JSON.stringify(selectedBundle, null, 2);
  writeFileSync(filePath, `${payload}\n`, "utf8");
  console.log(`Saved bundle JSON to ${filePath}`.green);
};

const loadCapturedBundleFromFile = async () => {
  const filePath = await promptBundleFilePath("Load bundle JSON from file");
  if (!isDefined(filePath)) {
    return undefined;
  }

  const payload = readFileSync(filePath, "utf8");
  return normalizeImportedCapturedBundle(JSON.parse(payload));
};

const loadCapturedBundleFromPrompt = async () => {
  const prompt = new Input({
    header: " ",
    message: "Paste bundle JSON",
  });

  const raw = (await prompt.run().catch(confirmPromptCatch)) as string | undefined;
  if (!isDefined(raw) || !raw.trim().length) {
    return undefined;
  }

  return normalizeImportedCapturedBundle(JSON.parse(raw));
};

const buildComposedCapturedBundles = (
  bundles: ReturnType<typeof listWalletConnectCapturedBundles>,
) => {
  const isDefinedBundle = (
    bundle: Optional<ReturnType<typeof listWalletConnectCapturedBundles>[number]>,
  ): bundle is ReturnType<typeof listWalletConnectCapturedBundles>[number] => {
    return isDefined(bundle);
  };

  const groups = bundles.reduce<Record<string, typeof bundles>>((acc, bundle) => {
    if (!bundle.calls.length) {
      return acc;
    }

    const groupKey = `${bundle.topic}:${bundle.chainId ?? "n/a"}`;
    acc[groupKey] ??= [];
    acc[groupKey].push(bundle);
    return acc;
  }, {});

  return Object.entries(groups)
    .map(([groupKey, grouped]) => {
      const ordered = [...grouped].sort((left, right) => left.createdAt - right.createdAt);
      if (ordered.length < 2) {
        return undefined;
      }

      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const composedCalls = ordered.flatMap((bundle) => bundle.calls);

      return {
        key: `composed:${groupKey}`,
        topic: first.topic,
        requestId: last.requestId,
        chainId: first.chainId,
        method: "wallet_sendCalls",
        calls: composedCalls,
        rawParams: undefined,
        createdAt: last.createdAt,
      } as ReturnType<typeof listWalletConnectCapturedBundles>[number];
    })
    .filter(isDefinedBundle)
    .sort((left, right) => right.createdAt - left.createdAt);
};

const selectCapturedBundle = async (): Promise<
  Optional<ReturnType<typeof listWalletConnectCapturedBundles>[number]>
> => {
  const bundles = listWalletConnectCapturedBundles();
  const composedBundles = buildComposedCapturedBundles(bundles);
  if (!bundles.length) {
    console.log("No captured WalletConnect bundles yet.".yellow);
    return undefined;
  }

  const prompt = new Select({
    header: " ",
    message: "Select captured bundle",
    choices: [
      ...composedBundles.map((bundle) => ({
        name: bundle.key,
        message:
          `[${formatCompactTimestamp(bundle.createdAt)}] [composed] ${bundle.calls.length} call(s) · ${bundle.topic.slice(0, 16)}...` ,
      })),
      ...bundles.map((bundle) => ({
        name: bundle.key,
        message: `[${formatCompactTimestamp(bundle.createdAt)}] #${bundle.requestId} ${bundle.method} · ${bundle.calls.length} call(s) · ${bundle.topic.slice(0, 16)}...`,
      })),
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selectedKey = await prompt.run().catch(confirmPromptCatch);
  if (!selectedKey || selectedKey === "exit-menu") {
    return undefined;
  }

  return composedBundles.find((bundle) => bundle.key === selectedKey)
    ?? bundles.find((bundle) => bundle.key === selectedKey);
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

  const unsupportedBundleFields = getUnsupportedBundleFieldsFor7702(
    selectedBundle.method,
    selectedBundle.rawParams,
  );
  if (unsupportedBundleFields.length) {
    console.log(
      `Bundle includes fields not represented in 7702 builder call model: ${unsupportedBundleFields.join(", ")}.`
        .yellow,
    );
    const continueIgnoringUnsupported = await confirmPrompt(
      "Continue and ignore unsupported bundle fields?",
      { initial: false },
    );
    if (!continueIgnoringUnsupported) {
      return undefined;
    }
  }

  const chainName = getCurrentNetwork();

  const bundleRequestedFrom = getRequestedFromAddressForRequest(
    selectedBundle.method,
    selectedBundle.rawParams,
  );
  const bundleContext = isDefined(bundleRequestedFrom)
    ? {
      connectedAddress: bundleRequestedFrom,
      type: getConnectedAccountTypeForAddress(bundleRequestedFrom),
      stealthProfileID: getStealthProfileIDForAddress(bundleRequestedFrom),
    }
    : getConnectedAccountContext(selectedBundle.topic);
  let { connectedAddress } = bundleContext;
  if (bundleContext.type === "ephemeral" || bundleContext.type === "stealth") {
    const bundleSigner = await prepareSignerForConnectedSessionAddress(bundleContext);
    const signerAddress = bundleSigner?.address?.toLowerCase();
    if (isDefined(signerAddress)) {
      connectedAddress = signerAddress;
      console.log(
        `Using ${bundleContext.type} signer ${signerAddress} for 7702 bundle build.`.grey,
      );
    }
  }

  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) {
    console.log("Canceled (missing wallet password).".yellow);
    return undefined;
  }

  const totalNativeCallValue = getTotalBundledCallNativeValue(selectedBundle.calls);
  if (totalNativeCallValue > 0n) {
    console.log(
      `Bundled calls include native value (${totalNativeCallValue.toString()} wei). Select unshield token amounts manually if needed for this flow.`.yellow,
    );
  }

  const unshieldERC20Amounts = await promptUnshieldERC20AmountsFromPrivateSelection(
    chainName,
  );
  let shieldERC20Recipients = await promptReshieldERC20RecipientsFromPrivateSelection(
    chainName,
  );
  const currentRailgunAddress = getCurrentRailgunAddress();

  const derivedNFTActions = deriveNFTActionsFromBundledCalls(
    selectedBundle.calls,
    currentRailgunAddress,
  );
  const { unshieldNFTAmounts } = derivedNFTActions;
  let { shieldNFTRecipients } = derivedNFTActions;
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
      const selectedAutoShieldRecipients = await promptAutoReshieldTokenSelection(
        autoShieldRecipients,
      );
      if (selectedAutoShieldRecipients.length) {
        console.log(
          `Selected ${selectedAutoShieldRecipients.length} detected ERC20 token(s) to re-shield.`.grey,
        );
        shieldERC20Recipients.push(...selectedAutoShieldRecipients);
      } else {
        console.log("No detected ERC20 tokens selected for re-shield.".yellow);
      }
    }
    shieldERC20Recipients = normalizeAndDedupeERC20Recipients(shieldERC20Recipients);
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

const runBuildCrossContract7702FromImportedBundlePrompt = async (
  source: "file" | "json",
) => {
  try {
    const selectedBundle = source === "file"
      ? await loadCapturedBundleFromFile()
      : await loadCapturedBundleFromPrompt();
    if (!isDefined(selectedBundle)) {
      return;
    }

    await buildAndSendCrossContract7702FromBundle(selectedBundle);
  } catch (error) {
    console.log(`Invalid bundle input: ${(error as Error).message}`.yellow);
  }
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
  let approvalStealthProfileID: Optional<string>;
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
    approvalStealthProfileID = selectedProfile.id;
  }

  const approved = await approveWalletConnectSessionProposal(proposalID, {
    accountAddress: approvalAddress,
    scopeID: approvalScopeID,
  });

  const approvalContext = {
    connectedAddress: approvalAddress.toLowerCase(),
    type: getConnectedAccountTypeForAddress(approvalAddress),
    stealthProfileID: approvalStealthProfileID,
  };
  if (approvalContext.type === "ephemeral" || approvalContext.type === "stealth") {
    const resolvedSigner = await prepareSignerForConnectedSessionAddress(approvalContext);
    if (isDefined(resolvedSigner)) {
      setWalletConnectSignerOverrideForTopic(approved.topic, resolvedSigner);
    }
  }

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
  });

  const wcURI = (await uriPrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(wcURI)) {
    return;
  }
  const trimmedURI = wcURI.trim();
  if (!trimmedURI.length) {
    console.log("Pair canceled.".yellow);
    return;
  }
  if (!trimmedURI.startsWith("wc:")) {
    console.log("Pair canceled (invalid WalletConnect URI).".yellow);
    return;
  }

  const activeProfile = getActiveStealthProfile();
  const scopeID = isDefined(activeProfile)
    ? getPreferredScopeForProfile(activeProfile)
    : undefined;
  const paired = await pairWalletConnectURI(trimmedURI, {
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

const runMechTestWithCurrentWalletConnectSigner = async () => {
  const activeSessions = listWalletConnectSessions()
    .filter((session) => session.status !== "disconnected")
    .filter((session) => isDefined(session.connectedAddress))
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const currentSession = activeSessions[0];
  if (!isDefined(currentSession) || !isDefined(currentSession.connectedAddress)) {
    console.log("No active WalletConnect signer session found for mech test.".yellow);
    return;
  }

  const connectedAddress = currentSession.connectedAddress.toLowerCase();
  const context = {
    connectedAddress,
    type: getConnectedAccountTypeForAddress(connectedAddress),
    stealthProfileID: getStealthProfileIDForAddress(connectedAddress),
  };

  if (context.type === "stealth" && isDefined(context.stealthProfileID)) {
    setActiveStealthProfile(context.stealthProfileID);
  }

  if (context.type === "ephemeral" || context.type === "stealth") {
    const resolvedSigner = await prepareSignerForConnectedSessionAddress(context);
    if (!isDefined(resolvedSigner)) {
      throw new Error("Failed to resolve WalletConnect signer for mech test.");
    }
    setWalletConnectSignerOverrideForTopic(currentSession.topic, resolvedSigner);
    console.log(
      `Using ${context.type} WalletConnect signer ${connectedAddress} for mech test on topic ${currentSession.topic}.`
        .grey,
    );
  } else {
    console.log(
      `Using WalletConnect session ${currentSession.topic} (${connectedAddress}) for mech test.`.grey,
    );
  }

  const privateBalances = await getPrivateERC20BalancesForChain(
    getCurrentNetwork(),
    RailgunWalletBalanceBucket.Spendable,
  );
  const balances = privateBalances.reduce<Balances>((accum, entry) => {
    const tokenAddress = entry.tokenAddress?.toLowerCase();
    if (!isDefined(tokenAddress) || !isHexAddress(tokenAddress)) {
      return accum;
    }
    if (entry.amount <= 0n) {
      return accum;
    }
    accum[tokenAddress as `0x${string}`] = entry.amount;
    return accum;
  }, {} as Balances);

  await launchPilot(connectedAddress as `0x${string}`, balances, (request: any) => {
    console.log("REQUEST", request);
  });
};

export const runWalletConnectManagerPrompt = async (): Promise<void> => {
  const prompt = createLiveSelect({
    header: buildWalletConnectCardHeader,
    message: "WalletConnect Command Palette",
    choices: buildWalletConnectManagerChoices,
    multiple: false,
    refreshIntervalMs: 1000,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }
  // await launchPilotUI(mechAddress, balances);
  const shouldPauseForContinue = true;

  try {
    await initializeWalletConnectKit();

    switch (selection) {
      case "pair":
        await runPairPrompt();
        break;
      case "sessions-menu": {
        const cardHeader = await buildWalletConnectCardHeader();
        const summary = getWalletConnectSessionSummary();
        const sessionChoices: any[] = [
          { name: "pair", message: "Pair new WalletConnect URI".green },
        ];
        if (summary.paired > 0) {
          sessionChoices.push(
            { name: "list-active", message: `View paired sessions (${summary.paired})` },
            { name: "disconnect", message: `Disconnect paired session (${summary.paired})` },
          );
        }
        if (summary.total > 0) {
          sessionChoices.push({ name: "list", message: `View all sessions (${summary.total})` });
        }
        sessionChoices.push({ name: "exit-menu", message: "Go Back".grey });
        const sessionSelection = await new Select({
          header: cardHeader,
          message: "WalletConnect Sessions",
          choices: sessionChoices,
          multiple: false,
        }).run().catch(confirmPromptCatch);
        if (!sessionSelection || sessionSelection === "exit-menu") {
          break;
        }
        switch (sessionSelection) {
          case "pair":
            await runPairPrompt();
            break;
          case "disconnect":
            await runDisconnectPrompt();
            break;
          case "list-active":
            printWalletConnectPairedSessions();
            break;
          case "list":
            printWalletConnectSessions();
            break;
          default:
            break;
        }
        break;
      }
      case "pending-menu": {
        const cardHeader = await buildWalletConnectCardHeader();
        const summary = getWalletConnectSessionSummary();
        const pendingChoices: any[] = [];
        if (summary.pendingRequests > 0) {
          pendingChoices.push(
            { name: "approve-request", message: `Approve request (${summary.pendingRequests})`.cyan },
            { name: "reject-request", message: `Reject request (${summary.pendingRequests})` },
            { name: "pending-requests", message: `View pending requests (${summary.pendingRequests})` },
          );
        }
        if (summary.pendingProposals > 0) {
          pendingChoices.push(
            { name: "approve", message: `Approve proposal (${summary.pendingProposals})`.cyan },
            { name: "reject", message: `Reject proposal (${summary.pendingProposals})` },
            { name: "pending", message: `View pending proposals (${summary.pendingProposals})` },
          );
        }
        pendingChoices.push({ name: "exit-menu", message: "Go Back".grey });
        const pendingSelection = await new Select({
          header: cardHeader,
          message: "Pending WalletConnect Approvals",
          choices: pendingChoices,
          multiple: false,
        }).run().catch(confirmPromptCatch);
        if (!pendingSelection || pendingSelection === "exit-menu") {
          break;
        }
        switch (pendingSelection) {
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
          case "pending":
            await printPendingWalletConnectProposals();
            break;
          case "pending-requests":
            await printPendingWalletConnectRequests();
            break;
          default:
            break;
        }
        break;
      }
      case "bundles-menu": {
        const cardHeader = await buildWalletConnectCardHeader();
        const summary = getWalletConnectSessionSummary();
        const bundleChoices: any[] = [
          { name: "bundles", message: `View captured bundles (${summary.capturedBundles})` },
          { name: "build-7702", message: `Build 7702 transaction (${summary.capturedBundles})`.magenta },
          { name: "build-7702-file", message: "Build 7702 transaction from bundle JSON file".cyan },
          { name: "build-7702-json", message: "Build 7702 transaction from pasted bundle JSON".cyan },
          { name: "export-bundle", message: "Export captured bundle to JSON file" },
          { name: "clear-bundles", message: "Clear captured bundles" },
          { name: "exit-menu", message: "Go Back".grey },
        ];
        const bundleSelection = await new Select({
          header: cardHeader,
          message: "Bundles & 7702",
          choices: bundleChoices,
          multiple: false,
        }).run().catch(confirmPromptCatch);
        if (!bundleSelection || bundleSelection === "exit-menu") {
          break;
        }
        switch (bundleSelection) {
          case "bundles":
            printCapturedWalletConnectBundles();
            break;
          case "build-7702":
            await runBuildCrossContract7702FromBundlePrompt();
            break;
          case "build-7702-file":
            await runBuildCrossContract7702FromImportedBundlePrompt("file");
            break;
          case "build-7702-json":
            await runBuildCrossContract7702FromImportedBundlePrompt("json");
            break;
          case "export-bundle":
            await exportCapturedBundleToFile();
            break;
          case "clear-bundles": {
            const cleared = clearWalletConnectCapturedBundles();
            console.log(`Cleared ${cleared} captured WalletConnect bundle(s).`.green);
            break;
          }
          default:
            break;
        }
        break;
      }
      case "list":
        printWalletConnectSessions();
        break;
      case "list-active":
        printWalletConnectPairedSessions();
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
      case "mech-test":
        await runMechTestWithCurrentWalletConnectSigner();
        break;
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
