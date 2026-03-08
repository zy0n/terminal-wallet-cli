import {
  EVMGasType,
  NetworkName,
  RailgunERC20Amount,
  RailgunERC20AmountRecipient,
  RailgunERC20Recipient,
  RailgunNFTAmount,
  RailgunNFTAmountRecipient,
  RailgunPopulateTransactionResponse,
  SelectedBroadcaster,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import {
  gasEstimateForUnprovenCrossContractCalls7702,
  generateCrossContractCallsProof7702,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import { ContractTransaction, Interface } from "ethers";
import { ProgressBar } from "../../ui/progressBar-ui";
import {
  PrivateGasDetails,
  PrivateGasEstimate,
} from "../../models/transaction-models";
import { getCurrentRailgunID } from "../../wallet/wallet-util";
import { getCurrentNetwork } from "../../engine/engine";
import { getTransactionGasDetails } from "./private-tx";
import { getOutputGasEstimate } from "./unshield-tx";
import { WalletConnectBundledCall } from "../../models/wallet-models";
import { ERC20_ABI } from "../../abi";
import {
  getRailgunProxyAddressForChain,
  getWrappedTokenInfoForChain,
} from "../../network/network-util";

const DEFAULT_MIN_GAS_LIMIT_7702 = 5_000_000n;
const WRAPPED_BASE_TOKEN_ABI = ["function deposit() payable"];
const ERC20_BALANCE_OF_ABI = ["function balanceOf(address owner) view returns (uint256)"];

const toCrossContractCall = (
  bundledCall: WalletConnectBundledCall,
): ContractTransaction => {
  if (bundledCall.operation !== 0) {
    throw new Error("wallet_sendCalls operation=1 is not supported for 7702 relay-adapt.");
  }

  const to = bundledCall.to?.trim();
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new Error("Invalid bundled call recipient address.");
  }

  const data = bundledCall.data?.trim();
  if (!data || !/^0x[0-9a-fA-F]*$/.test(data)) {
    throw new Error("Invalid bundled call data field.");
  }

  const valueHex = bundledCall.value?.trim() || "0x0";
  const value = /^0x[0-9a-fA-F]+$/.test(valueHex)
    ? BigInt(valueHex)
    : BigInt(valueHex || "0");

  return {
    to,
    data,
    value,
  } as ContractTransaction;
};

export const getCrossContractCallsFromBundledCalls = (
  bundledCalls: WalletConnectBundledCall[],
): ContractTransaction[] => {
  if (!bundledCalls.length) {
    throw new Error("No bundled calls found for cross-contract 7702 transaction.");
  }

  return bundledCalls.map(toCrossContractCall);
};

const getCrossContract7702GasEstimateForCalls = async (
  chainName: NetworkName,
  crossContractCalls: ContractTransaction[],
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
  relayAdaptUnshieldERC20Amounts: RailgunERC20Amount[] = [],
  relayAdaptUnshieldNFTAmounts: RailgunNFTAmount[] = [],
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] = [],
  relayAdaptShieldNFTAddresses: RailgunNFTAmountRecipient[] = [],
  minGasLimit: bigint = DEFAULT_MIN_GAS_LIMIT_7702,
): Promise<PrivateGasEstimate | undefined> => {
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const gasDetailsResult = await getTransactionGasDetails(
    chainName,
    broadcasterSelection,
  );

  if (!gasDetailsResult) {
    console.log("Failed to get gas details for cross-contract 7702 transaction.");
    return undefined;
  }
  const {
    originalGasDetails,
    feeTokenDetails,
    feeTokenInfo,
    sendWithPublicWallet,
    overallBatchMinGasPrice,
  } = gasDetailsResult as PrivateGasDetails;

  const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls7702(
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
    minGasLimit,
  );

  return getOutputGasEstimate(
    originalGasDetails,
    gasEstimate,
    feeTokenInfo,
    feeTokenDetails,
    broadcasterSelection,
    overallBatchMinGasPrice ?? 0n,
  );
};

const getProvedCrossContract7702TransactionForCalls = async (
  encryptionKey: string,
  crossContractCalls: ContractTransaction[],
  privateGasEstimate: PrivateGasEstimate,
  relayAdaptUnshieldERC20Amounts: RailgunERC20Amount[] = [],
  relayAdaptUnshieldNFTAmounts: RailgunNFTAmount[] = [],
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] = [],
  relayAdaptShieldNFTAddresses: RailgunNFTAmountRecipient[] = [],
  minGasLimit: bigint = DEFAULT_MIN_GAS_LIMIT_7702,
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
      progressBar.updateProgress("Transaction Proof Generation", progress);
    }
  };

  const {
    broadcasterFeeERC20Recipient,
    estimatedGasDetails,
  } = privateGasEstimate;

  const sendWithPublicWallet =
    typeof broadcasterFeeERC20Recipient !== "undefined" ? false : true;

  try {
    await generateCrossContractCallsProof7702(
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
      0n,
      minGasLimit,
      progressCallback,
    )
      .catch(() => {
        console.log("Error generating 7702 cross-contract proof.");
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
        0n,
        estimatedGasDetails,
      );

    transaction.type = EVMGasType.Type4;
    return { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList };
  } catch (error) {
    console.log(
      "ERROR getting proved 7702 cross-contract transaction.",
      (error as Error).message,
    );
    return undefined;
  }
};

export const getCrossContract7702GasEstimate = async (
  chainName: NetworkName,
  bundledCalls: WalletConnectBundledCall[],
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
  relayAdaptUnshieldERC20Amounts: RailgunERC20Amount[] = [],
  relayAdaptUnshieldNFTAmounts: RailgunNFTAmount[] = [],
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] = [],
  relayAdaptShieldNFTAddresses: RailgunNFTAmountRecipient[] = [],
  minGasLimit: bigint = DEFAULT_MIN_GAS_LIMIT_7702,
): Promise<PrivateGasEstimate | undefined> => {
  const crossContractCalls = getCrossContractCallsFromBundledCalls(bundledCalls);
  return getCrossContract7702GasEstimateForCalls(
    chainName,
    crossContractCalls,
    encryptionKey,
    broadcasterSelection,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptUnshieldNFTAmounts,
    relayAdaptShieldERC20Addresses,
    relayAdaptShieldNFTAddresses,
    minGasLimit,
  );
};

export const getProvedCrossContract7702Transaction = async (
  encryptionKey: string,
  bundledCalls: WalletConnectBundledCall[],
  privateGasEstimate: PrivateGasEstimate,
  relayAdaptUnshieldERC20Amounts: RailgunERC20Amount[] = [],
  relayAdaptUnshieldNFTAmounts: RailgunNFTAmount[] = [],
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] = [],
  relayAdaptShieldNFTAddresses: RailgunNFTAmountRecipient[] = [],
  minGasLimit: bigint = DEFAULT_MIN_GAS_LIMIT_7702,
): Promise<Optional<RailgunPopulateTransactionResponse>> => {
  const crossContractCalls = getCrossContractCallsFromBundledCalls(bundledCalls);
  return getProvedCrossContract7702TransactionForCalls(
    encryptionKey,
    crossContractCalls,
    privateGasEstimate,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptUnshieldNFTAmounts,
    relayAdaptShieldERC20Addresses,
    relayAdaptShieldNFTAddresses,
    minGasLimit,
  );
};

const getShieldERC20ApproveCalls = (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
): ContractTransaction[] => {
  const railgunProxyAddress = getRailgunProxyAddressForChain(chainName);
  const erc20Interface = new Interface(ERC20_ABI);

  return erc20AmountRecipients.map(({ tokenAddress, amount }) => ({
    to: tokenAddress,
    data: erc20Interface.encodeFunctionData("approve", [
      railgunProxyAddress,
      amount,
    ]),
    value: 0n,
  }));
};

const getUnshieldERC20NoopCalls = (
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
): ContractTransaction[] => {
  const erc20Interface = new Interface(ERC20_BALANCE_OF_ABI);

  return erc20AmountRecipients.map(({ tokenAddress, recipientAddress }) => ({
    to: tokenAddress,
    data: erc20Interface.encodeFunctionData("balanceOf", [recipientAddress]),
    value: 0n,
  }));
};

const getRelayAdaptUnshieldERC20Amounts = (
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
): RailgunERC20Amount[] => {
  return erc20AmountRecipients.map(({ tokenAddress, amount }) => ({
    tokenAddress,
    amount,
  }));
};

export const getUnshieldERC20CrossContract7702GasEstimate = async (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasEstimate | undefined> => {
  const crossContractCalls = getUnshieldERC20NoopCalls(erc20AmountRecipients);
  const relayAdaptUnshieldERC20Amounts = getRelayAdaptUnshieldERC20Amounts(
    erc20AmountRecipients,
  );

  return getCrossContract7702GasEstimateForCalls(
    chainName,
    crossContractCalls,
    encryptionKey,
    broadcasterSelection,
    relayAdaptUnshieldERC20Amounts,
  );
};

export const getProvedUnshieldERC20CrossContract7702Transaction = async (
  encryptionKey: string,
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  privateGasEstimate: PrivateGasEstimate,
): Promise<Optional<RailgunPopulateTransactionResponse>> => {
  const crossContractCalls = getUnshieldERC20NoopCalls(erc20AmountRecipients);
  const relayAdaptUnshieldERC20Amounts = getRelayAdaptUnshieldERC20Amounts(
    erc20AmountRecipients,
  );

  return getProvedCrossContract7702TransactionForCalls(
    encryptionKey,
    crossContractCalls,
    privateGasEstimate,
    relayAdaptUnshieldERC20Amounts,
  );
};

export const getShieldERC20CrossContract7702GasEstimate = async (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasEstimate | undefined> => {
  const crossContractCalls = getShieldERC20ApproveCalls(
    chainName,
    erc20AmountRecipients,
  );
  const relayAdaptShieldERC20Addresses = erc20AmountRecipients.map(
    ({ tokenAddress, recipientAddress }) => ({
      tokenAddress,
      recipientAddress,
    }),
  );

  return getCrossContract7702GasEstimateForCalls(
    chainName,
    crossContractCalls,
    encryptionKey,
    broadcasterSelection,
    [],
    [],
    relayAdaptShieldERC20Addresses,
  );
};

export const getProvedShieldERC20CrossContract7702Transaction = async (
  encryptionKey: string,
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  privateGasEstimate: PrivateGasEstimate,
): Promise<Optional<RailgunPopulateTransactionResponse>> => {
  const crossContractCalls = getShieldERC20ApproveCalls(
    chainName,
    erc20AmountRecipients,
  );
  const relayAdaptShieldERC20Addresses = erc20AmountRecipients.map(
    ({ tokenAddress, recipientAddress }) => ({
      tokenAddress,
      recipientAddress,
    }),
  );

  return getProvedCrossContract7702TransactionForCalls(
    encryptionKey,
    crossContractCalls,
    privateGasEstimate,
    [],
    [],
    relayAdaptShieldERC20Addresses,
  );
};

const getShieldBaseDepositCalls = (
  chainName: NetworkName,
  wrappedERC20AmountRecipient: RailgunERC20AmountRecipient,
): ContractTransaction[] => {
  const wrappedTokenInterface = new Interface(WRAPPED_BASE_TOKEN_ABI);
  const { wrappedAddress } = getWrappedTokenInfoForChain(chainName);

  return [
    {
      to: wrappedAddress,
      data: wrappedTokenInterface.encodeFunctionData("deposit"),
      value: wrappedERC20AmountRecipient.amount,
    },
  ];
};

export const getShieldBaseCrossContract7702GasEstimate = async (
  chainName: NetworkName,
  wrappedERC20AmountRecipient: RailgunERC20AmountRecipient,
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasEstimate | undefined> => {
  const crossContractCalls = getShieldBaseDepositCalls(
    chainName,
    wrappedERC20AmountRecipient,
  );
  const relayAdaptShieldERC20Addresses = [
    {
      tokenAddress: wrappedERC20AmountRecipient.tokenAddress,
      recipientAddress: wrappedERC20AmountRecipient.recipientAddress,
    },
  ];

  return getCrossContract7702GasEstimateForCalls(
    chainName,
    crossContractCalls,
    encryptionKey,
    broadcasterSelection,
    [],
    [],
    relayAdaptShieldERC20Addresses,
  );
};

export const getProvedShieldBaseCrossContract7702Transaction = async (
  encryptionKey: string,
  chainName: NetworkName,
  wrappedERC20AmountRecipient: RailgunERC20AmountRecipient,
  privateGasEstimate: PrivateGasEstimate,
): Promise<Optional<RailgunPopulateTransactionResponse>> => {
  const crossContractCalls = getShieldBaseDepositCalls(
    chainName,
    wrappedERC20AmountRecipient,
  );
  const relayAdaptShieldERC20Addresses = [
    {
      tokenAddress: wrappedERC20AmountRecipient.tokenAddress,
      recipientAddress: wrappedERC20AmountRecipient.recipientAddress,
    },
  ];

  return getProvedCrossContract7702TransactionForCalls(
    encryptionKey,
    crossContractCalls,
    privateGasEstimate,
    [],
    [],
    relayAdaptShieldERC20Addresses,
  );
};
