import {
    EphemeralSignerProvider,
    EphemeralWalletDerivationStrategy,
} from "@railgun-community/engine";
import { HDNodeWallet } from "ethers";

const DEFAULT_SCOPE = "0";
const MAX_SCOPE_ID_LENGTH = 128;

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

class StealthSignerProvider implements EphemeralSignerProvider {
    currentScope: string = DEFAULT_SCOPE;

    setCurrentScope = (scopeID?: string): string => {
        this.currentScope = normalizeStealthSignerScope(scopeID);
        return this.currentScope;
    };

    getCurrentScope = (): string => {
        return this.currentScope;
    };

    getDerivationPath = (chainId: bigint, index: number): string => {
        if (!Number.isInteger(index) || index < 0) {
            throw new Error("Ephemeral index must be a non-negative integer.");
        }

        return `m/44'/60'/0'/7702'/${chainId}'/${this.currentScope}'/${index}'`;
    };

    deriveWallet = (
        mnemonic: string,
        chainId: bigint,
        index: number,
    ): HDNodeWallet => {
        const path = this.getDerivationPath(chainId, index);
        return HDNodeWallet.fromPhrase(mnemonic, undefined, path);
    };

    getDBPath = (id: string, chainId: bigint): string[] => {
        return [id, chainId.toString(10), this.currentScope];
    };

    withDerivationStrategy = (
        strategy: EphemeralWalletDerivationStrategy,
    ): EphemeralSignerProvider => {
        return {
            deriveWallet: strategy,
            getDBPath: this.getDBPath,
        };
    };
}

export const stealthSignerProvider = new StealthSignerProvider();

export { StealthSignerProvider };