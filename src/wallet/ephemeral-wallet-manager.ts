import { isDefined } from "@railgun-community/shared-models";
import {
  EphemeralKeyManager,
  fullWalletForID,
} from "@railgun-community/wallet";
import { RailgunTransaction } from "../models/transaction-models";
import {
  EphemeralSessionRatchetPolicy,
  EphemeralSessionScope,
  EphemeralWalletCache,
} from "../models/wallet-models";
import configDefaults from "../config/config-defaults";
import { saveKeychainFile } from "./wallet-cache";
import { getCurrentRailgunID } from "./wallet-util";
import { walletManager } from "./wallet-manager";
import { getCurrentNetwork } from "../engine/engine";
import { getChainForName } from "../network/network-util";

type EphemeralWalletDerivationStrategy = (...args: unknown[]) => unknown;

type EphemeralSignerProvider = {
  deriveWallet: EphemeralWalletDerivationStrategy;
};

type RailgunWalletWithEphemeralSignerProvider = {
  setEphemeralSignerProvider?: (provider: EphemeralSignerProvider) => void;
  setEphemeralWalletDerivationStrategy?: (
    strategy: EphemeralWalletDerivationStrategy,
  ) => void;
};

const lower = (value: string) => value.toLowerCase();

const scopedEphemeralDerivationStrategies: MapType<EphemeralWalletDerivationStrategy> = {};
const MAX_SCOPE_ID_LENGTH = 128;

const getDefaultScopedRatchetPolicy = (): EphemeralSessionRatchetPolicy => {
  return {
    enabled: true,
    broadcastMode: "any",
    ratchetOnTransactions: [RailgunTransaction.Private0XSwap],
  };
};

const normalizeScopeID = (scopeID?: string) => {
  if (!isDefined(scopeID)) {
    return undefined;
  }

  const normalized = scopeID.trim();
  if (!normalized.length) {
    return undefined;
  }
  if (normalized.length > MAX_SCOPE_ID_LENGTH) {
    throw new Error("Ephemeral scope ID is too long.");
  }

  return normalized;
};

const getEphemeralWalletMap = () => {
  walletManager.keyChain.ephemeralWallets ??= {};
  return walletManager.keyChain.ephemeralWallets;
};

const getEphemeralSessionScopeMap = () => {
  walletManager.keyChain.ephemeralSessionScopes ??= {};
  return walletManager.keyChain.ephemeralSessionScopes;
};

const persistKeychain = () => {
  const { keyChainPath } = configDefaults.engine;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
};

const getOrCreateWalletCache = (walletID: string): EphemeralWalletCache => {
  const cacheMap = getEphemeralWalletMap();
  cacheMap[walletID] ??= {
    currentIndex: 0,
    addressByIndex: {},
    lastUpdated: Date.now(),
  };
  return cacheMap[walletID];
};

const getScopedDerivationStrategy = (scopeID?: string) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    return undefined;
  }
  return scopedEphemeralDerivationStrategies[normalizedScopeID];
};

const applyScopedDerivationStrategy = (
  walletID: string,
  scopeID?: string,
) => {
  const strategy = getScopedDerivationStrategy(scopeID);
  if (!isDefined(strategy)) {
    return;
  }

  const railgunWallet = fullWalletForID(walletID) as RailgunWalletWithEphemeralSignerProvider;
  if (isDefined(railgunWallet.setEphemeralWalletDerivationStrategy)) {
    railgunWallet.setEphemeralWalletDerivationStrategy(strategy);
    return;
  }

  if (isDefined(railgunWallet.setEphemeralSignerProvider)) {
    railgunWallet.setEphemeralSignerProvider({ deriveWallet: strategy });
  }
};

const getEphemeralKeyManager = (
  walletID: string,
  encryptionKey: string,
  scopeID?: string,
) => {
  applyScopedDerivationStrategy(walletID, scopeID);
  const railgunWallet = fullWalletForID(walletID);
  return new EphemeralKeyManager(railgunWallet, encryptionKey);
};

export const setScopedEphemeralWalletDerivationStrategy = (
  scopeID: string,
  strategy: EphemeralWalletDerivationStrategy,
) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    throw new Error("Ephemeral derivation strategy scope must be a non-empty string.");
  }
  scopedEphemeralDerivationStrategies[normalizedScopeID] = strategy;
};

export const clearScopedEphemeralWalletDerivationStrategy = (scopeID: string) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    throw new Error("Ephemeral derivation strategy scope must be a non-empty string.");
  }
  delete scopedEphemeralDerivationStrategies[normalizedScopeID];
};

export const activateScopedEphemeralWalletDerivationStrategy = (
  scopeID: string,
  walletID = getCurrentRailgunID(),
) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    throw new Error("Ephemeral derivation strategy scope must be a non-empty string.");
  }
  if (!isDefined(walletID)) {
    return false;
  }
  applyScopedDerivationStrategy(walletID, normalizedScopeID);
  return true;
};

const getOrCreateEphemeralSessionScope = (
  scopeID: string,
): EphemeralSessionScope => {
  const scopeMap = getEphemeralSessionScopeMap();
  const now = Date.now();
  scopeMap[scopeID] ??= {
    scopeID,
    policy: getDefaultScopedRatchetPolicy(),
    ratchetCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  return scopeMap[scopeID];
};

const updateScopeState = (
  scopeID: string,
  index: number,
  address: string,
  didRatchet: boolean,
) => {
  const scope = getOrCreateEphemeralSessionScope(scopeID);
  scope.lastKnownAddress = address;
  scope.lastKnownIndex = index;
  scope.ratchetCount = didRatchet ? scope.ratchetCount + 1 : scope.ratchetCount;
  scope.updatedAt = Date.now();
  persistKeychain();
};

const shouldRatchetWithPolicy = (
  transactionType: RailgunTransaction,
  isBroadcasted: boolean,
  scopeID?: string,
) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    return transactionType === RailgunTransaction.Private0XSwap;
  }

  const scope = getOrCreateEphemeralSessionScope(normalizedScopeID);
  const { policy } = scope;

  if (!policy.enabled) {
    return false;
  }
  if (
    policy.broadcastMode === "broadcasted-only" &&
    !isBroadcasted
  ) {
    return false;
  }
  if (
    policy.broadcastMode === "self-signed-only" &&
    isBroadcasted
  ) {
    return false;
  }

  return policy.ratchetOnTransactions.includes(transactionType);
};

export const upsertEphemeralSessionScope = (
  scopeID: string,
  policy?: Partial<EphemeralSessionRatchetPolicy>,
) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    throw new Error("Ephemeral scope ID must be a non-empty string.");
  }

  const scope = getOrCreateEphemeralSessionScope(normalizedScopeID);
  if (isDefined(policy)) {
    scope.policy = {
      enabled: policy.enabled ?? scope.policy.enabled,
      broadcastMode: policy.broadcastMode ?? scope.policy.broadcastMode,
      ratchetOnTransactions:
        policy.ratchetOnTransactions ?? scope.policy.ratchetOnTransactions,
    };
  }
  scope.updatedAt = Date.now();
  persistKeychain();
  return scope;
};

export const setEphemeralSessionRatchetPolicy = (
  scopeID: string,
  policy: EphemeralSessionRatchetPolicy,
) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    throw new Error("Ephemeral scope ID must be a non-empty string.");
  }

  const scope = getOrCreateEphemeralSessionScope(normalizedScopeID);
  scope.policy = {
    enabled: policy.enabled,
    broadcastMode: policy.broadcastMode,
    ratchetOnTransactions: [...policy.ratchetOnTransactions],
  };
  scope.updatedAt = Date.now();
  persistKeychain();
  return scope;
};

export const getEphemeralSessionScope = (scopeID: string) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    return undefined;
  }

  const scopeMap = getEphemeralSessionScopeMap();
  return scopeMap[normalizedScopeID];
};

export const listEphemeralSessionScopes = () => {
  const scopeMap = getEphemeralSessionScopeMap();
  return Object.values(scopeMap).sort((left, right) => {
    return right.updatedAt - left.updatedAt;
  });
};

export const removeEphemeralSessionScope = (scopeID: string) => {
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (!isDefined(normalizedScopeID)) {
    throw new Error("Ephemeral scope ID must be a non-empty string.");
  }

  const scopeMap = getEphemeralSessionScopeMap();
  if (!isDefined(scopeMap[normalizedScopeID])) {
    return false;
  }
  delete scopeMap[normalizedScopeID];
  persistKeychain();
  return true;
};

const autoSyncEphemeralIndex = async (
  manager: EphemeralKeyManager,
) => {
  const chainName = getCurrentNetwork();
  const chain = getChainForName(chainName);
  await manager.scanHistoryForEphemeralIndex(chain);
};

const cacheEphemeralState = (
  walletID: string,
  index: number,
  address: string,
) => {
  const cache = getOrCreateWalletCache(walletID);
  cache.currentIndex = index;
  cache.addressByIndex[index] = address;
  cache.lastKnownAddress = address;
  cache.lastUpdated = Date.now();
  persistKeychain();
};

const findKnownIndexForAddress = (
  cache: EphemeralWalletCache,
  address: string,
): Optional<number> => {
  const target = lower(address);
  const match = Object.entries(cache.addressByIndex).find(([, knownAddress]) => {
    return lower(knownAddress) === target;
  });

  if (!isDefined(match)) {
    return undefined;
  }
  return Number(match[0]);
};

export const shouldRatchetForTransaction = (
  transactionType: RailgunTransaction,
  isBroadcasted: boolean,
  scopeID?: string,
) => {
  return shouldRatchetWithPolicy(transactionType, isBroadcasted, scopeID);
};

export const syncCurrentEphemeralWallet = async (
  encryptionKey: string,
  scopeID?: string,
): Promise<
  Optional<{
    walletID: string;
    currentIndex: number;
    currentAddress: string;
  }>
> => {
  const walletID = getCurrentRailgunID();
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  if (!isDefined(walletID) || !isDefined(chain)) {
    return undefined;
  }
  const chainId = BigInt(chain.id);

  const normalizedScopeID = normalizeScopeID(scopeID);

  const manager = getEphemeralKeyManager(walletID, encryptionKey, scopeID);
  await autoSyncEphemeralIndex(manager);

  const currentAccount = await manager.getCurrentAccount(chainId);
  const currentIndex = await fullWalletForID(walletID).getEphemeralKeyIndex(chainId);
  const currentAddress = currentAccount.address;
  cacheEphemeralState(walletID, currentIndex, currentAddress);
  if (isDefined(normalizedScopeID)) {
    updateScopeState(normalizedScopeID, currentIndex, currentAddress, false);
  }

  return {
    walletID,
    currentIndex,
    currentAddress,
  };
};

export const ratchetEphemeralWalletOnSuccess = async (
  transactionType: RailgunTransaction,
  isBroadcasted: boolean,
  encryptionKey?: string,
  scopeID?: string,
) => {
  if (!shouldRatchetForTransaction(transactionType, isBroadcasted, scopeID)) {
    return false;
  }

  if (!isDefined(encryptionKey)) {
    return false;
  }
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  if ( !isDefined(chain)) {
    return undefined;
  }
  const chainId = BigInt(chain.id);

  const synced = await syncCurrentEphemeralWallet(encryptionKey, scopeID);
  if (!isDefined(synced)) {
    return false;
  }

  const manager = getEphemeralKeyManager(synced.walletID, encryptionKey, scopeID);
  const nextAccount = await manager.getNextAccount(chainId);
  const nextIndex = await fullWalletForID(synced.walletID).getEphemeralKeyIndex(chainId);
  cacheEphemeralState(synced.walletID, nextIndex, nextAccount.address);
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (isDefined(normalizedScopeID)) {
    updateScopeState(normalizedScopeID, nextIndex, nextAccount.address, true);
  }

  return true;
};

export const manualRatchetEphemeralWallet = async (
  encryptionKey: string,
  scopeID?: string,
) => {
  const synced = await syncCurrentEphemeralWallet(encryptionKey, scopeID);
  if (!isDefined(synced)) {
    return undefined;
  }
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  if ( !isDefined(chain)) {
    return undefined;
  }
  const chainId = BigInt(chain.id);

  const manager = getEphemeralKeyManager(synced.walletID, encryptionKey, scopeID);
  const nextAccount = await manager.getNextAccount(chainId);
  const nextIndex = await fullWalletForID(synced.walletID).getEphemeralKeyIndex(chainId);
  cacheEphemeralState(synced.walletID, nextIndex, nextAccount.address);
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (isDefined(normalizedScopeID)) {
    updateScopeState(normalizedScopeID, nextIndex, nextAccount.address, true);
  }

  return {
    walletID: synced.walletID,
    currentIndex: nextIndex,
    currentAddress: nextAccount.address,
  };
};

export const setEphemeralWalletIndex = async (
  encryptionKey: string,
  index: number,
  scopeID?: string,
) => {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Ephemeral index must be a non-negative integer.");
  }

  const walletID = getCurrentRailgunID();
  if (!isDefined(walletID)) {
    return undefined;
  }
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  if ( !isDefined(chain)) {
    return undefined;
  }
  const chainId = BigInt(chain.id);

  const railgunWallet = fullWalletForID(walletID);
  await railgunWallet.setEphemeralKeyIndex(chainId, index);

  const manager = getEphemeralKeyManager(walletID, encryptionKey, scopeID);
  const currentAccount = await manager.getCurrentAccount(chainId);
  cacheEphemeralState(walletID, index, currentAccount.address);
  const normalizedScopeID = normalizeScopeID(scopeID);
  if (isDefined(normalizedScopeID)) {
    updateScopeState(normalizedScopeID, index, currentAccount.address, false);
  }

  return {
    walletID,
    currentIndex: index,
    currentAddress: currentAccount.address,
  };
};

export const getCurrentKnownEphemeralState = (walletID = getCurrentRailgunID()) => {
  if (!isDefined(walletID)) {
    return undefined;
  }

  const cache = getEphemeralWalletMap()[walletID];
  if (!isDefined(cache)) {
    return undefined;
  }

  return {
    walletID,
    currentIndex: cache.currentIndex,
    currentAddress: cache.lastKnownAddress,
    knownCount: Object.keys(cache.addressByIndex).length,
    lastUpdated: cache.lastUpdated,
  };
};

export const getKnownEphemeralAddresses = (walletID = getCurrentRailgunID()) => {
  if (!isDefined(walletID)) {
    return [];
  }

  const cache = getEphemeralWalletMap()[walletID];
  if (!isDefined(cache)) {
    return [];
  }

  return Object.entries(cache.addressByIndex)
    .map(([index, address]) => ({
      index: Number(index),
      address,
    }))
    .sort((a, b) => a.index - b.index);
};

export const getKnownEphemeralIndexForAddress = (
  address: string,
  walletID = getCurrentRailgunID(),
) => {
  if (!isDefined(walletID)) {
    return undefined;
  }

  const cache = getEphemeralWalletMap()[walletID];
  if (!isDefined(cache)) {
    return undefined;
  }

  return findKnownIndexForAddress(cache, address);
};
