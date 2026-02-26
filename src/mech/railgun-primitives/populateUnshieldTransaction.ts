import { TransactionRequest } from "ethers";
import {
  calculateBroadcasterFeeERC20Amount,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
} from "@railgun-community/wallet";
import {
  RailgunERC20AmountRecipient,
  RailgunNFTAmountRecipient,
  RailgunPopulateTransactionResponse,
  SelectedBroadcaster,
  TXIDVersion,
} from "@railgun-community/shared-models";

import { getCurrentRailgunID } from "../../wallet/wallet-util";
import { getTransactionGasDetails } from "../../transaction/private/private-tx";
import { getSaltedPassword } from "../../wallet/wallet-password";

import { getOutputGasEstimate } from "../../transaction/private/unshield-tx";

import { getCurrentNetwork } from "../../engine/engine";

/*
 * Goes directly to RailgunSW
 */
export async function populateUnshieldTransaction({
  // Assets to unshield FROM Railgun (these will be available in contract calls)
  unshieldNFTs,
  unshieldERC20s,
  broadcasterSelection, // Optional for broadcasting
}: {
  unshieldNFTs: RailgunNFTAmountRecipient[];
  unshieldERC20s: RailgunERC20AmountRecipient[];
  broadcasterSelection?: SelectedBroadcaster;
}): Promise<any> {
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const networkName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();

  const gasDetailsResult = await getTransactionGasDetails(networkName, broadcasterSelection);
  if (!gasDetailsResult) throw new Error("Failed to get gas details");

  const encryptionKey = await getSaltedPassword();
  if (!encryptionKey) throw new Error("Failed to get encryption key");

  const sendWithPublicWallet = !broadcasterSelection;

  const { gasEstimate } = await gasEstimateForUnprovenUnshield(
    txIDVersion,
    networkName,
    railgunWalletID,
    encryptionKey,
    unshieldERC20s,
    unshieldNFTs,
    gasDetailsResult.originalGasDetails,
    gasDetailsResult.feeTokenDetails,
    sendWithPublicWallet,
  );

  const { estimatedGasDetails, broadcasterFeeERC20Recipient } = await getOutputGasEstimate(
    gasDetailsResult.originalGasDetails,
    gasEstimate,
    gasDetailsResult.feeTokenInfo,
    gasDetailsResult.feeTokenDetails,
    broadcasterSelection,
    gasDetailsResult.overallBatchMinGasPrice,
  );

  await generateUnshieldProof(
    txIDVersion,
    networkName,
    railgunWalletID,
    encryptionKey,
    unshieldERC20s,
    unshieldNFTs,
    broadcasterFeeERC20Recipient,
    sendWithPublicWallet,
    gasDetailsResult.overallBatchMinGasPrice,
    () => console.log(`Proof generation in progress...`),
  );

  const provedTransaction = await populateProvedUnshield(
    txIDVersion,
    networkName,
    railgunWalletID,
    unshieldERC20s,
    unshieldNFTs,
    broadcasterFeeERC20Recipient,
    sendWithPublicWallet,
    gasDetailsResult.overallBatchMinGasPrice,
    estimatedGasDetails,
  );

  return provedTransaction;
}
