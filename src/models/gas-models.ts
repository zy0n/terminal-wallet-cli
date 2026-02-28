export type FeeHistoryResponse = {
    oldestBlock: string | bigint;
    reward: string[][];
    baseFeePerGas: (string | bigint)[];
    gasUsedRatio: (string | number)[];
  };
export type CustomGasEstimate = {
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFeePerGas: bigint;
  slow: bigint;
  average: bigint;
  fast: bigint;
};
export type FeeHistoryBlock = {
  blockNumber: bigint | number | string;
  baseFeePerGas: bigint;
  gasUsedRatio: number;
  priorityFeePerGas: bigint[];
};
  