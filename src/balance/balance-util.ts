import {
  NETWORK_CONFIG,
  ChainType,
  NetworkName,
  RailgunWalletBalanceBucket,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import {
  RailgunDisplayBalance,
  RailgunReadableAmount,
} from "../models/balance-models";
import {
  getPrivateERC20BalanceForChain,
  initPrivateBalanceCachesForChain,
  initPublicBalanceCachesForChain,
  privateERC20BalanceCache,
  publicERC20BalanceCache,
} from "./balance-cache";
import {
  getChainForName,
  getFirstPollingProviderForChain,
  getWrappedTokenInfoForChain,
} from "../network/network-util";
import { getTokenInfo } from "./token-util";
import { Contract, formatUnits } from "ethers";
import "colors";
import {
  getCurrentRailgunID,
  getCurrentWalletGasBalance,
  shouldDisplayPrivateBalances,
} from "../wallet/wallet-util";
import { readablePrecision } from "../util/util";
import { stripColors } from "colors";
import configDefaults from "../config/config-defaults";
import { walletManager } from "../wallet/wallet-manager";
import { walletForID } from "@railgun-community/wallet";

type PrivateNFTDisplayBalance = {
  tokenAddress: string;
  tokenSubID: string;
  amount: bigint;
  tokenName: string;
};

const nftTokenNameCache: Map<string, string> = new Map();

const truncateAddress = (address: string, len = 6): string => {
  if (address.length <= len * 2 + 2) return address;
  return `${address.slice(0, len + 2)}...${address.slice(-len)}`;
};

const toTokenIdString = (tokenSubID: string | number | bigint): string => {
  if (typeof tokenSubID === "bigint") {
    return tokenSubID.toString();
  }
  if (typeof tokenSubID === "number") {
    return BigInt(Math.trunc(tokenSubID)).toString();
  }

  const value = tokenSubID.trim();
  if (/^0x[0-9a-fA-F]+$/.test(value)) {
    return BigInt(value).toString();
  }
  if (/^\d+$/.test(value)) {
    return BigInt(value).toString();
  }
  return value;
};

const getNFTTokenName = async (
  chainName: NetworkName,
  tokenAddress: string,
): Promise<string> => {
  const cacheKey = `${chainName}:${tokenAddress.toLowerCase()}`;
  const cached = nftTokenNameCache.get(cacheKey);
  if (isDefined(cached)) {
    return cached;
  }

  try {
    const provider = getFirstPollingProviderForChain(chainName);
    const contract = new Contract(
      tokenAddress,
      ["function name() view returns (string)"],
      provider,
    );
    const name = (await contract.name()) as string;
    const normalized = name?.trim?.() || truncateAddress(tokenAddress);
    nftTokenNameCache.set(cacheKey, normalized);
    return normalized;
  } catch {
    const fallback = truncateAddress(tokenAddress);
    nftTokenNameCache.set(cacheKey, fallback);
    return fallback;
  }
};

const getPrivateNFTBalancesForChain = async (
  chainName: NetworkName,
  balanceBucket: RailgunWalletBalanceBucket,
): Promise<PrivateNFTDisplayBalance[]> => {
  const chain = getChainForName(chainName);
  const wallet = walletForID(getCurrentRailgunID());

  const balancesByBucket = await wallet.getTokenBalancesByBucket(
    TXIDVersion.V2_PoseidonMerkle,
    { id: chain.id, type: ChainType.EVM },
  );

  const bucketBalances = Object.values(
    (balancesByBucket as Record<string, Record<string, any>>)[balanceBucket] ??
      {},
  );

  const nftBalances = bucketBalances
    .filter((entry: any) => {
      const tokenType = entry?.tokenData?.tokenType;
      const isNFTByType =
        tokenType === 1 || tokenType === "1" || tokenType === 2 || tokenType === "2";
      const hasPositiveBalance = BigInt(entry?.balance ?? 0) > 0n;
      return isNFTByType && hasPositiveBalance;
    })
    .map((entry: any) => {
      const { tokenAddress } = entry.tokenData;
      return {
        tokenAddress,
        tokenSubID: toTokenIdString(entry.tokenData.tokenSubID?.toString?.() ?? "0"),
        amount: BigInt(entry.balance),
      };
    });

  return Promise.all(
    nftBalances.map(async (entry) => ({
      ...entry,
      tokenName: await getNFTTokenName(chainName, entry.tokenAddress),
    })),
  );
};

export const getWrappedTokenBalance = async (
  chainName: NetworkName,
  useGasBalance = false,
) => {
  const wrappedInfo = getWrappedTokenInfoForChain(chainName);

  const { name } = await getTokenInfo(chainName, wrappedInfo.wrappedAddress);

  const wrappedBalance = useGasBalance
    ? await getCurrentWalletGasBalance()
    : getPrivateERC20BalanceForChain(chainName, wrappedInfo.wrappedAddress);
  const wrappedDecimals = NETWORK_CONFIG[chainName].baseToken.decimals;
  const wrappedReadableAmount: RailgunReadableAmount = {
    symbol: useGasBalance ? wrappedInfo.symbol : wrappedInfo.wrappedSymbol,
    name,
    tokenAddress: wrappedInfo.wrappedAddress,
    amount: wrappedBalance,
    amountReadable: readablePrecision(wrappedBalance, wrappedDecimals, 8),
    decimals: wrappedDecimals,
  };
  return wrappedReadableAmount;
};

export const getMaxBalanceLength = (
  balances: RailgunDisplayBalance[],
): number => {
  const maxBalanceLengthItem =
    balances.length > 0
      ? balances.reduce((a, c) => {
          return formatUnits(a.amount, a.decimals).length >
            formatUnits(c.amount, c.decimals).length
            ? a
            : c;
        })
      : undefined;

  const maxBalanceLength = isDefined(maxBalanceLengthItem)
    ? formatUnits(maxBalanceLengthItem.amount, maxBalanceLengthItem.decimals)
        .length
    : 0;
  return maxBalanceLength;
};

export const getPublicERC20BalancesForChain = async (
  chainName: NetworkName,
  showBaseBalance = false,
): Promise<RailgunDisplayBalance[]> => {
  const chain = getChainForName(chainName);
  initPublicBalanceCachesForChain(chainName);
  const cache = publicERC20BalanceCache[chain.type][chain.id];
  if (!cache) {
    return [];
  }
  const erc20Addresses = Object.keys(cache);
  const balances: RailgunDisplayBalance[] = [];
  erc20Addresses.map(async (tokenAddress) => {
    const { name, symbol, decimals } = await getTokenInfo(
      chainName,
      tokenAddress,
    );
    const { amount } = cache[tokenAddress].balance;
    const bigIntAmount = BigInt(amount);

    if (bigIntAmount > 0n) {
      balances.push({
        tokenAddress,
        amount: bigIntAmount,
        decimals,
        name,
        symbol,
      });
    }
  });

  if (showBaseBalance) {
    const wrappedReadableAmount = (await getWrappedTokenBalance(
      chainName,
      true,
    )) as RailgunDisplayBalance;
    wrappedReadableAmount.name = wrappedReadableAmount.name.replace(
      "Wrapped ",
      "",
    );
    const balancesWithBase = [wrappedReadableAmount, ...balances];
    return balancesWithBase;
  }

  return balances;
};

export const getPrivateERC20BalancesForChain = (
  chainName: NetworkName,
  balanceBucket: RailgunWalletBalanceBucket = RailgunWalletBalanceBucket.Spendable,
): RailgunDisplayBalance[] => {
  const chain = getChainForName(chainName);
  initPrivateBalanceCachesForChain(
    chainName,
    balanceBucket,
    getCurrentRailgunID(),
  );
  const cache =
    privateERC20BalanceCache[chain.type][chain.id][balanceBucket][
      getCurrentRailgunID()
    ];
  if (!cache) {
    return [];
  }
  const erc20Addresses = Object.keys(cache);

  const balances: RailgunDisplayBalance[] = [];
  erc20Addresses.map(async (tokenAddress) => {
    const { name, symbol, decimals } = await getTokenInfo(
      chainName,
      tokenAddress,
    );
    const { amount } = cache[tokenAddress].balance;
    const bigIntAmount = BigInt(amount);
    if (bigIntAmount > 0n) {
      balances.push({
        tokenAddress,
        amount: bigIntAmount,
        decimals,
        name,
        symbol,
      });
    }
  });

  return balances;
};

export const getMaxSymbolLengthFromBalances = (
  balances: RailgunDisplayBalance[],
) => {
  return balances.length > 0
    ? balances.reduce((a, c) => {
        return a.symbol.length > c.symbol.length ? a : c;
      }).symbol.length
    : 0;
};

export const getDisplayStringFromBalance = (
  balance: RailgunDisplayBalance,
  maxBalanceLength: number,
  maxSymbolLength: number,
) => {
  const balanceString = formatUnits(balance.amount, balance.decimals);

  const balanceDisplayString = `${
    balanceString.padEnd(maxBalanceLength, "0").bold
  } | [${balance.symbol.padEnd(maxSymbolLength, " ").cyan}] ${balance.name}`;
  return balanceDisplayString;
};

export const getPrivateDisplayBalances = async (
  chainName: NetworkName,
  bucketType: RailgunWalletBalanceBucket,
) => {
  const CHAIN_NAME = configDefaults.networkConfig[chainName].name.toUpperCase();
  const display: string[] = [];

  const isPrivate = shouldDisplayPrivateBalances();
  const balances = isPrivate
    ? await getPrivateERC20BalancesForChain(chainName, bucketType)
    : await getPublicERC20BalancesForChain(chainName, true);
  const nftBalances = isPrivate
    ? await getPrivateNFTBalancesForChain(chainName, bucketType).catch(() => [])
    : [];

  if (bucketType !== RailgunWalletBalanceBucket.Spendable) {
    if (balances.length === 0 && nftBalances.length === 0) {
      return "";
    }
    if (!isPrivate) {
      // if not private, only show set of balances once. dont add header.
      return "";
    }
  }
  const balanceType = isPrivate ? "PRIVATE" : "PUBLIC";
  const header = `${CHAIN_NAME.green} ${
    isPrivate ? bucketType.green : ""
  } ${balanceType} BALANCES`;
  const headLen = stripColors(header).length;
  display.push("");
  const headerLine = `${header}`;
  const headerPad = "".padEnd(70 - headLen, "=");
  display.push(`${headerLine} ${headerPad.grey}`);

  if (balances.length === 0 && nftBalances.length === 0) {
    const balanceHeader = walletManager.menuLoaded ? "NO" : "LOADING";
    display.push(`${balanceHeader} Balances...`.grey);
    display.push("".padEnd(70, "=").grey);
    return display.join("\n");
  }

  const maxSymbolLength = getMaxSymbolLengthFromBalances(balances);
  const maxBalanceLength = getMaxBalanceLength(balances);
  for (const bal of balances) {
    const balanceDisplayString = getDisplayStringFromBalance(
      bal,
      maxBalanceLength,
      maxSymbolLength,
    );
    display.push(balanceDisplayString);
  }

  if (nftBalances.length > 0) {
    if (balances.length > 0) {
      display.push("");
    }
    display.push(`${"NFTs".cyan.bold}:`);
    for (const [index, nft] of nftBalances.entries()) {
      display.push(
        `  [${index}] ${nft.tokenName} (ID: ${nft.tokenSubID}) x${nft.amount.toString()}`,
      );
    }
  }

  const footer = "".padEnd(70, "=");
  display.push(`${footer.grey}`);
  return display.join("\n");
};
