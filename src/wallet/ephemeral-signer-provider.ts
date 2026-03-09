import {
    EphemeralSignerProvider,
    EphemeralWalletDerivationStrategy,
} from "@railgun-community/engine";
import { createHash } from "crypto";
import { HDNodeWallet } from "ethers";

const DEFAULT_SCOPE = "0";
const MAX_SCOPE_ID_LENGTH = 128;
const MAX_BIP32_HARDENED_INDEX = 0x7fffffff;
const SLOT_SCOPE_REGEX = /^slot-(\d+)$/;

export const normalizeStealthSignerScope = (scopeID?: string): string => {
    if (typeof scopeID !== "string") {
        return DEFAULT_SCOPE;
    }

    const normalized = scopeID.trim();
    if (!normalized.length) {
        return DEFAULT_SCOPE;
    }
    if (normalized.length > MAX_SCOPE_ID_LENGTH) {
        throw new Error("Ephemeral scope ID is too long.");
    }

    return normalized;
};

const toBip32ScopeComponent = (scopeID?: string): string => {
    const normalized = normalizeStealthSignerScope(scopeID);

    if (/^\d+$/.test(normalized)) {
        const parsed = Number(normalized);
        if (!Number.isSafeInteger(parsed) || parsed > MAX_BIP32_HARDENED_INDEX) {
            throw new Error("Ephemeral numeric scope exceeds BIP32 hardened index range.");
        }
        return normalized;
    }

    const slotMatch = normalized.match(SLOT_SCOPE_REGEX);
    if (slotMatch) {
        const parsed = Number(slotMatch[1]);
        if (!Number.isSafeInteger(parsed) || parsed > MAX_BIP32_HARDENED_INDEX) {
            throw new Error("Ephemeral slot scope exceeds BIP32 hardened index range.");
        }
        return parsed.toString(10);
    }

    const digest = createHash("sha256").update(normalized, "utf8").digest();
    const scopedIndex = digest.readUInt32BE(0) & MAX_BIP32_HARDENED_INDEX;
    return scopedIndex.toString(10);
};

class StealthSignerProvider implements EphemeralSignerProvider {
    currentScope: string = DEFAULT_SCOPE;
    currentStrategy?: EphemeralWalletDerivationStrategy;

    setCurrentScope = (scopeID?: string): string => {
        this.currentScope = normalizeStealthSignerScope(scopeID);
        return this.currentScope;
    };

    setCurrentStrategy = (
        strategy?: EphemeralWalletDerivationStrategy,
    ): EphemeralWalletDerivationStrategy | undefined => {
        this.currentStrategy = strategy;
        return this.currentStrategy;
    };

    configure = (
        scopeID?: string,
        strategy?: EphemeralWalletDerivationStrategy,
    ): StealthSignerProvider => {
        this.setCurrentScope(scopeID);
        this.setCurrentStrategy(strategy);
        return this;
    };

    getCurrentScope = (): string => {
        return this.currentScope;
    };

    getDerivationPath = (chainId: bigint, index: number): string => {
        if (!Number.isInteger(index) || index < 0) {
            throw new Error("Ephemeral index must be a non-negative integer.");
        }

        const scopeComponent = toBip32ScopeComponent(this.currentScope);

        return `m/44'/60'/0'/7702'/${chainId}'/${scopeComponent}'/${index}'`;
    };

    deriveWallet = (
        mnemonic: string,
        chainId: bigint,
        index: number,
    ): HDNodeWallet => {
        if (this.currentStrategy) {
            return this.currentStrategy(mnemonic, chainId, index);
        }

        const path = this.getDerivationPath(chainId, index);
        return HDNodeWallet.fromPhrase(mnemonic, undefined, path);
    };

    getDBPath = (id: string, chainId: bigint): string[] => {
        return [id, chainId.toString(10), this.currentScope];
    };

}

export const stealthSignerProvider = new StealthSignerProvider();

export const configureStealthSignerProvider = (
    scopeID?: string,
    strategy?: EphemeralWalletDerivationStrategy,
): EphemeralSignerProvider => {
    return stealthSignerProvider.configure(scopeID, strategy);
};

export const createScopedStealthSignerProvider = (
    strategy: EphemeralWalletDerivationStrategy,
    scopeID?: string,
): EphemeralSignerProvider => {
    return configureStealthSignerProvider(scopeID, strategy);
};

export { StealthSignerProvider };