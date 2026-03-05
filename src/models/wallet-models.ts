import { NetworkName } from "@railgun-community/shared-models";
import { BalanceCacheMap } from "./balance-models";
import { TokenDatabaseMap } from "./token-models";

export type RailWallet = {
  id: string;
  name: string;
  index: number;
  mnemonic: string;
  network: NetworkName;
  railgunAddress: string;
  privateERC20BalanceCache: BalanceCacheMap;
  publicERC20BalanceCache: BalanceCacheMap;
  tokenDatabase: TokenDatabaseMap;
};

export type RailWalletFile = {
  iv: Buffer;
  hashedPassword: { type: string; data: any[] };
  wallets: RailWallet[];
};

export type TMPWalletInfo = {
  mnemonic: string;
  walletName: string;
  derivationIndex: number;
};

export type WalletCache = {
  railgunWalletID: string;
  railgunWalletAddress: string;
  derivationIndex: number;
  publicAddress?: string;
};

export type EphemeralWalletCache = {
  currentIndex: number;
  addressByIndex: MapType<string>;
  lastKnownAddress?: string;
  lastUpdated: number;
};

export type EphemeralSessionRatchetBroadcastMode =
  | "any"
  | "broadcasted-only"
  | "self-signed-only";

export type EphemeralSessionRatchetPolicy = {
  enabled: boolean;
  broadcastMode: EphemeralSessionRatchetBroadcastMode;
  ratchetOnTransactions: string[];
};

export type EphemeralSessionScope = {
  scopeID: string;
  policy: EphemeralSessionRatchetPolicy;
  lastKnownAddress?: string;
  lastKnownIndex?: number;
  ratchetCount: number;
  createdAt: number;
  updatedAt: number;
};

export type KnownAddressKey = {
  name: string;
  publicAddress?: string;
  privateAddress?: string;
};


export type CustomProviderMap = NumMapType<NumMapType<MapType<boolean>>>;

export type WalletConnectSessionState = "paired" | "disconnected";

export type WalletConnectSession = {
  topic: string;
  version: number;
  relayProtocol?: string;
  connectedAddress?: string;
  symKeyHash: string;
  scopeID?: string;
  createdAt: number;
  updatedAt: number;
  status: WalletConnectSessionState;
};

export type StealthProfile = {
  id: string;
  name: string;
  accountAddress: string;
  scopeID?: string;
  slot?: number;
  signerStrategyScopeID?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
};

export type KeychainFile = {
  name: string;
  salt: string;
  wallets?: MapType<WalletCache>;
  ephemeralWallets?: MapType<EphemeralWalletCache>;
  ephemeralSessionScopes?: MapType<EphemeralSessionScope>;
  knownAddresses?: KnownAddressKey[];
  currentNetwork?: NetworkName;
  selectedWallet?: string;
  cachedTokenInfo?: TokenDatabaseMap;
  displayPrivate?: boolean;
  responsiveMenu?: boolean;
  hidePrivateInfo?: boolean;
  customProviders?: CustomProviderMap;
  walletConnectSessions?: MapType<WalletConnectSession>;
  stealthProfiles?: MapType<StealthProfile>;
  activeStealthProfileID?: string;
  showSenderAddress?: boolean;
};

export type EncryptedCacheFile = {
  name: string;
  iv: string;
  encryptedData: string;
};
