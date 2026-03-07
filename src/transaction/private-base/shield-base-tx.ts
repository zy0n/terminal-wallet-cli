import {
  NetworkName,
  RailgunERC20AmountRecipient,
  TXIDVersion,
  TransactionGasDetails,
  isDefined,
} from "@railgun-community/shared-models";
import {
  EphemeralKeyManager,
  fullWalletForID,
  gasEstimateForShieldBaseToken,
  getShieldPrivateKeySignatureMessage,
  populateShieldBaseToken,
} from "@railgun-community/wallet";
import { HDNodeWallet, formatUnits, keccak256 } from "ethers";
import { getChainForName, getWrappedTokenInfoForChain } from "../../network/network-util";
import {
  calculateEstimatedGasCost,
  getPublicGasDetails,
} from "../../gas/gas-util";
import { PrivateGasEstimate } from "../../models/transaction-models";
import { getCurrentShieldPrivateKey } from "../../wallet/public-utils";
import { getCurrentNetwork } from "../../engine/engine";

const getShieldSigningContext = async (selfSignerWallet?: HDNodeWallet) => {
  if (!selfSignerWallet) {
    return getCurrentShieldPrivateKey();
  }

  const shieldSignatureMessage = getShieldPrivateKeySignatureMessage();
  const shieldPrivateKey = keccak256(
    await selfSignerWallet.signMessage(shieldSignatureMessage),
  );

  return {
    shieldPrivateKey,
    fromWalletAddress: selfSignerWallet.address,
  };
};

export const getShieldBaseTokenGasDetails = async (
  chainName: NetworkName,
  wrappedERC20Amount: RailgunERC20AmountRecipient,
  railgunWalletID: string,
  encryptionKey: string,
  selfSignerWallet?: HDNodeWallet,
): Promise<PrivateGasEstimate> => {
  const { shieldPrivateKey, fromWalletAddress } =
    await getShieldSigningContext(selfSignerWallet);

  const wrappedInfo = getWrappedTokenInfoForChain(chainName);
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const ephemeralManager = new EphemeralKeyManager(
    fullWalletForID(railgunWalletID),
    encryptionKey,
  );
  const networkName = getCurrentNetwork();
  const chain = getChainForName(networkName);

  const chainId = BigInt(chain.id);
  const ephemeralAccount = await ephemeralManager.getCurrentAccount(chainId);

  const { gasEstimate } = await gasEstimateForShieldBaseToken(
    txIDVersion,
    chainName,
    wrappedERC20Amount.recipientAddress,
    shieldPrivateKey,
    wrappedERC20Amount,
    fromWalletAddress,
    ephemeralAccount
  );
  const gasDetails = (await getPublicGasDetails(
    chainName,
    gasEstimate,
    true,
  )) as TransactionGasDetails;

  const _estimatedCost = calculateEstimatedGasCost(gasDetails);
  const formattedCost = parseFloat(
    formatUnits(_estimatedCost, wrappedInfo.decimals),
  );

  return {
    symbol: wrappedInfo.symbol,
    overallBatchMinGasPrice: 0n,
    estimatedGasDetails: gasDetails,
    estimatedCost: formattedCost,
    broadcasterFeeERC20Recipient: undefined,
  };
};

export const getProvedShieldBaseTokenTransaction = async (
  chainName: NetworkName,
  wrappedERC20Amount: RailgunERC20AmountRecipient,
  privateGasEstimate: PrivateGasEstimate,
  railgunWalletID: string,
  encryptionKey: string,
  selfSignerWallet?: HDNodeWallet,
) => {
  const { shieldPrivateKey, fromWalletAddress } =
    await getShieldSigningContext(selfSignerWallet);
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const ephemeralManager = new EphemeralKeyManager(
    fullWalletForID(railgunWalletID),
    encryptionKey,
  );
    const networkName = getCurrentNetwork();
    const chain = getChainForName(networkName);
    if ( !isDefined(chain)) {
      return undefined;
    }
    const chainId = BigInt(chain.id);
  const ephemeralAccount = await ephemeralManager.getCurrentAccount(chainId);

  const { transaction } = await populateShieldBaseToken(
    txIDVersion,
    chainName,
    wrappedERC20Amount.recipientAddress,
    shieldPrivateKey,
    wrappedERC20Amount,
    privateGasEstimate.estimatedGasDetails,
    ephemeralAccount
  );

  // Public wallet to shield from.
  transaction.from = fromWalletAddress;
  return transaction;
};
