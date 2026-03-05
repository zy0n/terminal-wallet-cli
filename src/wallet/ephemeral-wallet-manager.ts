import { isDefined } from "@railgun-community/shared-models";
import {
  EphemeralKeyManager,
  fullWalletForID,
} from "@railgun-community/wallet";
import { RailgunTransaction } from "../models/transaction-models";
import { EphemeralWalletCache } from "../models/wallet-models";
import configDefaults from "../config/config-defaults";
import { saveKeychainFile } from "./wallet-cache";
import { getCurrentRailgunID } from "./wallet-util";
import { walletManager } from "./wallet-manager";
import { getCurrentNetwork } from "../engine/engine";
import { getChainForName } from "../network/network-util";

const lower = (value: string) => value.toLowerCase();

const getEphemeralWalletMap = () => {
  walletManager.keyChain.ephemeralWallets ??= {};
  return walletManager.keyChain.ephemeralWallets;
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

const getEphemeralKeyManager = (walletID: string, encryptionKey: string) => {
  const railgunWallet = fullWalletForID(walletID);
  return new EphemeralKeyManager(railgunWallet, encryptionKey);
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
  _isBroadcasted: boolean,
) => {
  return transactionType === RailgunTransaction.Private0XSwap;
};

export const syncCurrentEphemeralWallet = async (
  encryptionKey: string,
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

  const manager = getEphemeralKeyManager(walletID, encryptionKey);
  await autoSyncEphemeralIndex(manager);

  const currentAccount = await manager.getCurrentAccount(chainId);
  const currentIndex = await fullWalletForID(walletID).getEphemeralKeyIndex(chainId);
  const currentAddress = currentAccount.address;
  cacheEphemeralState(walletID, currentIndex, currentAddress);

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
) => {
  if (!shouldRatchetForTransaction(transactionType, isBroadcasted)) {
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

  const synced = await syncCurrentEphemeralWallet(encryptionKey);
  if (!isDefined(synced)) {
    return false;
  }

  const manager = getEphemeralKeyManager(synced.walletID, encryptionKey);
  const nextAccount = await manager.getNextAccount(chainId);
  const nextIndex = await fullWalletForID(synced.walletID).getEphemeralKeyIndex(chainId);
  cacheEphemeralState(synced.walletID, nextIndex, nextAccount.address);

  return true;
};

export const manualRatchetEphemeralWallet = async (encryptionKey: string) => {
  const synced = await syncCurrentEphemeralWallet(encryptionKey);
  if (!isDefined(synced)) {
    return undefined;
  }
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);
  if ( !isDefined(chain)) {
    return undefined;
  }
  const chainId = BigInt(chain.id);

  const manager = getEphemeralKeyManager(synced.walletID, encryptionKey);
  const nextAccount = await manager.getNextAccount(chainId);
  const nextIndex = await fullWalletForID(synced.walletID).getEphemeralKeyIndex(chainId);
  cacheEphemeralState(synced.walletID, nextIndex, nextAccount.address);

  return {
    walletID: synced.walletID,
    currentIndex: nextIndex,
    currentAddress: nextAccount.address,
  };
};

export const setEphemeralWalletIndex = async (
  encryptionKey: string,
  index: number,
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

  const manager = getEphemeralKeyManager(walletID, encryptionKey);
  const currentAccount = await manager.getCurrentAccount(chainId);
  cacheEphemeralState(walletID, index, currentAccount.address);

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
