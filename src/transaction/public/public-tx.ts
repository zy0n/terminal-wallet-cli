import {
  NetworkName,
  RailgunERC20AmountRecipient,
  TransactionGasDetails,
  isDefined,
} from "@railgun-community/shared-models";
import {
  Contract,
  ContractTransaction,
  TransactionReceipt,
  TransactionResponse,
  formatUnits,
  JsonRpcProvider
} from "ethers";
import { ERC20_ABI } from "../../abi";
import { delay, promiseTimeout, throwError } from "../../util/util";
import {
  calculatePublicGasFee,
  getPublicGasDetails,
  getPublicGasEstimate,
} from "../../gas/gas-util";
import {
  getProviderForChain,
  getWrappedTokenInfoForChain,
} from "../../network/network-util";
import { getCurrentWalletPublicAddress } from "../../wallet/wallet-util";
import { PrivateGasEstimate } from "../../models/transaction-models";

export const populatePublicERC20Transaction = async (
  erc20AmountRecipient: RailgunERC20AmountRecipient,
) => {
  const { tokenAddress, recipientAddress, amount } = erc20AmountRecipient;
  const contract = new Contract(tokenAddress, ERC20_ABI);
  const transaction: ContractTransaction = await contract.transfer
    .populateTransaction(recipientAddress, amount)
    .catch(throwError);
  return transaction;
};

export type PublicTransactionDetails = {
  privateGasEstimate: PrivateGasEstimate;
  populatedTransaction: ContractTransaction;
};

// need to make sure transaction.from has been set.
export const calculatePublicTransactionGasDetais = async (
  chainName: NetworkName,
  transaction: ContractTransaction,
): Promise<PublicTransactionDetails> => {
  if (!transaction.from) {
    throw new Error("Missing Sender for gas Estimate.");
  }
  const gasEstimate = await getPublicGasEstimate(chainName, transaction);
  const gasDetails = await getPublicGasDetails(chainName, gasEstimate);
  const finalTransaction = { ...transaction, ...gasDetails };
  const gasCostEstimate = await calculatePublicGasFee(finalTransaction);
  const { symbol, decimals } = getWrappedTokenInfoForChain(chainName);
  const formattedCost = parseFloat(formatUnits(gasCostEstimate, decimals));
  return {
    privateGasEstimate: {
      symbol,
      overallBatchMinGasPrice: 0n,
      estimatedGasDetails: gasDetails as TransactionGasDetails,
      estimatedCost: formattedCost,
      broadcasterFeeERC20Recipient: undefined,
    },
    populatedTransaction: finalTransaction,
  };
};

export const populateAndCalculateGasForERC20Transaction = async (
  chainName: NetworkName,
  erc20AmountRecipient: RailgunERC20AmountRecipient,
): Promise<PublicTransactionDetails> => {
  const transaction = await populatePublicERC20Transaction(
    erc20AmountRecipient,
  );
  const fromAddress = getCurrentWalletPublicAddress();
  transaction.from = fromAddress;

  const { privateGasEstimate, populatedTransaction } =
    await calculatePublicTransactionGasDetais(chainName, transaction);

  return { privateGasEstimate, populatedTransaction };
};

export const waitOnTx = async (
  txResponse: TransactionResponse,
  txTimeout: number,
) => {
  const receipt = await promiseTimeout(txResponse.wait(), txTimeout);
  return receipt as Optional<TransactionReceipt>;
};

export const waitForTx = async (
  txResponse: TransactionResponse,
  txTimeout = 3 * 60 * 1000,
) => {
  try {
    const receipt = await waitOnTx(txResponse, txTimeout);
    return isDefined(receipt) && receipt.status === 1;
  } catch (err: Error | any) {
    console.log(`Transaction ${txResponse.hash} error: ${err.message}`);
    return false;
  }
};

export const waitForRelayedTx = async (
  chainName: NetworkName,
  txHash: string,
  txTimeout = 3 * 60 * 1000,
) => {
  const provider = getProviderForChain(chainName) as unknown as JsonRpcProvider;
  const startedAt = Date.now();
  const pollIntervalMs = 4_000;

  try {
    while (Date.now() - startedAt < txTimeout) {
      const receipt = await provider.getTransactionReceipt(txHash).catch(() => undefined);
      if (isDefined(receipt)) {
        return receipt.status === 1;
      }

      await delay(pollIntervalMs);
    }

    return false;
  } catch (err: Error | any) {
    console.log(`Transaction ${txHash} error: ${err.message}`);
    return false;
  }
};
