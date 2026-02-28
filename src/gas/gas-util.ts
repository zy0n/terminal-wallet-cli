import {
  EVMGasType,
  NETWORK_CONFIG,
  NetworkName,
  TransactionGasDetails,
  TransactionGasDetailsType1,
  TransactionGasDetailsType2,
  isDefined,
} from "@railgun-community/shared-models";
import { ContractTransaction } from "ethers";
import { throwError } from "../util/util";
import { CustomGasEstimate } from "../models/gas-models";
import { getGasEstimates } from "./gas-fee";
import { getProviderForChain } from "../network/network-util";

export type GasFeeSelectionPreset =
  | "recommended"
  | "slow"
  | "average"
  | "fast"
  | "custom";

export type GasFeeSelection = {
  preset: GasFeeSelectionPreset;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type GasSelectionQuote = {
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

const gasSelectionByChain = new Map<NetworkName, GasFeeSelection>();

const normalizeOptionalBigInt = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return BigInt(value);
  }
  return undefined;
};

const buildPresetQuote = (
  gasEstimate: CustomGasEstimate,
  preset: Exclude<GasFeeSelectionPreset, "custom">,
): GasSelectionQuote => {
  const { gasPrice, baseFeePerGas, maxFeePerGas, maxPriorityFeePerGas } =
    gasEstimate;

  if (preset === "recommended") {
    return {
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  }

  const tipByPreset: Record<"slow" | "average" | "fast", bigint> = {
    slow: gasEstimate.slow,
    average: gasEstimate.average,
    fast: gasEstimate.fast,
  };

  const selectedTip = tipByPreset[preset];
  return {
    gasPrice,
    maxFeePerGas: baseFeePerGas + selectedTip,
    maxPriorityFeePerGas: selectedTip,
  };
};

const applyGasSelection = (
  chainName: NetworkName,
  baseFeeData: GasSelectionQuote,
  currentGasEstimate?: CustomGasEstimate,
): GasSelectionQuote => {
  const selected = gasSelectionByChain.get(chainName);
  if (!selected) {
    return baseFeeData;
  }

  if (selected.preset === "custom") {
    return {
      gasPrice: selected.gasPrice ?? baseFeeData.gasPrice,
      maxFeePerGas: selected.maxFeePerGas ?? baseFeeData.maxFeePerGas,
      maxPriorityFeePerGas:
        selected.maxPriorityFeePerGas ?? baseFeeData.maxPriorityFeePerGas,
    };
  }

  if (isDefined(currentGasEstimate)) {
    return buildPresetQuote(currentGasEstimate, selected.preset);
  }

  return baseFeeData;
};

export const setGasFeeSelectionForChain = (
  chainName: NetworkName,
  selection?: GasFeeSelection,
) => {
  if (!selection) {
    gasSelectionByChain.delete(chainName);
    return;
  }
  gasSelectionByChain.set(chainName, selection);
};

export const getGasFeeSelectionForChain = (chainName: NetworkName) => {
  return gasSelectionByChain.get(chainName);
};

export const getGasSelectionQuotes = async (chainName: NetworkName) => {
  switch (chainName) {
    case NetworkName.Ethereum:
    case NetworkName.Polygon: {
      const estimate = await getGasEstimates(chainName);
      return {
        recommended: buildPresetQuote(estimate, "recommended"),
        slow: buildPresetQuote(estimate, "slow"),
        average: buildPresetQuote(estimate, "average"),
        fast: buildPresetQuote(estimate, "fast"),
        supportsSpeedPresets: true,
      };
    }
  }

  const provider = getProviderForChain(chainName);
  const feeData = await provider.getFeeData().catch(() => undefined);

  if (!isDefined(feeData)) {
    throw new Error("Unable to get Gas Fee Data");
  }

  const recommended = {
    gasPrice: normalizeOptionalBigInt(feeData.gasPrice),
    maxFeePerGas: normalizeOptionalBigInt(feeData.maxFeePerGas),
    maxPriorityFeePerGas: normalizeOptionalBigInt(feeData.maxPriorityFeePerGas),
  };

  return {
    recommended,
    slow: recommended,
    average: recommended,
    fast: recommended,
    supportsSpeedPresets: false,
  };
};

export const calculatePublicGasFee = async (
  transaction: ContractTransaction,
) => {
  const { gasPrice, maxFeePerGas, gasLimit } = transaction;

  if (typeof gasLimit !== "undefined") {
    if (typeof gasPrice !== "undefined") {
      return gasPrice * gasLimit;
    }
    if (typeof maxFeePerGas !== "undefined") {
      return maxFeePerGas * gasLimit;
    }
  }
  throw new Error("No Gas present Details in Transaction");
};

export const calculateEstimatedGasCost = (
  estimatedDetails: TransactionGasDetails,
) => {
  const { gasEstimate } = estimatedDetails;

  if (typeof estimatedDetails.gasEstimate !== "undefined") {
    if (
      typeof (estimatedDetails as TransactionGasDetailsType1).gasPrice !==
      "undefined"
    ) {
      return (
        (estimatedDetails as TransactionGasDetailsType1).gasPrice * gasEstimate
      );
    }
    if (
      typeof (estimatedDetails as TransactionGasDetailsType2).maxFeePerGas !==
      "undefined"
    ) {
      return (
        (estimatedDetails as TransactionGasDetailsType2).maxFeePerGas *
        gasEstimate
      );
    }
  }
  throw new Error("No Gas present Details in Transaction");
};

export const getPublicGasEstimate = async (
  chainName: NetworkName,
  transaction: ContractTransaction,
) => {
  try {
    const provider = getProviderForChain(chainName);
    const gasEstimate = await provider
      .estimateGas(transaction)
      .catch(throwError);
    return gasEstimate;
  } catch (error) {
    console.log(error);
    throw new Error("Gas Estimation Error");
  }
};

export const getFeeDetailsForChain = async (chainName: NetworkName) => {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (chainName) {
    case NetworkName.Ethereum:
    case NetworkName.Polygon: {
      const currentGasEstimate = await getGasEstimates(chainName);
      const feeData = applyGasSelection(
        chainName,
        buildPresetQuote(currentGasEstimate, "recommended"),
        currentGasEstimate,
      );

      return {
        gasPrice: feeData.gasPrice,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      };
    }
  }
  const provider = getProviderForChain(chainName);
  const feeData = await provider.getFeeData().catch(() => {
    return undefined;
  });
  if (isDefined(feeData)) {
    const selectedFeeData = applyGasSelection(chainName, {
      gasPrice: normalizeOptionalBigInt(feeData.gasPrice),
      maxFeePerGas: normalizeOptionalBigInt(feeData.maxFeePerGas),
      maxPriorityFeePerGas: normalizeOptionalBigInt(feeData.maxPriorityFeePerGas),
    });

    return {
      gasPrice: selectedFeeData.gasPrice,
      maxFeePerGas: selectedFeeData.maxFeePerGas,
      maxPriorityFeePerGas: selectedFeeData.maxPriorityFeePerGas,
    };
  }
  throw new Error("Unable to get Gas Fee Data");
};

export const getPublicGasDetails = async (
  chainName: NetworkName,
  gasEstimate: bigint,
  isShield = false,
) => {
  const feeData = await getFeeDetailsForChain(chainName);
  const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } = feeData;

  const normalizedMaxFeePerGas = maxFeePerGas ?? gasPrice ?? 0n;
  const normalizedMaxPriorityFeePerGas =
    (maxPriorityFeePerGas ?? 0n) > normalizedMaxFeePerGas
      ? normalizedMaxFeePerGas
      : (maxPriorityFeePerGas ?? 0n);

  let gasDetailsInfo: {
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  } = { gasPrice: gasPrice ?? 0n };

  const { defaultEVMGasType } = NETWORK_CONFIG[chainName];

  // SELECTED DEFAULT because these are transacted through a personal wallet.
  switch (defaultEVMGasType) {
    case EVMGasType.Type0:
    case EVMGasType.Type1: {
      gasDetailsInfo.gasPrice = gasPrice ?? 0n;
      break;
    }
    case EVMGasType.Type2: {
      gasDetailsInfo = {
        maxFeePerGas: normalizedMaxFeePerGas,
        maxPriorityFeePerGas: normalizedMaxPriorityFeePerGas,
      };
      break;
    }
  }

  if (isShield) {
    const gasDetails = {
      evmGasType: defaultEVMGasType,
      gasEstimate,
      ...gasDetailsInfo,
    } as TransactionGasDetails;

    return gasDetails;
  }
  const gasDetails = {
    gasLimit: gasEstimate,
    ...gasDetailsInfo,
  };
  return gasDetails;
};
