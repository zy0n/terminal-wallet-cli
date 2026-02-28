import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { formatUnits, parseUnits } from "ethers";
import { getFirstPollingProviderForChain } from "../network/network-util";
import { promiseTimeout } from "../util/util";
import { FeeHistoryResponse } from "../models/gas-models";
import { CustomGasEstimate } from "../models/gas-models";
import { FeeHistoryBlock } from "../models/gas-models";

const GWEI_TIP_FLOOR = parseUnits("0.01", "gwei");

const bigintMax = (a: bigint, b: bigint): bigint => (a > b ? a : b);

const weightedAverage = (arr: bigint[]): bigint => {
  if (!arr.length) {
    return 0n;
  }

  let weightedSum = 0n;
  let totalWeight = 0n;

  for (let index = 0; index < arr.length; index += 1) {
    const weight = BigInt(index + 1);
    weightedSum += arr[index] * weight;
    totalWeight += weight;
  }

  return weightedSum / totalWeight;
};

const percentile = (arr: bigint[], p: number): bigint => {
  if (!arr.length) {
    return 0n;
  }
  const sorted = [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const clampedP = Math.min(Math.max(p, 0), 100);
  const index = Math.floor(((sorted.length - 1) * clampedP) / 100);
  return sorted[index];
};

const winsorize = (
  arr: bigint[],
  lowerPercentile: number,
  upperPercentile: number,
): bigint[] => {
  if (!arr.length) {
    return arr;
  }

  const low = percentile(arr, lowerPercentile);
  const high = percentile(arr, upperPercentile);

  return arr.map((value) => {
    if (value < low) {
      return low;
    }
    if (value > high) {
      return high;
    }
    return value;
  });
};

const projectBaseFee = (currentBaseFee: bigint, blocksAhead: number): bigint => {
  let projected = currentBaseFee;
  for (let index = 0; index < blocksAhead; index += 1) {
    const increase = (projected + 7n) / 8n;
    projected += increase;
  }
  return projected;
};

const estimatePriorityFee = (values: bigint[]): bigint => {
  if (!values.length) {
    return 0n;
  }

  const cleanedValues = winsorize(values, 10, 90);
  return weightedAverage(cleanedValues);
};

const buildPriorityFeeBands = (blocks: FeeHistoryBlock[]) => {
  const slowSeries = blocks
    .map((block) => block.priorityFeePerGas[0])
    .filter((value): value is bigint => typeof value === "bigint");
  const averageSeries = blocks
    .map((block) => block.priorityFeePerGas[1])
    .filter((value): value is bigint => typeof value === "bigint");
  const fastSeries = blocks
    .map((block) => block.priorityFeePerGas[2])
    .filter((value): value is bigint => typeof value === "bigint");

  const slow = estimatePriorityFee(slowSeries);
  const average = bigintMax(estimatePriorityFee(averageSeries), slow);
  const fast = bigintMax(estimatePriorityFee(fastSeries), average);

  return {
    slow,
    average,
    fast,
  };
};

export const formatFeeHistory = (
  result: any,
  includePending: boolean,
  historicalBlocks: number,
): FeeHistoryBlock[] => {
  let blockNum = BigInt(result.oldestBlock);
  let index = 0;
  const blocks: FeeHistoryBlock[] = [];

  while (
    blockNum < BigInt(result.oldestBlock) + BigInt(result.reward.length) &&
    isDefined(result.reward[index])
  ) {
    const newPriorityFeePerGas = result.reward[index].map((x: string) =>
      BigInt(x),
    );
    blocks.push({
      blockNumber: blockNum,
      baseFeePerGas: BigInt(result.baseFeePerGas[index]),
      gasUsedRatio: Number(result.gasUsedRatio[index]),
      priorityFeePerGas: newPriorityFeePerGas,
    });
    blockNum += 1n;
    index += 1;
  }

  if (includePending) {
    blocks.push({
      blockNumber: "pending",
      baseFeePerGas: BigInt(result.baseFeePerGas[historicalBlocks]),
      gasUsedRatio: NaN,
      priorityFeePerGas: [],
    });
  }

  return blocks;
};

export const getGasEstimates = async (
  chainName: NetworkName,
): Promise<CustomGasEstimate> => {
  const historicalBlocks = 30;
  const currentBlockNumber = "latest";
  const rewardPercentiles = [25, 50, 90];
  const provider = getFirstPollingProviderForChain(chainName);

  const gasPricePromise = await promiseTimeout(
    provider.send("eth_gasPrice", []),
    10 * 1000,
  ).catch((err) => {
    console.log(err.message);
    return undefined;
  });

  if (!isDefined(gasPricePromise)) {
    throw new Error("Unable to get Gas Price");
  }

  const gasPrice = BigInt(gasPricePromise);
  if (!isDefined(gasPrice)) {
    throw new Error("Gas Price is Null");
  }

  const feeHistoryPromise = await promiseTimeout(
    provider.send("eth_feeHistory", [
      historicalBlocks,
      currentBlockNumber,
      rewardPercentiles,
    ]),
    10 * 1000,
  ).catch((err) => {
    console.log(err.message);
    return undefined;
  });

  if (!isDefined(feeHistoryPromise)) {
    throw new Error("Unable to get gas fee history.");
  }

  const feeHistory = feeHistoryPromise as FeeHistoryResponse;

  const baseFeePerGas = BigInt(
    feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1],
  ) as bigint;

  const blocks: FeeHistoryBlock[] = formatFeeHistory(
    feeHistory,
    false,
    historicalBlocks,
  );
  const { slow: rawSlow, average: rawAverage, fast: rawFast } =
    buildPriorityFeeBands(blocks);

  const slow = bigintMax(rawSlow, GWEI_TIP_FLOOR);
  const average = bigintMax(rawAverage, slow);
  const fast = bigintMax(rawFast, average);

  const maxPriorityFeePerGas = fast;

  const projectedBaseFee = projectBaseFee(baseFeePerGas, 3);
  const maxFeePerGas = maxPriorityFeePerGas + projectedBaseFee;

  return {
    gasPrice, //: (gasPrice * 11000n )/ 10000n, // Add 10% to gas price for safety
    maxFeePerGas,
    maxPriorityFeePerGas,
    baseFeePerGas,
    slow,
    average,
    fast,
  };
};

export const getGasEstimateMatrix = (gasEstimate: CustomGasEstimate) => {
  const {
    gasPrice: _gasPrice,
    maxFeePerGas: _maxFeePerGas,
    maxPriorityFeePerGas: _maxPriorityFeePerGas,
    baseFeePerGas,
    slow,
    average,
    fast,
  } = gasEstimate;

  const gasPrice = formatUnits(_gasPrice, "gwei");
  const maxFeePerGas = formatUnits(_maxFeePerGas, "gwei");
  const maxPriorityFeePerGas = formatUnits(_maxPriorityFeePerGas, "gwei");

  const matrix = {
    recommended: {
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
    },
    slow: {
      gasPrice,
      maxFeePerGas: formatUnits(slow + baseFeePerGas, "gwei"),
      maxPriorityFeePerGas: formatUnits(slow, "gwei"),
    },
    average: {
      gasPrice,
      maxFeePerGas: formatUnits(average + baseFeePerGas, "gwei"),
      maxPriorityFeePerGas: formatUnits(average, "gwei"),
    },
    fast: {
      gasPrice,
      maxFeePerGas: formatUnits(fast + baseFeePerGas, "gwei"),
      maxPriorityFeePerGas: formatUnits(fast, "gwei"),
    },
  };
  return matrix;
};
