import {
  NetworkName,
  RailgunERC20AmountRecipient,
  TXIDVersion,
  TransactionGasDetails,
} from "@railgun-community/shared-models";
import {
  getShieldPrivateKeySignatureMessage,
  gasEstimateForShield,
  populateShield,
} from "@railgun-community/wallet";
import { HDNodeWallet, formatUnits, keccak256 } from "ethers";
import {
  calculateEstimatedGasCost,
  getPublicGasDetails,
} from "../../gas/gas-util";
import {
  getCurrentShieldPrivateKey,
} from "../../wallet/public-utils";
import { PrivateGasEstimate } from "../../models/transaction-models";
import { getWrappedTokenInfoForChain } from "../../network/network-util";

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

export const getShieldERC20TransactionGasDetails = async (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  selfSignerWallet?: HDNodeWallet,
): Promise<PrivateGasEstimate> => {
  const { shieldPrivateKey, fromWalletAddress } =
    await getShieldSigningContext(selfSignerWallet);
  const wrappedInfo = getWrappedTokenInfoForChain(chainName);
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const { gasEstimate } = await gasEstimateForShield(
    txIDVersion,
    chainName,
    shieldPrivateKey,
    erc20AmountRecipients,
    [], // nftAmountRecipients
    fromWalletAddress,
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

export const getProvedShieldERC20Transaction = async (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  privateGasEstimate: PrivateGasEstimate,
  selfSignerWallet?: HDNodeWallet,
) => {
  const { shieldPrivateKey, fromWalletAddress } =
    await getShieldSigningContext(selfSignerWallet);
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const { transaction } = await populateShield(
    txIDVersion,
    chainName,
    shieldPrivateKey,
    erc20AmountRecipients,
    [], // nftAmountRecipients
    privateGasEstimate.estimatedGasDetails,
  );

  // Public wallet to shield from.
  transaction.from = fromWalletAddress;
  return transaction;
};
