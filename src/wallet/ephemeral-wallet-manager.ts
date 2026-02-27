import { isDefined } from "@railgun-community/shared-models";
import {
  getCurrentEphemeralAddress,
  ratchetEphemeralAddress,
} from "@railgun-community/wallet";
import { RailgunTransaction } from "../models/transaction-models";
import { EphemeralWalletCache } from "../models/wallet-models";
import configDefaults from "../config/config-defaults";
import { saveKeychainFile } from "./wallet-cache";
import { getCurrentRailgunID } from "./wallet-util";
import { walletManager } from "./wallet-manager";

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

const getHighestKnownIndex = (cache: EphemeralWalletCache) => {
  return Object.keys(cache.addressByIndex)
    .map((key) => Number(key))
    .filter((index) => Number.isInteger(index) && index >= 0)
    .reduce((highest, index) => Math.max(highest, index), -1);
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
) => {
  if (transactionType === RailgunTransaction.Private0XSwap) {
    return true;
  }

  if (transactionType === RailgunTransaction.UnshieldBase && isBroadcasted) {
    return true;
  }

  return false;
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
  if (!isDefined(walletID)) {
    return undefined;
  }

  const currentAddress = await getCurrentEphemeralAddress(walletID, encryptionKey);
  const cache = getOrCreateWalletCache(walletID);

  const knownIndex = findKnownIndexForAddress(cache, currentAddress);
  if (isDefined(knownIndex)) {
    cache.currentIndex = knownIndex;
  } else if (isDefined(cache.addressByIndex[cache.currentIndex])) {
    cache.currentIndex = getHighestKnownIndex(cache) + 1;
  }

  cache.addressByIndex[cache.currentIndex] = currentAddress;
  cache.lastKnownAddress = currentAddress;
  cache.lastUpdated = Date.now();
  persistKeychain();

  return {
    walletID,
    currentIndex: cache.currentIndex,
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

  const synced = await syncCurrentEphemeralWallet(encryptionKey);
  if (!isDefined(synced)) {
    return false;
  }

  await ratchetEphemeralAddress(synced.walletID);
  const nextAddress = await getCurrentEphemeralAddress(
    synced.walletID,
    encryptionKey,
  );

  const cache = getOrCreateWalletCache(synced.walletID);
  cache.currentIndex = synced.currentIndex + 1;
  cache.addressByIndex[cache.currentIndex] = nextAddress;
  cache.lastKnownAddress = nextAddress;
  cache.lastUpdated = Date.now();
  persistKeychain();

  return true;
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
