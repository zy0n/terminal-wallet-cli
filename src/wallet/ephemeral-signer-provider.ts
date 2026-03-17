import {
    EphemeralSignerProvider,
    EphemeralWalletDerivationStrategy,
} from "@railgun-community/engine";
import { createHash } from "crypto";

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

    getPathSuffix = (index: number): string => {
        if (!Number.isInteger(index) || index < 0) {
            throw new Error("Ephemeral index must be a non-negative integer.");
        }

        if (this.currentStrategy) {
            return this.currentStrategy(index);
        }

        const scopeComponent = toBip32ScopeComponent(this.currentScope);
        return `${scopeComponent}'/${index}'`;
    };

    getDBPathSuffix = (): string[] => {
        return [this.currentScope];
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