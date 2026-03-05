import { randomBytes } from "crypto";
import { isDefined } from "@railgun-community/shared-models";
import configDefaults from "../config/config-defaults";
import { StealthProfile } from "../models/wallet-models";
import { saveKeychainFile } from "./wallet-cache";
import { walletManager } from "./wallet-manager";

type UpsertStealthProfileInput = {
  id?: string;
  name: string;
  accountAddress?: string;
  scopeID?: string;
  slot?: number;
  signerStrategyScopeID?: string;
};

export type StealthProfileSummary = {
  total: number;
  linked: number;
  scoped: number;
  slotted: number;
  withSignerScope: number;
  activeProfileID?: string;
  activeAccountAddress?: string;
  hasActiveLinkedAddress: boolean;
};

const MAX_NAME_LENGTH = 64;
const MAX_SCOPE_LENGTH = 128;

const persistKeychain = () => {
  const { keyChainPath } = configDefaults.engine;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
};

const getStealthProfileMap = () => {
  walletManager.keyChain.stealthProfiles ??= {};
  return walletManager.keyChain.stealthProfiles;
};

const sanitizeName = (name: string) => {
  const normalized = name.trim();
  if (!normalized.length) {
    throw new Error("Stealth profile name is required.");
  }
  if (normalized.length > MAX_NAME_LENGTH) {
    throw new Error("Stealth profile name is too long.");
  }
  return normalized;
};

const sanitizeScope = (scopeID?: string) => {
  if (!isDefined(scopeID)) {
    return undefined;
  }
  const normalized = scopeID.trim();
  if (!normalized.length) {
    return undefined;
  }
  if (normalized.length > MAX_SCOPE_LENGTH) {
    throw new Error("Scope ID is too long.");
  }
  return normalized;
};

const sanitizeAddress = (address?: string) => {
  if (!isDefined(address)) {
    return undefined;
  }

  const normalized = address.trim().toLowerCase();
  if (!normalized.length) {
    return undefined;
  }

  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("Stealth profile address must be a valid 0x address.");
  }
  return normalized;
};

const sanitizeSlot = (slot?: number) => {
  if (!isDefined(slot)) {
    return undefined;
  }
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error("Stealth profile slot must be a non-negative integer.");
  }
  return slot;
};

const createProfileID = () => {
  return `stl_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
};

export const listStealthProfiles = () => {
  return Object.values(getStealthProfileMap()).sort((left, right) => {
    return right.updatedAt - left.updatedAt;
  });
};

export const getStealthProfile = (id: string) => {
  const normalized = id.trim();
  if (!normalized.length) {
    return undefined;
  }
  return getStealthProfileMap()[normalized];
};

export const getActiveStealthProfile = () => {
  const activeID = walletManager.keyChain.activeStealthProfileID;
  if (!isDefined(activeID)) {
    return undefined;
  }
  return getStealthProfile(activeID);
};

export const setActiveStealthProfile = (id: string) => {
  const profile = getStealthProfile(id);
  if (!isDefined(profile)) {
    throw new Error("Stealth profile not found.");
  }

  profile.lastUsedAt = Date.now();
  profile.updatedAt = Date.now();
  walletManager.keyChain.activeStealthProfileID = profile.id;
  getStealthProfileMap()[profile.id] = profile;
  persistKeychain();
  return profile;
};

export const upsertStealthProfile = (input: UpsertStealthProfileInput) => {
  const map = getStealthProfileMap();
  const now = Date.now();

  const id = isDefined(input.id) && input.id.trim().length
    ? input.id.trim()
    : createProfileID();

  const existing = map[id];
  const nextProfile: StealthProfile = {
    id,
    name: sanitizeName(input.name),
    accountAddress: sanitizeAddress(input.accountAddress),
    scopeID: sanitizeScope(input.scopeID),
    slot: sanitizeSlot(input.slot),
    signerStrategyScopeID: sanitizeScope(input.signerStrategyScopeID),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt,
  };

  map[id] = nextProfile;
  if (!isDefined(walletManager.keyChain.activeStealthProfileID)) {
    walletManager.keyChain.activeStealthProfileID = id;
  }
  persistKeychain();
  return nextProfile;
};

export const removeStealthProfile = (id: string) => {
  const normalized = id.trim();
  if (!normalized.length) {
    return false;
  }

  const map = getStealthProfileMap();
  if (!isDefined(map[normalized])) {
    return false;
  }

  delete map[normalized];

  if (walletManager.keyChain.activeStealthProfileID === normalized) {
    const next = Object.values(map).sort((left, right) => {
      return right.updatedAt - left.updatedAt;
    })[0];
    walletManager.keyChain.activeStealthProfileID = next?.id;
  }

  persistKeychain();
  return true;
};

export const getStealthProfileSummary = (): StealthProfileSummary => {
  const profiles = listStealthProfiles();
  const active = getActiveStealthProfile();

  return {
    total: profiles.length,
    linked: profiles.filter((profile) => isDefined(profile.accountAddress)).length,
    scoped: profiles.filter((profile) => isDefined(profile.scopeID)).length,
    slotted: profiles.filter((profile) => isDefined(profile.slot)).length,
    withSignerScope: profiles.filter((profile) => isDefined(profile.signerStrategyScopeID)).length,
    activeProfileID: active?.id,
    activeAccountAddress: active?.accountAddress,
    hasActiveLinkedAddress: isDefined(active?.accountAddress),
  };
};
