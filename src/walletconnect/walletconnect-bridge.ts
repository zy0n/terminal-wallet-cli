import { createHash } from "crypto";
import { isDefined } from "@railgun-community/shared-models";
import { getBytes } from "ethers";
import configDefaults from "../config/config-defaults";
import {
  WalletConnectBundledCall,
  WalletConnectCapturedBundle,
  WalletConnectSession,
} from "../models/wallet-models";
import { saveKeychainFile } from "../wallet/wallet-cache";
import { upsertEphemeralSessionScope } from "../wallet/ephemeral-wallet-manager";
import { walletManager } from "../wallet/wallet-manager";
import { pushUILog } from "../ui/log-ui";
import { getCurrentWalletPublicAddress } from "../wallet/wallet-util";
import { getCurrentEthersWallet } from "../wallet/public-utils";
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

export type WalletConnectSessionSummary = {
  total: number;
  paired: number;
  disconnected: number;
  scoped: number;
  pendingProposals: number;
  pendingRequests: number;
  capturedBundles: number;
  activeConnectedAddress?: string;
  latestConnectedAddress?: string;
};

type RuntimeSessionRequestEvent = {
  id: number;
  topic: string;
  verifyContext?: {
    verified?: {
      origin?: string;
    };
  };
  params: {
    chainId?: string;
    request: {
      method: string;
      params?: unknown;
    };
  };
};

type RuntimePendingSessionRequest = {
  id: number;
  topic: string;
  params?: {
    chainId?: string;
    request?: {
      method?: string;
      params?: unknown;
    };
  };
  verifyContext?: {
    verified?: {
      origin?: string;
    };
  };
  expiryTimestamp?: number;
};

type WalletConnectJsonRpcResponse = {
  id: number;
  jsonrpc: "2.0";
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

class WalletCallRpcError extends Error {
  code: number;

  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const walletCallInvalidParams = (message: string, data?: unknown) => {
  return new WalletCallRpcError(-32602, message, data);
};

const walletCallUnauthorized = (message: string, data?: unknown) => {
  return new WalletCallRpcError(4100, message, data);
};

const walletCallUnsupportedCapability = (message: string, data?: unknown) => {
  return new WalletCallRpcError(5700, message, data);
};

const walletCallUnsupportedChain = (message: string, data?: unknown) => {
  return new WalletCallRpcError(5710, message, data);
};

const walletCallDuplicateID = (message: string, data?: unknown) => {
  return new WalletCallRpcError(5720, message, data);
};

const walletCallUnknownBundleID = (message: string, data?: unknown) => {
  return new WalletCallRpcError(5730, message, data);
};

const isWalletCallRpcError = (error: unknown): error is WalletCallRpcError => {
  return error instanceof WalletCallRpcError;
};

const toWalletCallErrorResponse = (
  id: number,
  error: unknown,
): WalletConnectJsonRpcResponse => {
  if (isWalletCallRpcError(error)) {
    return {
      id,
      jsonrpc: "2.0",
      error: {
        code: error.code,
        message: error.message,
        data: error.data,
      },
    };
  }

  return {
    id,
    jsonrpc: "2.0",
    error: {
      code: -32603,
      message: (error as Error)?.message ?? "Internal error",
    },
  };
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

export type WalletConnectPendingRequestView = {
  id: number;
  topic: string;
  chainId?: string;
  method: string;
  params?: unknown;
  origin?: string;
  expiryTimestamp?: number;
};

const MAX_WC_URI_LENGTH = 4096;
const MAX_SCOPE_LENGTH = 128;
const MAX_CAPTURED_BUNDLES = 100;

let walletConnectCore: any | undefined = undefined;
let walletKit: any | undefined = undefined;
let walletKitInitializing: Promise<any> | undefined = undefined;
let walletKitListenersAttached = false;
const walletConnectSignerOverridesByTopic: MapType<{
  signer: any;
  address: string;
  updatedAt: number;
}> = {};

type WalletSendCallsStatusReceipt = {
  logs: {
    address: string;
    data: string;
    topics: string[];
  }[];
  status: string;
  blockHash: string;
  blockNumber: string;
  gasUsed: string;
  transactionHash: string;
};

type WalletSendCallsStatusEntry = {
  id: string;
  chainId: string;
  status: number;
  atomic: boolean;
  version: string;
  transactionHashes: string[];
  receipts?: WalletSendCallsStatusReceipt[];
  createdAt: number;
  updatedAt: number;
};

const walletSendCallsStatusByID: MapType<WalletSendCallsStatusEntry> = {};

let walletConnectSdkLoader: Promise<any> | undefined = undefined;

const getWalletConnectSdk = async (): Promise<any> => {
  if (!isDefined(walletConnectSdkLoader)) {
    walletConnectSdkLoader = Promise.all([
      import("@walletconnect/core"),
      import("@reown/walletkit"),
      import("@walletconnect/utils"),
      import("@walletconnect/jsonrpc-utils"),
    ]).then(([coreModule, walletKitModule, utilsModule, jsonrpcModule]: any[]) => {
      return {
        Core: coreModule.Core,
        WalletKit: walletKitModule.WalletKit,
        getSdkError: utilsModule.getSdkError,
        formatJsonRpcResult: jsonrpcModule.formatJsonRpcResult,
        formatJsonRpcError: jsonrpcModule.formatJsonRpcError,
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

const getCapturedBundleMap = () => {
  walletManager.keyChain.walletConnectCapturedBundles ??= {};
  return walletManager.keyChain.walletConnectCapturedBundles;
};

const isHexAddress = (value: string) => {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
};

const normalizeHexValue = (value: unknown) => {
  if (!isDefined(value)) {
    return "0x0";
  }
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return "0x0";
    }
    return `0x${Math.floor(value).toString(16)}`;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(normalized)) {
      return normalized.toLowerCase();
    }
    if (/^[0-9]+$/.test(normalized)) {
      return `0x${BigInt(normalized).toString(16)}`;
    }
  }
  return "0x0";
};

const normalizeData = (value: unknown) => {
  if (typeof value !== "string") {
    return "0x";
  }
  const normalized = value.trim();
  if (!normalized.length) {
    return "0x";
  }
  if (/^0x[0-9a-fA-F]*$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  return "0x";
};

const mapTxLikeToBundledCall = (txLike: any): Optional<WalletConnectBundledCall> => {
  if (!isDefined(txLike) || typeof txLike !== "object") {
    return undefined;
  }

  const to = typeof txLike.to === "string" ? txLike.to.trim() : "";
  if (!to.length || !isHexAddress(to)) {
    return undefined;
  }

  return {
    to: to.toLowerCase(),
    value: normalizeHexValue(txLike.value),
    data: normalizeData(txLike.data ?? txLike.input),
    operation: 0,
  };
};

const getBundledCallsForRequest = (
  method: string,
  params: unknown,
): WalletConnectBundledCall[] => {
  if (method === "eth_sendTransaction") {
    const txLike = Array.isArray(params) ? params[0] : params;
    const call = mapTxLikeToBundledCall(txLike);
    return isDefined(call) ? [call] : [];
  }

  if (method === "wallet_sendCalls") {
    const root = Array.isArray(params) ? params[0] : params;

    const maybeCallsFromRoot = (root as any)?.calls;
    const maybeCallsFromParams = (params as any)?.calls;
    const maybeCallsDirect = Array.isArray(params)
      ? params
      : undefined;

    const callsSource = Array.isArray(maybeCallsFromRoot)
      ? maybeCallsFromRoot
      : Array.isArray(maybeCallsFromParams)
        ? maybeCallsFromParams
        : Array.isArray(maybeCallsDirect)
          ? maybeCallsDirect
          : [];

    return callsSource
      .map((callLike) => mapTxLikeToBundledCall(callLike))
      .filter((call) => isDefined(call)) as WalletConnectBundledCall[];
  }

  return [];
};

const shouldCaptureWalletConnectBundleMethod = (method: string) => {
  return [
    "personal_sign",
    "eth_signTypedData_v4",
    "eth_sendTransaction",
    "wallet_sendCalls",
  ].includes(method);
};

const captureWalletConnectBundle = (event: RuntimeSessionRequestEvent) => {
  const method = event.params.request.method;
  if (!shouldCaptureWalletConnectBundleMethod(method)) {
    return;
  }

  const params = event.params.request.params;
  const calls = getBundledCallsForRequest(method, params);

  const now = Date.now();
  const bundle: WalletConnectCapturedBundle = {
    key: `${event.topic}:${event.id}`,
    topic: event.topic,
    requestId: event.id,
    chainId: event.params.chainId,
    method,
    calls,
    rawParams: params,
    createdAt: now,
  };

  const map = getCapturedBundleMap();
  map[bundle.key] = bundle;

  const orderedKeys = Object.values(map)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((item) => item.key);

  for (const staleKey of orderedKeys.slice(MAX_CAPTURED_BUNDLES)) {
    delete map[staleKey];
  }

  persistKeychain();

  pushUILog(
    `WalletConnect request bundled: ${method} on ${event.topic} (${calls.length} call${calls.length === 1 ? "" : "s"}).`,
    "log",
  );
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

  client.on("session_request", (event: RuntimeSessionRequestEvent) => {
    const method = event.params.request.method;
    pushUILog(
      `WalletConnect session request on topic ${event.topic}: ${method}`,
      "log",
    );

    captureWalletConnectBundle(event);

    if (shouldAutoApproveRequestMethod(method)) {
      void respondToSessionRequest(client, event).catch((error) => {
        pushUILog(
          `WalletConnect failed to auto-respond to ${method} on ${event.topic}: ${(error as Error).message}`,
          "error",
        );
      });
      return;
    }

    pushUILog(
      `WalletConnect request ${event.id} is pending manual approval/rejection.`,
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
      clearWalletConnectSignerOverrideForTopic(event.topic);
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

export const setWalletConnectSignerOverrideForTopic = (
  topic: string,
  signer: { address: string },
) => {
  const normalizedTopic = topic.trim();
  if (!normalizedTopic.length) {
    throw new Error("WalletConnect topic is required for signer override.");
  }
  if (!isDefined(signer) || typeof signer.address !== "string") {
    throw new Error("Invalid signer override payload.");
  }

  walletConnectSignerOverridesByTopic[normalizedTopic] = {
    signer,
    address: normalizeWalletConnectAccountAddress(signer.address),
    updatedAt: Date.now(),
  };
};

export const clearWalletConnectSignerOverrideForTopic = (topic: string) => {
  const normalizedTopic = topic.trim();
  if (!normalizedTopic.length) {
    return;
  }
  delete walletConnectSignerOverridesByTopic[normalizedTopic];
};

const getCurrentCaipChainID = () => {
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  return `eip155:${chain.id}`;
};

const getCurrentChainIDHex = () => {
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  return `0x${BigInt(chain.id).toString(16)}`;
};

const getCurrentChainIDDecimal = () => {
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  return `${chain.id}`;
};

const getPendingSessionRequestsFromRuntime = (
  client: any,
): RuntimePendingSessionRequest[] => {
  const pending = client.getPendingSessionRequests() as
    | RuntimePendingSessionRequest[]
    | Record<string, RuntimePendingSessionRequest>
    | undefined;

  if (!isDefined(pending)) {
    return [];
  }

  if (Array.isArray(pending)) {
    return pending;
  }

  return Object.values(pending);
};

const getPendingSessionRequestByID = async (
  requestID: number,
): Promise<RuntimePendingSessionRequest> => {
  const client = await initializeWalletConnectKit();
  const pending = getPendingSessionRequestsFromRuntime(client);
  const request = pending.find((candidate) => candidate.id === requestID);
  if (!isDefined(request)) {
    throw new Error(`No pending WalletConnect request found for id ${requestID}.`);
  }
  return request;
};

const getConnectedAddressForTopic = (topic: string) => {
  const storedAddress = walletManager.keyChain?.walletConnectSessions?.[topic]?.connectedAddress;
  if (isDefined(storedAddress) && isHexAddress(storedAddress)) {
    return storedAddress.toLowerCase();
  }

  if (isDefined(walletKit)) {
    const activeSessionMap = walletKit.getActiveSessions() as Record<
      string,
      RuntimeActiveSession
    >;
    const runtimeAddress = extractConnectedAddressFromSession(activeSessionMap[topic]);
    if (isDefined(runtimeAddress) && isHexAddress(runtimeAddress)) {
      return runtimeAddress.toLowerCase();
    }
  }

  return normalizeWalletConnectAccountAddress(getCurrentWalletPublicAddress());
};

const toCanonicalHexChainID = (value: string): Optional<string> => {
  const normalized = value.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(normalized)) {
    return `0x${BigInt(normalized).toString(16)}`;
  }
  if (/^eip155:[0-9]+$/.test(normalized)) {
    const [, decimal] = normalized.split(":");
    return `0x${BigInt(decimal).toString(16)}`;
  }
  return undefined;
};

const getRequestedCapabilityAddress = (params: unknown): Optional<string> => {
  if (!Array.isArray(params) || params.length === 0) {
    return undefined;
  }

  const [addressParam] = params;
  if (typeof addressParam !== "string") {
    return undefined;
  }

  const normalized = addressParam.trim().toLowerCase();
  return isHexAddress(normalized) ? normalized : undefined;
};

const getRequestedCapabilityChainIDs = (params: unknown): string[] => {
  if (!Array.isArray(params) || params.length < 2) {
    return [getCurrentChainIDHex().toLowerCase()];
  }

  const [, chainsParam] = params;
  if (!Array.isArray(chainsParam)) {
    return [getCurrentChainIDHex().toLowerCase()];
  }

  const canonicalHex = chainsParam
    .filter((chainID) => typeof chainID === "string")
    .map((chainID) => toCanonicalHexChainID(chainID as string))
    .filter((chainID) => isDefined(chainID)) as string[];

  const deduped = [...new Set(canonicalHex)];
  if (deduped.length) {
    return deduped;
  }

  return [getCurrentChainIDHex().toLowerCase()];
};

const buildWalletSendCallsCapabilitiesByChain = (chainIDs: string[]) => {
  return chainIDs.reduce<Record<string, Record<string, unknown>>>((acc, chainID) => {
    acc[chainID] = {
      atomic: {
        status: "supported",
      },
    };
    return acc;
  }, {});
};

const getWalletCapabilitiesResult = (event: RuntimeSessionRequestEvent) => {
  const { params } = event.params.request;
  const connectedAddress = getConnectedAddressForTopic(event.topic);
  const requestedAddress = getRequestedCapabilityAddress(params);
  if (isDefined(requestedAddress) && requestedAddress !== connectedAddress) {
    throw walletCallUnauthorized(
      `wallet_getCapabilities requested address ${requestedAddress} is not authorized for topic ${event.topic}.`,
    );
  }

  const requestedChainIDs = getRequestedCapabilityChainIDs(params);
  const supportedChainID = getCurrentChainIDHex().toLowerCase();
  const supportedRequestedChainIDs = [...new Set(
    requestedChainIDs.filter((chainID) => chainID === supportedChainID),
  )];

  const universalCapabilities = buildWalletSendCallsCapabilitiesByChain(["0x0"]);
  const chainCapabilities = buildWalletSendCallsCapabilitiesByChain(
    supportedRequestedChainIDs,
  );

  return {
    ...universalCapabilities,
    ...chainCapabilities,
  };
};

const getWalletPermissionsResult = (event: RuntimeSessionRequestEvent) => {
  const connectedAddress = getConnectedAddressForTopic(event.topic);
  const origin = event.verifyContext?.verified?.origin;
  const invoker = typeof origin === "string" && /^https?:\/\//.test(origin)
    ? origin
    : "https://walletconnect.local";

  return [
    {
      caveats: [
        {
          type: "restrictReturnedAccounts",
          value: [connectedAddress],
        },
      ],
      date: Date.now(),
      id: `eth_accounts:${connectedAddress}`,
      invoker,
      parentCapability: "eth_accounts",
    },
  ];
};

const getClientVersion = () => {
  return "Terminal Wallet CLI/WalletConnect";
};

const toRpcHex = (value: bigint | number) => {
  const asBigInt = typeof value === "number" ? BigInt(value) : value;
  return `0x${asBigInt.toString(16)}`;
};

const createWalletSendCallsID = () => {
  return `wc_calls_${Date.now().toString(36)}_${Math.floor(
    Math.random() * 1_000_000,
  ).toString(36)}`;
};

const parseWalletSendCallsInput = (params: unknown) => {
  const root = Array.isArray(params) ? params[0] : params;
  if (!isDefined(root) || typeof root !== "object") {
    throw walletCallInvalidParams("Invalid wallet_sendCalls params.");
  }

  const payload = root as {
    version?: unknown;
    id?: unknown;
    from?: unknown;
    chainId?: unknown;
    atomicRequired?: unknown;
    calls?: unknown;
    capabilities?: unknown;
  };

  const requestedAddress =
    typeof payload.from === "string" && isHexAddress(payload.from)
      ? payload.from
      : undefined;

  if (!Array.isArray(payload.calls) || payload.calls.length === 0) {
    throw walletCallInvalidParams("wallet_sendCalls requires at least one call.");
  }

  const chainIdRaw =
    typeof payload.chainId === "string" ? payload.chainId.trim().toLowerCase() : undefined;
  const chainIdValue = isDefined(chainIdRaw)
    ? /^0x[0-9a-f]+$/.test(chainIdRaw)
      ? `0x${BigInt(chainIdRaw).toString(16)}`
      : /^eip155:[0-9]+$/.test(chainIdRaw)
        ? `0x${BigInt(chainIdRaw.split(":")[1]).toString(16)}`
        : undefined
    : undefined;
  if (!isDefined(chainIdValue)) {
    throw walletCallInvalidParams("wallet_sendCalls requires a valid chainId.");
  }

  const requestVersion =
    typeof payload.version === "string" && payload.version.trim().length
      ? payload.version.trim()
      : "2.0.0";

  const requestID =
    typeof payload.id === "string" && payload.id.trim().length
      ? payload.id.trim()
      : undefined;
  if (isDefined(requestID) && requestID.length > 4096) {
    throw walletCallInvalidParams("wallet_sendCalls id is too large.");
  }

  const atomicRequired = payload.atomicRequired === true;

  const isCapabilityOptional = (value: unknown) => {
    return isDefined(value)
      && typeof value === "object"
      && (value as { optional?: unknown }).optional === true;
  };

  const ensureCapabilitiesSupported = (rawCapabilities: unknown) => {
    if (!isDefined(rawCapabilities) || typeof rawCapabilities !== "object") {
      return;
    }

    for (const [name, capValue] of Object.entries(rawCapabilities as Record<string, unknown>)) {
      if (name === "atomic") {
        continue;
      }
      if (isCapabilityOptional(capValue)) {
        continue;
      }
      throw walletCallUnsupportedCapability(`Unsupported non-optional capability: ${name}`);
    }
  };

  ensureCapabilitiesSupported(payload.capabilities);

  const calls = payload.calls.map((rawCall, index) => {
    if (!isDefined(rawCall) || typeof rawCall !== "object") {
      throw walletCallInvalidParams(`wallet_sendCalls call[${index}] is invalid.`);
    }

    const call = rawCall as {
      to?: unknown;
      value?: unknown;
      data?: unknown;
      operation?: unknown;
      capabilities?: unknown;
    };

    const to = typeof call.to === "string" ? call.to.trim() : "";
    if (!to.length || !isHexAddress(to)) {
      throw walletCallInvalidParams(`wallet_sendCalls call[${index}] has invalid to address.`);
    }

    const operation = parseRpcQuantityToNumber(call.operation, "operation") ?? 0;
    if (operation !== 0) {
      throw walletCallInvalidParams("wallet_sendCalls only supports operation=0.");
    }

    ensureCapabilitiesSupported(call.capabilities);

    return {
      to,
      data: typeof call.data === "string" ? normalizeData(call.data) : "0x",
      value: parseRpcQuantityToBigInt(call.value, "value") ?? 0n,
    };
  });

  return {
    requestedAddress,
    chainIdValue,
    calls,
    requestVersion,
    requestID,
    atomicRequired,
  };
};

const parseWalletGetCallsStatusInput = (params: unknown) => {
  if (!Array.isArray(params) || params.length < 1) {
    throw walletCallInvalidParams("wallet_getCallsStatus requires an id param.");
  }
  const id = params[0];
  if (typeof id !== "string" || !id.trim().length) {
    throw walletCallInvalidParams("wallet_getCallsStatus id param is invalid.");
  }
  return id.trim();
};

const getWalletSendCallsStatusResult = (id: string) => {
  const entry = walletSendCallsStatusByID[id];
  if (!isDefined(entry)) {
    throw walletCallUnknownBundleID(`Unknown wallet_sendCalls id: ${id}`);
  }

  return {
    atomic: entry.atomic,
    capabilities: {
      caip345: {
        transactionHashes: entry.transactionHashes,
      },
    },
    chainId: entry.chainId,
    id: entry.id,
    receipts: entry.receipts,
    status: entry.status,
    version: entry.version,
  };
};

const shouldAutoApproveRequestMethod = (method: string) => {
  return [
    "wallet_getCapabilities",
    "wallet_getCallsStatus",
    "wallet_showCallsStatus",
    "eth_chainId",
    "net_version",
    "eth_accounts",
    "eth_requestAccounts",
    "eth_coinbase",
    "web3_clientVersion",
    "wallet_getPermissions",
  ].includes(method);
};

const resolveManualSigningAddress = (
  topic: string,
  requestedAddress?: string,
) => {
  const connectedAddress = getConnectedAddressForTopic(topic);
  const normalizedRequested = isDefined(requestedAddress)
    ? normalizeWalletConnectAccountAddress(requestedAddress)
    : connectedAddress;

  if (normalizedRequested !== connectedAddress) {
    throw walletCallUnauthorized(
      `Requested signer ${normalizedRequested} does not match connected WalletConnect address ${connectedAddress}.`,
    );
  }

  return connectedAddress;
};

const getConnectedWalletSignerForTopic = (
  topic: string,
  requestedAddress?: string,
) => {
  const connectedAddress = resolveManualSigningAddress(topic, requestedAddress);
  const signerOverride = walletConnectSignerOverridesByTopic[topic];
  const signer = isDefined(signerOverride)
    ? signerOverride.signer
    : getCurrentEthersWallet();
  const signerAddress = normalizeWalletConnectAccountAddress(signer.address);
  if (signerAddress !== connectedAddress) {
    throw walletCallUnauthorized(
      `Current signer ${signerAddress} does not match connected WalletConnect address ${connectedAddress}.`,
    );
  }
  return signer;
};

const parsePersonalSignInput = (params: unknown) => {
  if (!Array.isArray(params) || params.length < 1) {
    throw new Error("Invalid personal_sign params.");
  }

  const first = params[0];
  const second = params[1];

  let requestedAddress: Optional<string>;
  let message: unknown;

  if (typeof first === "string" && isHexAddress(first)) {
    requestedAddress = first;
    message = second;
  } else if (typeof second === "string" && isHexAddress(second)) {
    requestedAddress = second;
    message = first;
  } else {
    message = first;
  }

  if (!isDefined(message)) {
    throw new Error("Missing personal_sign message payload.");
  }

  return { requestedAddress, message };
};

const parseTypedDataV4Input = (params: unknown) => {
  if (!Array.isArray(params) || params.length < 2) {
    throw new Error("Invalid eth_signTypedData_v4 params.");
  }

  const first = params[0];
  const second = params[1];

  let requestedAddress: Optional<string>;
  let typedDataPayload: unknown;

  if (typeof first === "string" && isHexAddress(first)) {
    requestedAddress = first;
    typedDataPayload = second;
  } else if (typeof second === "string" && isHexAddress(second)) {
    requestedAddress = second;
    typedDataPayload = first;
  } else {
    typedDataPayload = second;
  }

  if (!isDefined(typedDataPayload)) {
    throw new Error("Missing eth_signTypedData_v4 payload.");
  }

  const parsedPayload =
    typeof typedDataPayload === "string"
      ? JSON.parse(typedDataPayload)
      : typedDataPayload;

  if (!isDefined(parsedPayload) || typeof parsedPayload !== "object") {
    throw new Error("Invalid typed data payload.");
  }

  return { requestedAddress, parsedPayload: parsedPayload as Record<string, unknown> };
};

const parseRpcQuantityToBigInt = (
  value: unknown,
  fieldName: string,
): Optional<bigint> => {
  if (!isDefined(value)) {
    return undefined;
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw walletCallInvalidParams(`Invalid ${fieldName} value.`);
    }
    return BigInt(Math.floor(value));
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized.length) {
      return undefined;
    }
    if (/^0x[0-9a-fA-F]+$/.test(normalized)) {
      return BigInt(normalized);
    }
    if (/^[0-9]+$/.test(normalized)) {
      return BigInt(normalized);
    }
  }

  throw walletCallInvalidParams(`Invalid ${fieldName} value.`);
};

const parseRpcQuantityToNumber = (
  value: unknown,
  fieldName: string,
): Optional<number> => {
  const asBigInt = parseRpcQuantityToBigInt(value, fieldName);
  if (!isDefined(asBigInt)) {
    return undefined;
  }

  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw walletCallInvalidParams(`${fieldName} exceeds safe integer range.`);
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
      ? txLike.from
      : undefined;

  const to = typeof txLike.to === "string" ? txLike.to.trim() : undefined;
  if (isDefined(to) && to.length && !isHexAddress(to)) {
    throw new Error("Invalid eth_sendTransaction recipient address.");
  }

  const currentChainIDHex = getCurrentChainIDHex().toLowerCase();
  const txChainID = parseRpcQuantityToBigInt(txLike.chainId, "chainId");
  if (isDefined(txChainID)) {
    const normalizedTxChain = `0x${txChainID.toString(16)}`;
    if (normalizedTxChain.toLowerCase() !== currentChainIDHex) {
      throw new Error(
        `eth_sendTransaction chain mismatch. request=${normalizedTxChain} wallet=${currentChainIDHex}`,
      );
    }
  }

  return {
    requestedAddress,
    transactionRequest: {
      to,
      data: typeof txLike.data === "string" ? normalizeData(txLike.data) : undefined,
      value: parseRpcQuantityToBigInt(txLike.value, "value"),
      nonce: parseRpcQuantityToNumber(txLike.nonce, "nonce"),
      gasLimit: parseRpcQuantityToBigInt(txLike.gas, "gas"),
      gasPrice: parseRpcQuantityToBigInt(txLike.gasPrice, "gasPrice"),
      maxFeePerGas: parseRpcQuantityToBigInt(txLike.maxFeePerGas, "maxFeePerGas"),
      maxPriorityFeePerGas: parseRpcQuantityToBigInt(
        txLike.maxPriorityFeePerGas,
        "maxPriorityFeePerGas",
      ),
      chainId: txChainID,
    },
  };
};

const buildManualApprovedRequestResult = async (
  event: RuntimeSessionRequestEvent,
): Promise<Optional<unknown>> => {
  const { method, params } = event.params.request;

  if (method === "personal_sign") {
    const { requestedAddress, message } = parsePersonalSignInput(params);
    const signer = getConnectedWalletSignerForTopic(event.topic, requestedAddress);
    const signature =
      typeof message === "string" && /^0x[0-9a-fA-F]*$/.test(message)
        ? await signer.signMessage(getBytes(message))
        : await signer.signMessage(String(message));
    return signature;
  }

  if (method === "eth_signTypedData_v4") {
    const { requestedAddress, parsedPayload } = parseTypedDataV4Input(params);
    const signer = getConnectedWalletSignerForTopic(event.topic, requestedAddress);

    const domain = (parsedPayload.domain ?? {}) as Record<string, unknown>;
    const message = (parsedPayload.message ?? {}) as Record<string, unknown>;
    const rawTypes = (parsedPayload.types ?? {}) as Record<string, unknown>;
    const types = Object.entries(rawTypes).reduce<Record<string, unknown>>(
      (acc, [key, value]) => {
        if (key !== "EIP712Domain") {
          acc[key] = value;
        }
        return acc;
      },
      {},
    );

    const signature = await signer.signTypedData(
      domain as any,
      types as any,
      message as any,
    );
    return signature;
  }

  if (method === "eth_sendTransaction") {
    const { requestedAddress, transactionRequest } = parseEthSendTransactionInput(params);
    const signer = getConnectedWalletSignerForTopic(event.topic, requestedAddress);
    const txResponse = await signer.sendTransaction(transactionRequest);
    return txResponse.hash;
  }

  if (method === "wallet_sendCalls") {
    const {
      requestedAddress,
      chainIdValue,
      calls,
      requestVersion,
      requestID,
      atomicRequired,
    } = parseWalletSendCallsInput(params);
    const signer = getConnectedWalletSignerForTopic(event.topic, requestedAddress);

    const expectedChainID = getCurrentChainIDHex().toLowerCase();
    if (chainIdValue !== expectedChainID) {
      throw walletCallUnsupportedChain(
        `wallet_sendCalls chain mismatch. request=${chainIdValue} wallet=${expectedChainID}`,
      );
    }

    if (atomicRequired !== true) {
      throw new Error("wallet_sendCalls requires atomicRequired=true for this wallet.");
    }

    const id = requestID ?? createWalletSendCallsID();
    if (isDefined(walletSendCallsStatusByID[id])) {
      throw walletCallDuplicateID(`Duplicate wallet_sendCalls id: ${id}`);
    }
    const txResponses = await Promise.all(
      calls.map((call) => {
        return signer.sendTransaction({
          to: call.to,
          data: call.data,
          value: call.value,
        });
      }),
    );

    const transactionHashes = txResponses.map((tx) => tx.hash);
    walletSendCallsStatusByID[id] = {
      id,
      chainId: expectedChainID,
      status: 100,
      atomic: true,
      version: requestVersion,
      transactionHashes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    void Promise.all(
      txResponses.map((tx) => {
        return tx.wait().catch(() => undefined);
      }),
    )
      .then((receipts) => {
        const successfulReceipts = receipts.filter((receipt) => {
          return isDefined(receipt);
        }) as NonNullable<(typeof receipts)[number]>[];
        const formattedReceipts = successfulReceipts.map((receipt) => {
          return {
            logs: receipt.logs.map((log: any) => ({
              address: log.address,
              data: log.data,
              topics: [...log.topics],
            })),
            status: toRpcHex(receipt.status ?? 0),
            blockHash: receipt.blockHash,
            blockNumber: toRpcHex(receipt.blockNumber),
            gasUsed: toRpcHex(receipt.gasUsed),
            transactionHash: receipt.hash,
          };
        });

        const hasFailure = successfulReceipts.some((receipt) => receipt.status !== 1);
        walletSendCallsStatusByID[id] = {
          ...walletSendCallsStatusByID[id],
          receipts: formattedReceipts,
          status: hasFailure ? 500 : 200,
          updatedAt: Date.now(),
        };
      })
      .catch(() => {
        walletSendCallsStatusByID[id] = {
          ...walletSendCallsStatusByID[id],
          status: 500,
          updatedAt: Date.now(),
        };
      });

    return {
      id,
      capabilities: {
        caip345: {
          transactionHashes,
        },
      },
    };
  }

  return undefined;
};

const buildApprovedRequestResult = (event: RuntimeSessionRequestEvent): Optional<unknown> => {
  const { method, params } = event.params.request;

  if (method === "wallet_getCapabilities") {
    return getWalletCapabilitiesResult(event);
  }
  if (method === "wallet_getCallsStatus") {
    const id = parseWalletGetCallsStatusInput(params);
    return getWalletSendCallsStatusResult(id);
  }
  if (method === "wallet_showCallsStatus") {
    const id = parseWalletGetCallsStatusInput(params);
    if (!isDefined(walletSendCallsStatusByID[id])) {
      throw walletCallUnknownBundleID(`Unknown wallet_sendCalls id: ${id}`);
    }
    return null;
  }
  if (method === "wallet_getPermissions") {
    return getWalletPermissionsResult(event);
  }
  if (method === "eth_chainId") {
    return getCurrentChainIDHex();
  }
  if (method === "net_version") {
    return getCurrentChainIDDecimal();
  }
  if (method === "web3_clientVersion") {
    return getClientVersion();
  }
  if (method === "eth_coinbase") {
    return getConnectedAddressForTopic(event.topic);
  }
  if (method === "eth_accounts" || method === "eth_requestAccounts") {
    return [getConnectedAddressForTopic(event.topic)];
  }
  return undefined;
};

const respondToSessionRequest = async (
  client: any,
  event: RuntimeSessionRequestEvent,
) => {
  const sdk = await getWalletConnectSdk();
  let response: WalletConnectJsonRpcResponse;

  try {
    const approvedResult = buildApprovedRequestResult(event);
    response = isDefined(approvedResult)
      ? sdk.formatJsonRpcResult(event.id, approvedResult)
      : sdk.formatJsonRpcError(
        event.id,
        sdk.getSdkError("USER_REJECTED_METHODS"),
        `Unsupported method: ${event.params.request.method}`,
      );
  } catch (error) {
    response = toWalletCallErrorResponse(event.id, error);
  }

  await client.respondSessionRequest({
    topic: event.topic,
    response,
  });

  pushUILog(
    isDefined(response.result)
      ? `WalletConnect responded to ${event.params.request.method} on ${event.topic}.`
      : `WalletConnect rejected ${event.params.request.method} on ${event.topic}.`,
    "log",
  );
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

export const getWalletConnectSessionSummary = (): WalletConnectSessionSummary => {
  const sessionMap = walletManager.keyChain?.walletConnectSessions ?? {};
  const sessions = Object.values(sessionMap);
  const pairedSessions = sessions.filter((session) => session.status === "paired");
  const capturedBundles = Object.keys(
    walletManager.keyChain?.walletConnectCapturedBundles ?? {},
  ).length;

  const total = sessions.length;
  const paired = pairedSessions.length;
  const disconnected = total - paired;
  const scoped = sessions.filter((session) => isDefined(session.scopeID)).length;

  const latestConnectedAddress = pairedSessions
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .find((session) => isDefined(session.connectedAddress))?.connectedAddress;

  const activeConnectedAddress = Object.entries(walletConnectSignerOverridesByTopic)
    .filter(([topic, override]) => {
      if (!isDefined(override?.address)) {
        return false;
      }
      const pairedSession = pairedSessions.find((session) => session.topic === topic);
      return isDefined(pairedSession);
    })
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .map(([, override]) => override.address)
    .find((address) => isDefined(address))
    ?? latestConnectedAddress;

  const pendingProposals = isDefined(walletKit)
    ? Object.keys(walletKit.getPendingSessionProposals() ?? {}).length
    : 0;
  const pendingRequests = isDefined(walletKit)
    ? getPendingSessionRequestsFromRuntime(walletKit).length
    : 0;

  return {
    total,
    paired,
    disconnected,
    scoped,
    pendingProposals,
    pendingRequests,
    capturedBundles,
    activeConnectedAddress,
    latestConnectedAddress,
  };
};

export const getWalletConnectPendingSessionRequests = async (): Promise<
  WalletConnectPendingRequestView[]
> => {
  const client = await initializeWalletConnectKit();
  return getPendingSessionRequestsFromRuntime(client)
    .map((request) => {
      const method = request.params?.request?.method;
      return {
        id: request.id,
        topic: request.topic,
        chainId: request.params?.chainId,
        method: isDefined(method) ? method : "unknown",
        params: request.params?.request?.params,
        origin: request.verifyContext?.verified?.origin,
        expiryTimestamp: request.expiryTimestamp,
      };
    })
    .sort((left, right) => right.id - left.id);
};

export type ApproveWalletConnectRequestOptions = {
  approvedResultOverride?: unknown;
};

export const approveWalletConnectSessionRequest = async (
  requestID: number,
  options?: ApproveWalletConnectRequestOptions,
) => {
  const client = await initializeWalletConnectKit();
  const sdk = await getWalletConnectSdk();
  const pendingRequest = await getPendingSessionRequestByID(requestID);

  const method = pendingRequest.params?.request?.method ?? "unknown";
  const requestEvent: RuntimeSessionRequestEvent = {
    id: pendingRequest.id,
    topic: pendingRequest.topic,
    params: {
      chainId: pendingRequest.params?.chainId,
      request: {
        method,
        params: pendingRequest.params?.request?.params,
      },
    },
  };

  let approvedResult = options?.approvedResultOverride;
  if (!isDefined(approvedResult)) {
    approvedResult = buildApprovedRequestResult(requestEvent);
  }
  if (!isDefined(approvedResult)) {
    approvedResult = await buildManualApprovedRequestResult(requestEvent);
  }
  if (!isDefined(approvedResult)) {
    throw new Error(
      `Unsupported manual approval method: ${method}. Reject this request or add method handling.`,
    );
  }

  const response: WalletConnectJsonRpcResponse = sdk.formatJsonRpcResult(
    pendingRequest.id,
    approvedResult,
  );

  await client.respondSessionRequest({
    topic: pendingRequest.topic,
    response,
  });

  pushUILog(
    `WalletConnect request ${requestID} approved for ${method}.`,
    "log",
  );

  return {
    id: pendingRequest.id,
    topic: pendingRequest.topic,
    method,
  };
};

export const rejectWalletConnectSessionRequest = async (requestID: number) => {
  const client = await initializeWalletConnectKit();
  const sdk = await getWalletConnectSdk();
  const pendingRequest = await getPendingSessionRequestByID(requestID);
  const method = pendingRequest.params?.request?.method ?? "unknown";

  const response: WalletConnectJsonRpcResponse = sdk.formatJsonRpcError(
    pendingRequest.id,
    sdk.getSdkError("USER_REJECTED_METHODS"),
    `Rejected by user: ${method}`,
  );

  await client.respondSessionRequest({
    topic: pendingRequest.topic,
    response,
  });

  pushUILog(
    `WalletConnect request ${requestID} rejected for ${method}.`,
    "log",
  );

  return {
    id: pendingRequest.id,
    topic: pendingRequest.topic,
    method,
  };
};

export type WalletConnectCapturedBundleView = {
  key: string;
  topic: string;
  requestId: number;
  chainId?: string;
  method: string;
  calls: WalletConnectBundledCall[];
  rawParams?: unknown;
  createdAt: number;
};

export const listWalletConnectCapturedBundles = (): WalletConnectCapturedBundleView[] => {
  const map = walletManager.keyChain?.walletConnectCapturedBundles ?? {};
  return Object.values(map)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((bundle) => ({
      key: bundle.key,
      topic: bundle.topic,
      requestId: bundle.requestId,
      chainId: bundle.chainId,
      method: bundle.method,
      calls: bundle.calls,
      rawParams: bundle.rawParams,
      createdAt: bundle.createdAt,
    }));
};

export const clearWalletConnectCapturedBundles = () => {
  const map = getCapturedBundleMap();
  const count = Object.keys(map).length;
  walletManager.keyChain.walletConnectCapturedBundles = {};
  persistKeychain();
  return count;
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
  clearWalletConnectSignerOverrideForTopic(normalizedTopic);
  persistKeychain();

  return true;
};

export const disconnectAllWalletConnectSessions = async () => {
  ensureKeychainIsLoaded();

  const sessions = listWalletConnectSessions().filter((session) => {
    return session.status === "paired";
  });

  if (!sessions.length) {
    return 0;
  }

  let disconnectedCount = 0;
  for (const session of sessions) {
    try {
      const disconnected = await disconnectWalletConnectSession(session.topic);
      if (disconnected) {
        disconnectedCount += 1;
      }
    } catch {
      // continue disconnecting remaining sessions
    }
  }

  return disconnectedCount;
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
