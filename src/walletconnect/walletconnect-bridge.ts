import { createHash } from "crypto";
import { isDefined } from "@railgun-community/shared-models";
import configDefaults from "../config/config-defaults";
import { WalletConnectSession } from "../models/wallet-models";
import { saveKeychainFile } from "../wallet/wallet-cache";
import { upsertEphemeralSessionScope } from "../wallet/ephemeral-wallet-manager";
import { walletManager } from "../wallet/wallet-manager";
import { pushUILog } from "../ui/log-ui";
import { getCurrentWalletPublicAddress } from "../wallet/wallet-util";
import { getCurrentNetwork } from "../engine/engine";
import { getChainForName } from "../network/network-util";

type ParsedWalletConnectURI = {
  topic: string;
  version: number;
  relayProtocol?: string;
  symKey: string;
};

type PairWalletConnectOptions = {
  scopeID?: string;
};

type PairWalletConnectResult = {
  topic: string;
  version: number;
  relayProtocol?: string;
  scopeID?: string;
  status: "paired";
};

type RuntimeActiveSession = {
  topic: string;
  namespaces?: Record<string, { accounts?: string[] }>;
  relay?: {
    protocol?: string;
  };
};

type RuntimePairing = {
  topic: string;
  relay?: {
    protocol?: string;
  };
  active: boolean;
};

type RuntimePendingProposal = {
  id: number;
  pairingTopic: string;
  proposer: {
    metadata: {
      name: string;
      url: string;
    };
  };
  requiredNamespaces: Record<string, unknown>;
  optionalNamespaces?: Record<string, unknown>;
};

type ProposalNamespaceRequirement = {
  chains?: string[];
  methods?: string[];
  events?: string[];
};

export type WalletConnectSessionView = {
  topic: string;
  version: number;
  relayProtocol?: string;
  connectedAddress?: string;
  scopeID?: string;
  status: string;
  updatedAt: number;
};

export type WalletConnectPendingProposalView = {
  id: number;
  pairingTopic: string;
  proposerName: string;
  proposerUrl: string;
  requiredNamespaces: Record<string, unknown>;
  optionalNamespaces?: Record<string, unknown>;
};

type ApproveWalletConnectProposalOptions = {
  scopeID?: string;
  accountAddress?: string;
};

export type ApproveWalletConnectProposalResult = {
  topic: string;
  scopeID?: string;
  accountAddress: string;
  status: "paired";
};

const MAX_WC_URI_LENGTH = 4096;
const MAX_SCOPE_LENGTH = 128;

let walletConnectCore: any | undefined = undefined;
let walletKit: any | undefined = undefined;
let walletKitInitializing: Promise<any> | undefined = undefined;
let walletKitListenersAttached = false;

let walletConnectSdkLoader: Promise<any> | undefined = undefined;

const getWalletConnectSdk = async (): Promise<any> => {
  if (!isDefined(walletConnectSdkLoader)) {
    walletConnectSdkLoader = Promise.all([
      import("@walletconnect/core"),
      import("@reown/walletkit"),
      import("@walletconnect/utils"),
    ]).then(([coreModule, walletKitModule, utilsModule]: any[]) => {
      return {
        Core: coreModule.Core,
        WalletKit: walletKitModule.WalletKit,
        getSdkError: utilsModule.getSdkError,
      };
    });
  }

  return walletConnectSdkLoader as Promise<any>;
};

const ensureKeychainIsLoaded = () => {
  if (!isDefined(walletManager.keyChain) || !isDefined(walletManager.keyChain.name)) {
    throw new Error("Wallet keychain is not loaded. Initialize wallet first.");
  }
};

const hashSymKey = (symKey: string) => {
  return createHash("sha256").update(symKey).digest("hex");
};

const persistKeychain = () => {
  const { keyChainPath } = configDefaults.engine;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
};

const getWalletConnectProjectID = () => {
  const fromConfig = configDefaults.apiKeys.walletConnectProjectId?.trim();
  if (isDefined(fromConfig) && fromConfig.length) {
    return fromConfig;
  }

  const fromEnv = process.env.WALLETCONNECT_PROJECT_ID?.trim();
  if (isDefined(fromEnv) && fromEnv.length) {
    return fromEnv;
  }

  return undefined;
};

const extractConnectedAddressFromSession = (session: RuntimeActiveSession) => {
  const namespaces = session.namespaces ?? {};
  for (const namespace of Object.values(namespaces)) {
    const accounts = namespace.accounts ?? [];
    for (const account of accounts) {
      if (typeof account !== "string") {
        continue;
      }
      const parts = account.split(":");
      if (parts.length < 3) {
        continue;
      }
      const address = parts[parts.length - 1];
      if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return address.toLowerCase();
      }
    }
  }
  return undefined;
};

const syncStoredWalletConnectSessionsFromRuntime = () => {
  if (!isDefined(walletKit) || !isDefined(walletConnectCore)) {
    return;
  }

  const activeSessionMap = walletKit.getActiveSessions() as Record<
    string,
    RuntimeActiveSession
  >;
  const pairingMap = (walletConnectCore.pairing.getPairings() as RuntimePairing[])
    .reduce<Record<string, RuntimePairing>>((acc, pairing) => {
      acc[pairing.topic] = pairing;
      return acc;
    }, {});
  const existingMap = walletManager.keyChain.walletConnectSessions ?? {};
  const now = Date.now();

  for (const session of Object.values(existingMap)) {
    const hasActiveSession = isDefined(activeSessionMap[session.topic]);
    const hasActivePairing = isDefined(pairingMap[session.topic])
      && pairingMap[session.topic].active;

    existingMap[session.topic] = {
      ...session,
      relayProtocol:
        activeSessionMap[session.topic]?.relay?.protocol
        ?? pairingMap[session.topic]?.relay?.protocol
        ?? session.relayProtocol,
      connectedAddress:
        extractConnectedAddressFromSession(activeSessionMap[session.topic] ?? { topic: session.topic })
        ?? session.connectedAddress,
      status: hasActiveSession || hasActivePairing ? "paired" : "disconnected",
      updatedAt: now,
    };
  }

  for (const pairing of Object.values(pairingMap)) {
    const existing = existingMap[pairing.topic];
    if (!isDefined(existing)) {
      continue;
    }

    existingMap[pairing.topic] = {
      ...existing,
      relayProtocol: pairing.relay?.protocol ?? existing.relayProtocol,
      status: pairing.active ? "paired" : existing.status,
      updatedAt: now,
    };
  }

  for (const activeSession of Object.values(activeSessionMap)) {
    const existing = existingMap[activeSession.topic];
    existingMap[activeSession.topic] = {
      topic: activeSession.topic,
      version: 2,
      relayProtocol: activeSession.relay?.protocol,
      connectedAddress:
        extractConnectedAddressFromSession(activeSession)
        ?? existing?.connectedAddress,
      symKeyHash: existing?.symKeyHash ?? "runtime",
      scopeID: existing?.scopeID,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: "paired",
    };
  }

  walletManager.keyChain.walletConnectSessions = existingMap;
  persistKeychain();
};

const attachWalletKitListeners = (client: any) => {
  if (walletKitListenersAttached) {
    return;
  }

  client.on("session_proposal", (event: { id: number; params: { proposer: { metadata: { name: string } } } }) => {
    const proposerName = event.params.proposer.metadata.name;
    pushUILog(
      `WalletConnect session proposal received: ${proposerName} (id ${event.id}).`,
      "log",
    );
  });

  client.on("session_request", (event: { topic: string; params: { request: { method: string } } }) => {
    pushUILog(
      `WalletConnect session request on topic ${event.topic}: ${event.params.request.method}`,
      "log",
    );
  });

  client.on("session_delete", (event: { topic: string }) => {
    walletManager.keyChain.walletConnectSessions ??= {};
    const existing = walletManager.keyChain.walletConnectSessions[event.topic];
    if (isDefined(existing)) {
      walletManager.keyChain.walletConnectSessions[event.topic] = {
        ...existing,
        status: "disconnected",
        updatedAt: Date.now(),
      };
      persistKeychain();
    }

    pushUILog(`WalletConnect session deleted: ${event.topic}`, "log");
  });

  walletKitListenersAttached = true;
};

export const initializeWalletConnectKit = async () => {
  ensureKeychainIsLoaded();

  if (isDefined(walletKit)) {
    return walletKit;
  }

  if (isDefined(walletKitInitializing)) {
    return walletKitInitializing;
  }

  const projectId = getWalletConnectProjectID();
  if (!isDefined(projectId)) {
    throw new Error(
      "WalletConnect Project ID is missing. Set apiKeys.walletConnectProjectId in remote config or WALLETCONNECT_PROJECT_ID env var.",
    );
  }

  walletKitInitializing = (async () => {
    const sdk = await getWalletConnectSdk();

    walletConnectCore = new sdk.Core({
      projectId,
    });

    const client = await sdk.WalletKit.init({
      core: walletConnectCore,
      metadata: {
        name: "Terminal Wallet CLI",
        description: "RAILGUN Terminal Wallet WalletConnect Bridge",
        url: "https://www.terminal-wallet.com",
        icons: [],
      },
    });

    walletKit = client;
    attachWalletKitListeners(client);
    syncStoredWalletConnectSessionsFromRuntime();
    return client;
  })();

  try {
    return await walletKitInitializing;
  } finally {
    walletKitInitializing = undefined;
  }
};

const parseWalletConnectURI = (uri: string): ParsedWalletConnectURI => {
  if (!isDefined(uri) || uri.length === 0) {
    throw new Error("WalletConnect URI is required.");
  }
  if (uri.length > MAX_WC_URI_LENGTH) {
    throw new Error("WalletConnect URI is too long.");
  }

  const match = uri.match(/^wc:([^@]+)@(\d+)\?(.+)$/);
  if (!isDefined(match)) {
    throw new Error("Invalid WalletConnect URI format.");
  }

  const [, topic, versionText, queryString] = match;
  const version = Number(versionText);

  if (!Number.isInteger(version) || version < 1 || version > 2) {
    throw new Error("Unsupported WalletConnect URI version.");
  }
  if (topic.length < 8 || topic.length > 128) {
    throw new Error("WalletConnect topic is invalid.");
  }

  const params = new URLSearchParams(queryString);
  const symKey = params.get("symKey") ?? "";
  const relayProtocol = params.get("relay-protocol") ?? undefined;

  if (!symKey.length) {
    throw new Error("WalletConnect URI missing symKey.");
  }
  if (version === 2 && !isDefined(relayProtocol)) {
    throw new Error("WalletConnect v2 URI missing relay-protocol.");
  }

  return {
    topic,
    version,
    relayProtocol,
    symKey,
  };
};

const sanitizeScopeID = (scopeID?: string) => {
  if (!isDefined(scopeID)) {
    return undefined;
  }

  const normalized = scopeID.trim();
  if (!normalized.length) {
    return undefined;
  }
  if (normalized.length > MAX_SCOPE_LENGTH) {
    throw new Error("WalletConnect scope is too long.");
  }

  return normalized;
};

const normalizeWalletConnectAccountAddress = (address: string) => {
  const normalized = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("WalletConnect account must be a valid 0x address.");
  }
  return normalized;
};

const getCurrentCaipChainID = () => {
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  return `eip155:${chain.id}`;
};

const getChainsForNamespaceRequirement = (
  namespaceKey: string,
  requirement: ProposalNamespaceRequirement,
) => {
  const requestedChains = (requirement.chains ?? []).filter((chain) => {
    return typeof chain === "string" && chain.length > 0;
  });
  if (requestedChains.length) {
    return requestedChains;
  }

  if (namespaceKey.includes(":")) {
    return [namespaceKey];
  }

  return [getCurrentCaipChainID()];
};

const buildApprovedNamespacesFromProposal = (
  proposal: RuntimePendingProposal,
  address: string,
) => {
  const requiredEntries = Object.entries(proposal.requiredNamespaces ?? {});
  const optionalEntries = Object.entries(proposal.optionalNamespaces ?? {});
  const sourceEntries = requiredEntries.length
    ? requiredEntries
    : optionalEntries;

  const namespaces: Record<
    string,
    {
      accounts: string[];
      methods: string[];
      events: string[];
    }
  > = {};

  for (const [namespaceKey, rawRequirement] of sourceEntries) {
    const requirement = rawRequirement as ProposalNamespaceRequirement;
    const chains = getChainsForNamespaceRequirement(namespaceKey, requirement);
    const methods = (requirement.methods ?? []).filter((method) => {
      return typeof method === "string" && method.length > 0;
    });
    const events = (requirement.events ?? []).filter((eventName) => {
      return typeof eventName === "string" && eventName.length > 0;
    });

    namespaces[namespaceKey] = {
      accounts: chains.map((chainId) => `${chainId}:${address}`),
      methods,
      events,
    };
  }

  return namespaces;
};

const getPendingProposalByID = async (
  proposalID: number,
): Promise<RuntimePendingProposal> => {
  const client = await initializeWalletConnectKit();
  const proposalMap = client.getPendingSessionProposals() as Record<
    string,
    RuntimePendingProposal
  >;

  const proposal = Object.values(proposalMap).find((candidate) => {
    return candidate.id === proposalID;
  });

  if (!isDefined(proposal)) {
    throw new Error(`No pending proposal found for id ${proposalID}.`);
  }
  return proposal;
};

export const pairWalletConnectURI = async (
  uri: string,
  options?: PairWalletConnectOptions,
): Promise<PairWalletConnectResult> => {
  ensureKeychainIsLoaded();
  const client = await initializeWalletConnectKit();

  const parsed = parseWalletConnectURI(uri);
  const scopeID = sanitizeScopeID(options?.scopeID);
  if (isDefined(scopeID)) {
    upsertEphemeralSessionScope(scopeID);
  }

  walletManager.keyChain.walletConnectSessions ??= {};

  const existing = walletManager.keyChain.walletConnectSessions[parsed.topic];
  const now = Date.now();

  const nextSession: WalletConnectSession = {
    topic: parsed.topic,
    version: parsed.version,
    relayProtocol: parsed.relayProtocol,
    connectedAddress: existing?.connectedAddress,
    symKeyHash: hashSymKey(parsed.symKey),
    scopeID,
    createdAt: isDefined(existing) ? existing.createdAt : now,
    updatedAt: now,
    status: "paired",
  };

  walletManager.keyChain.walletConnectSessions[parsed.topic] = nextSession;
  persistKeychain();

  await client.pair({ uri });
  syncStoredWalletConnectSessionsFromRuntime();

  return {
    topic: parsed.topic,
    version: parsed.version,
    relayProtocol: parsed.relayProtocol,
    scopeID,
    status: "paired",
  };
};

export const listWalletConnectSessions = (): WalletConnectSessionView[] => {
  ensureKeychainIsLoaded();

  if (isDefined(walletKit)) {
    syncStoredWalletConnectSessionsFromRuntime();
  }

  const sessionMap = walletManager.keyChain.walletConnectSessions ?? {};
  return Object.values(sessionMap)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((session) => ({
      topic: session.topic,
      version: session.version,
      relayProtocol: session.relayProtocol,
      connectedAddress: session.connectedAddress,
      scopeID: session.scopeID,
      status: session.status,
      updatedAt: session.updatedAt,
    }));
};

export const disconnectWalletConnectSession = async (topic: string) => {
  ensureKeychainIsLoaded();

  const normalizedTopic = topic.trim();
  if (!normalizedTopic.length) {
    throw new Error("WalletConnect topic is required.");
  }

  walletManager.keyChain.walletConnectSessions ??= {};
  const existing = walletManager.keyChain.walletConnectSessions[normalizedTopic];
  if (!isDefined(existing)) {
    return false;
  }

  if (isDefined(walletKit)) {
    const activeSessions = walletKit.getActiveSessions();
    if (isDefined(activeSessions[normalizedTopic])) {
      const sdk = await getWalletConnectSdk();
      await walletKit.disconnectSession({
        topic: normalizedTopic,
        reason: sdk.getSdkError("USER_DISCONNECTED"),
      });
    }
  }

  walletManager.keyChain.walletConnectSessions[normalizedTopic] = {
    ...existing,
    status: "disconnected",
    updatedAt: Date.now(),
  };
  persistKeychain();

  return true;
};

export const getWalletConnectPendingSessionProposals = async () => {
  const client = await initializeWalletConnectKit();
  const proposalMap = client.getPendingSessionProposals() as Record<
    string,
    RuntimePendingProposal
  >;
  return Object.values(proposalMap).map((proposal): WalletConnectPendingProposalView => {
    return {
      id: proposal.id,
      pairingTopic: proposal.pairingTopic,
      proposerName: proposal.proposer.metadata.name,
      proposerUrl: proposal.proposer.metadata.url,
      requiredNamespaces: proposal.requiredNamespaces,
      optionalNamespaces: proposal.optionalNamespaces,
    };
  });
};

export const approveWalletConnectSessionProposal = async (
  proposalID: number,
  options?: ApproveWalletConnectProposalOptions,
): Promise<ApproveWalletConnectProposalResult> => {
  const client = await initializeWalletConnectKit();
  const proposal = await getPendingProposalByID(proposalID);
  const scopeID = sanitizeScopeID(options?.scopeID);
  if (isDefined(scopeID)) {
    upsertEphemeralSessionScope(scopeID);
  }

  const selectedAccountAddress = options?.accountAddress;
  const selectedAddress = isDefined(selectedAccountAddress)
    ? normalizeWalletConnectAccountAddress(selectedAccountAddress)
    : normalizeWalletConnectAccountAddress(getCurrentWalletPublicAddress());
  const namespaces = buildApprovedNamespacesFromProposal(proposal, selectedAddress);
  if (!Object.keys(namespaces).length) {
    throw new Error(
      "WalletConnect proposal contains no approvable namespaces.",
    );
  }
  const session = await client.approveSession({
    id: proposal.id,
    namespaces,
  });

  walletManager.keyChain.walletConnectSessions ??= {};
  const existing = walletManager.keyChain.walletConnectSessions[session.topic];
  const now = Date.now();
  walletManager.keyChain.walletConnectSessions[session.topic] = {
    topic: session.topic,
    version: 2,
    relayProtocol: session.relay?.protocol,
    connectedAddress: selectedAddress,
    symKeyHash: existing?.symKeyHash ?? "runtime",
    scopeID: scopeID ?? existing?.scopeID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    status: "paired",
  };
  persistKeychain();

  return {
    topic: session.topic,
    scopeID: scopeID ?? existing?.scopeID,
    accountAddress: selectedAddress,
    status: "paired",
  };
};

export const rejectWalletConnectSessionProposal = async (proposalID: number) => {
  const client = await initializeWalletConnectKit();
  await getPendingProposalByID(proposalID);
  const sdk = await getWalletConnectSdk();

  await client.rejectSession({
    id: proposalID,
    reason: sdk.getSdkError("USER_REJECTED"),
  });
};
