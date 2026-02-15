
import { NetworkName, RailgunERC20Amount, RailgunERC20Recipient, RailgunPopulateTransactionResponse, SelectedBroadcaster, TXIDVersion, isDefined, type RailgunERC20AmountRecipient, type RailgunNFTAmount, type RailgunNFTAmountRecipient } from "@railgun-community/shared-models";
import {
  gasEstimateForUnprovenCrossContractCalls,
  generateCrossContractCallsProof,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import { ContractTransaction } from "ethers";
import { getCurrentNetwork } from "../../engine/engine";
import {
  PrivateGasDetails,
  PrivateGasEstimate,
} from "../../models/transaction-models";
import { WalletCache } from "../../models/wallet-models";
import { ProgressBar } from "../../ui/progressBar-ui";
import { getSaltedPassword } from "../../wallet/wallet-password";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { getTransactionGasDetails } from "../../transaction/private/private-tx";
import { getOutputGasEstimate } from "../../transaction/private/unshield-tx";
import { getERC20AmountRecipients, getSelfSignerWalletPrompt, sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { runFeeTokenSelector } from "../../ui/token-ui";


export type HookedCrossContractInputs = {
  relayAdaptUnshieldERC20Amounts: RailgunERC20Amount[],
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[],
  relayAdaptShieldNFTAddresses: RailgunNFTAmountRecipient[],
  relayAdaptUnshieldNFTAmounts: RailgunNFTAmount[],
}

// TODO: need to set rpc to use local forked hook for ethereum network
// may need to disable waku?



// need to send in the approval transaction for the ERC20 token
// need to send in the swap transaction for the ERC20 token

// need to send the unshield amounts based on swap sell token amount and address
// need to send the shield addresses based on swap buy token address and recipeint address (current railgun address)

const hookedGasEstimateForUnprovenCrossContractCalls = async (
  chainName: NetworkName,
  crossContractCalls: ContractTransaction[],
  crossContractInputs: HookedCrossContractInputs,
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster, // should be undefined for now, this will allow for self-signed testing
): Promise<PrivateGasEstimate | null | undefined> => {
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const railgunWalletID = getCurrentRailgunID();

  const crossContractGasDetails = await getTransactionGasDetails(
    chainName,
    broadcasterSelection
  );

  if (!crossContractGasDetails) {
    console.log("Failed to get Gas Details for Transaction");
    return undefined;
  }
  const {
    originalGasDetails,
    feeTokenDetails,
    feeTokenInfo,
    sendWithPublicWallet,
    overallBatchMinGasPrice,
  } = crossContractGasDetails as PrivateGasDetails;


  const { relayAdaptUnshieldERC20Amounts, relayAdaptShieldERC20Addresses, relayAdaptShieldNFTAddresses, relayAdaptUnshieldNFTAmounts } = crossContractInputs;

  const minGasLimit = 5_000_000n; // TODO fix hardcoded


  const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls(
    txIDVersion,
    chainName,
    railgunWalletID,
    encryptionKey,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptUnshieldNFTAmounts,
    relayAdaptShieldERC20Addresses,
    relayAdaptShieldNFTAddresses,
    crossContractCalls,
    originalGasDetails,
    feeTokenDetails,
    sendWithPublicWallet,
    minGasLimit, // minGasLimit
  );

  return await getOutputGasEstimate(
    originalGasDetails,
    gasEstimate,
    feeTokenInfo,
    feeTokenDetails,
    broadcasterSelection,
    overallBatchMinGasPrice,
  );
}

export const hookedProvedCrossContractTransaction = async (
  encryptionKey: string,
  privateGasEstimate: PrivateGasEstimate,
  crossContractCalls: ContractTransaction[],
  crossContractInputs: HookedCrossContractInputs,
  sendWithPublicWallet = false
): Promise<Optional<RailgunPopulateTransactionResponse>> => {
  const chainName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const progressBar = new ProgressBar("Starting Proof Generation");
  const progressCallback = (progress: number, progressStats: string) => {
    if (isDefined(progressStats)) {
      progressBar.updateProgress(
        `Transaction Proof Generation | [${progressStats}]`,
        progress,
      );
    } else {
      progressBar.updateProgress(`Transaction Proof Generation`, progress);
    }
  };

  const { relayAdaptUnshieldERC20Amounts, relayAdaptShieldERC20Addresses, relayAdaptShieldNFTAddresses, relayAdaptUnshieldNFTAmounts } = crossContractInputs;

  const {
    broadcasterFeeERC20Recipient,
    overallBatchMinGasPrice,
    estimatedGasDetails,
  } = privateGasEstimate as PrivateGasEstimate;

  const minGasLimit = 5_000_000n; // TODO fix hardcoded

  try {
    await generateCrossContractCallsProof(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      relayAdaptUnshieldERC20Amounts,
      relayAdaptUnshieldNFTAmounts,
      relayAdaptShieldERC20Addresses,
      relayAdaptShieldNFTAddresses,
      crossContractCalls,
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      minGasLimit, // minGasLimit,
      progressCallback,
    )
      .catch((err) => {
        console.log("We errored out");
      })
      .finally(() => {
        progressBar.complete();
      });

    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedCrossContractCalls(
        txIDVersion,
        chainName,
        railgunWalletID,
        relayAdaptUnshieldERC20Amounts,
        relayAdaptUnshieldNFTAmounts,
        relayAdaptShieldERC20Addresses,
        relayAdaptShieldNFTAddresses,
        crossContractCalls,
        broadcasterFeeERC20Recipient,
        sendWithPublicWallet,
        overallBatchMinGasPrice,
        estimatedGasDetails,
      );

    return { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList };
  } catch (err) {
    const error = err as Error;
    console.log(error.message);
  }
};

export const pickBestBroadcaster = async ()=>{
  const amountRecipients: RailgunERC20AmountRecipient[] = [];
  let broadcasterSelection: any;
  let _selfSignerInfo;
  const _broadcasterSelection = await runFeeTokenSelector(
    getCurrentNetwork(),
    amountRecipients,
    // broadcasterSelection,
  ).catch((err) => {
    console.log(err.message);
    console.log(err.message);
    throw new Error(err.message);
  });
  const _bestBroadcaster = _broadcasterSelection?.bestBroadcaster;
  if (!_bestBroadcaster) {
    _selfSignerInfo = await getSelfSignerWalletPrompt();
  }
  return {
    broadcasterSelection: _bestBroadcaster,
    selfSignerInfo: _selfSignerInfo
  }
}


export const generateHookedCall = async (
  // fill out inputs to match from rpc-call 
  chainName: NetworkName,
  crossContractCalls: ContractTransaction[],
  crossContractInputs: HookedCrossContractInputs,
  selectedBroadcasterInfo: {broadcasterSelection: SelectedBroadcaster | undefined, selfSignerInfo: WalletCache | undefined}
): Promise<RailgunPopulateTransactionResponse | undefined> => {
  // const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  // const railgunWalletID = getCurrentRailgunID();
  // clear console to view logs while this is running
  // also disable menu refresh

  // get gas estimate for unproven cross contract calls
  // get proved transaction for the contract calls
  // self-sign tx to testnet

  // await clearConsoleBuffer()
  console.log("Sending Hooked Call to Testnet");

  // need to change getSaltedPassword to not clear the password
  // so initial launch keeps password in memory for testing purposes
  const encryptionKey = await getSaltedPassword();
  if (!encryptionKey) {
    console.log("Failed to get Encryption Key for Transaction");
    return;
  }

  // get broadcaster info here.

  const { broadcasterSelection:selectedBroadcaster, selfSignerInfo } = selectedBroadcasterInfo;

  const hookedGasEstimate =
    await hookedGasEstimateForUnprovenCrossContractCalls(
      getCurrentNetwork(),
      crossContractCalls, // crossContractCalls
      crossContractInputs, // crossContractInputs
      encryptionKey, // encryptionKey
      selectedBroadcaster, // broadcasterSelection
    );

  if (!hookedGasEstimate) {
    console.log("Failed to get Gas Estimate for Transaction");
    return;
  }

  console.log("Hooked Gas Estimate", hookedGasEstimate);
  const hookedProvedTransaction = await hookedProvedCrossContractTransaction(
    encryptionKey, // encryptionKey
    hookedGasEstimate, // privateGasEstimate
    crossContractCalls, // crossContractCalls
    crossContractInputs, // crossContractInputs
  );

  if (!hookedProvedTransaction) {
    console.log("Failed to get Proved Transaction for Transaction");
    return;
  }
  console.log("Hooked Proved Transaction", hookedProvedTransaction);

  // self-sign transaction
  return hookedProvedTransaction;


  // const selfSignerInfo: WalletCache = {
  //   railgunWalletID: getCurrentRailgunID(),
  //   railgunWalletAddress: getCurrentRailgunAddress(),
  //   derivationIndex: 0,
  // };
  // console.log("Self Signer Info", selfSignerInfo);
  // // send transaction to testnet
  // const sendResult = await sendSelfSignedTransaction(
  //   selfSignerInfo,
  //   chainName,
  //   hookedProvedTransaction,
  // );
  // console.log("Send Result", sendResult?.hash);

  // if (sendResult) {
  //   console.log("Transaction Sent");
  // } else {
  //   console.log("Failed to Send Transaction");
  // }
  // console.log(sendResult);
  // return sendResult?.hash;
}