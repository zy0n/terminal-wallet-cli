import { EphemeralSignerProvider, EphemeralWalletDBPathStrategy, EphemeralWalletDerivationStrategy } from "@railgun-community/engine";
import { HDNodeWallet } from "ethers";

class StealthSignerProvider implements EphemeralSignerProvider {
    currentScope: string = '0';
    deriveWallet  = (
        mnemonic: string,
        chainId: bigint,
        index: number,
    ): HDNodeWallet => {
        const path = `m/44'/60'/0'/7702'/${chainId}'/${this.currentScope}'/${index}'`;
        return HDNodeWallet.fromPhrase(mnemonic, undefined, path);
    }

    getDBPath = (id: string, chainId: bigint): string[] => {
        return [id, chainId.toString(10), this.currentScope];
    }

}