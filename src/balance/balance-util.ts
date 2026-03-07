import {
  NETWORK_CONFIG,
  ChainType,
  NetworkName,
  POI_SHIELD_PENDING_SEC,
  POI_SHIELD_PENDING_SEC_TEST_NET,
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
  getGasBalanceForAddress,
  getCurrentWalletGasBalance,
  shouldDisplayPrivateBalances,
} from "../wallet/wallet-util";
import { readablePrecision } from "../util/util";
import { stripColors } from "colors";
import configDefaults from "../config/config-defaults";
import { walletManager } from "../wallet/wallet-manager";
import { getWalletTransactionHistory, walletForID } from "@railgun-community/wallet";
import { getERC20AddressesForChain, getERC20Balance } from "./token-util";

type ShieldPendingTimeline = {
  etaText: string;
  detailLines: string[];
};

type ShieldPendingTimelineCacheEntry = {
  timeline: ShieldPendingTimeline;
  expiresAt: number;
};

const shieldPendingTimelineCache: Map<string, ShieldPendingTimelineCacheEntry> =
  new Map();

const SHIELD_PENDING_TIMELINE_CACHE_MS = 30_000;

const getShieldPendingWindowSec = (chainName: NetworkName): number => {
  return NETWORK_CONFIG[chainName].isTestnet
    ? POI_SHIELD_PENDING_SEC_TEST_NET
    : POI_SHIELD_PENDING_SEC;
};

const formatRemainingDuration = (remainingSec: number): string => {
  if (remainingSec <= 60) {
    return "<1m";
  }

  const totalMinutes = Math.ceil(remainingSec / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${totalMinutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
};

const getShieldPendingTimelineFromHistory = async (
  chainName: NetworkName,
): Promise<ShieldPendingTimeline> => {
  const chain = getChainForName(chainName);
  const railgunWalletID = getCurrentRailgunID();
  const cacheKey = `${chain.type}:${chain.id}:${railgunWalletID}`;
  const now = Date.now();

  const cached = shieldPendingTimelineCache.get(cacheKey);
  if (isDefined(cached) && cached.expiresAt > now) {
    return cached.timeline;
  }

  const pendingWindowSec = getShieldPendingWindowSec(chainName);
  const nowSec = Math.floor(now / 1000);
  const history = await getWalletTransactionHistory(chain, railgunWalletID, undefined);

  type Cohort = {
    remainingSec: number;
    notes: number;
    relayedNotes: number;
  };

  const cohortsByMinute: Map<number, Cohort> = new Map();
  let totalPendingNotes = 0;

  for (const item of history) {
    const txTimestampSec = item.timestamp;
    if (!isDefined(txTimestampSec) || txTimestampSec <= 0) {
      continue;
    }

    const pendingERC20Receives = item.receiveERC20Amounts.filter(
      (receiveAmount) =>
        receiveAmount.balanceBucket === RailgunWalletBalanceBucket.ShieldPending,
    );
    const pendingNFTReceives = item.receiveNFTAmounts.filter(
      (receiveAmount) =>
        receiveAmount.balanceBucket === RailgunWalletBalanceBucket.ShieldPending,
    );

    const pendingNoteCount = pendingERC20Receives.length + pendingNFTReceives.length;
    if (pendingNoteCount === 0) {
      continue;
    }

    const relayedNotes =
      pendingERC20Receives.filter((receiveAmount) => {
        if (!isDefined(receiveAmount.shieldFee)) {
          return false;
        }
        return BigInt(receiveAmount.shieldFee) > 0n;
      }).length +
      pendingNFTReceives.filter((receiveAmount) => {
        if (!isDefined(receiveAmount.shieldFee)) {
          return false;
        }
        return BigInt(receiveAmount.shieldFee) > 0n;
      }).length;

    const unlockTimestampSec = txTimestampSec + pendingWindowSec;
    const remainingSec = unlockTimestampSec - nowSec;
    if (remainingSec <= 0) {
      continue;
    }

    totalPendingNotes += pendingNoteCount;

    const minuteCohortKey = Math.ceil(remainingSec / 60);
    const existingCohort = cohortsByMinute.get(minuteCohortKey);
    if (isDefined(existingCohort)) {
      existingCohort.notes += pendingNoteCount;
      existingCohort.relayedNotes += relayedNotes;
      continue;
    }

    cohortsByMinute.set(minuteCohortKey, {
      remainingSec,
      notes: pendingNoteCount,
      relayedNotes,
    });
  }

  const sortedCohorts = [...cohortsByMinute.values()].sort(
    (a, b) => a.remainingSec - b.remainingSec,
  );

  const timeline: ShieldPendingTimeline =
    sortedCohorts.length === 0
      ? {
          etaText: "Expected: settling",
          detailLines: [],
        }
      : {
          etaText: `Expected: ${formatRemainingDuration(sortedCohorts[0].remainingSec)}-${formatRemainingDuration(sortedCohorts[sortedCohorts.length - 1].remainingSec)}`,
          detailLines: sortedCohorts.slice(0, 3).map((cohort) => {
            const directNotes = cohort.notes - cohort.relayedNotes;
            const noteLabel = cohort.notes === 1 ? "note" : "notes";
            const modeLabel =
              cohort.relayedNotes > 0 && directNotes > 0
                ? "mixed"
                : cohort.relayedNotes > 0
                  ? "relay"
                  : "direct";
            return `⏱ ${cohort.notes} ${noteLabel} unlock in ${formatRemainingDuration(cohort.remainingSec)} (${modeLabel})`;
          }),
        };

  if (totalPendingNotes > 0 && timeline.detailLines.length > 0) {
    timeline.detailLines.unshift(`Pending notes: ${totalPendingNotes}`);
  }

  shieldPendingTimelineCache.set(cacheKey, {
    timeline,
    expiresAt: now + SHIELD_PENDING_TIMELINE_CACHE_MS,
  });

  return timeline;
};

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
  publicAddressOverride?: string,
) => {
  const wrappedInfo = getWrappedTokenInfoForChain(chainName);

  const { name } = await getTokenInfo(chainName, wrappedInfo.wrappedAddress);

  const wrappedBalance = useGasBalance
    ? isDefined(publicAddressOverride)
      ? await getGasBalanceForAddress(publicAddressOverride)
      : await getCurrentWalletGasBalance()
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

export const getPublicERC20BalancesForAddress = async (
  chainName: NetworkName,
  publicAddress: string,
  showBaseBalance = false,
): Promise<RailgunDisplayBalance[]> => {
  const tokenAddresses = getERC20AddressesForChain(chainName);

  const balances = (
    await Promise.all(
      tokenAddresses.map(async (tokenAddress) => {
        const amount = await getERC20Balance(chainName, tokenAddress, publicAddress);
        if (amount <= 0n) {
          return undefined;
        }

        const { name, symbol, decimals } = await getTokenInfo(chainName, tokenAddress);
        return {
          tokenAddress,
          amount,
          decimals,
          name,
          symbol,
        } as RailgunDisplayBalance;
      }),
    )
  ).filter((balance): balance is RailgunDisplayBalance => isDefined(balance));

  if (showBaseBalance) {
    const wrappedReadableAmount = (await getWrappedTokenBalance(
      chainName,
      true,
      publicAddress,
    )) as RailgunDisplayBalance;
    wrappedReadableAmount.name = wrappedReadableAmount.name.replace(
      "Wrapped ",
      "",
    );
    return [wrappedReadableAmount, ...balances];
  }

  return balances;
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
  hideAmounts = false,
) => {
  const balanceString = hideAmounts
    ? "***"
    : formatUnits(balance.amount, balance.decimals);

  const balanceDisplayString = `${
    balanceString.padEnd(maxBalanceLength, "0").bold
  } | [${balance.symbol.padEnd(maxSymbolLength, " ").cyan}] ${balance.name}`;
  return balanceDisplayString;
};

const BALANCE_CARD_WIDTH = 74;

const bucketLabelForDisplay = (bucketType: RailgunWalletBalanceBucket): string => {
  return bucketType.replace(/([a-z])([A-Z])/g, "$1 $2");
};

const truncateLabel = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 1)}…`;
};

const padAnsiRight = (value: string, width: number): string => {
  const visibleLength = stripColors(value).length;
  if (visibleLength >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - visibleLength)}`;
};

const padAnsiLeft = (value: string, width: number): string => {
  const visibleLength = stripColors(value).length;
  if (visibleLength >= width) {
    return value;
  }
  return `${" ".repeat(width - visibleLength)}${value}`;
};

const pushCardRow = (display: string[], content = "") => {
  const innerWidth = BALANCE_CARD_WIDTH - 2;
  display.push(`${"│".grey}${padAnsiRight(content, innerWidth)}${"│".grey}`);
};

const getAmountForDisplay = (
  balance: RailgunDisplayBalance,
  hideAmounts: boolean,
): string => {
  if (hideAmounts) {
    return "***";
  }
  return readablePrecision(balance.amount, balance.decimals, 8);
};

export const getPrivateDisplayBalances = async (
  chainName: NetworkName,
  bucketType: RailgunWalletBalanceBucket,
  hideAmounts = false,
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
  const bucketLabel = isPrivate
    ? bucketLabelForDisplay(bucketType)
    : "Spendable";
  const header = `${CHAIN_NAME.green} ${balanceType.cyan} ${bucketLabel.yellow}`;
  const shieldPendingTimeline =
    isPrivate && bucketType === RailgunWalletBalanceBucket.ShieldPending
      ? await getShieldPendingTimelineFromHistory(chainName).catch(() => ({
          etaText: "Expected: unavailable",
          detailLines: [],
        }))
      : undefined;
  const summary = `${balances.length} token${balances.length === 1 ? "" : "s"} • ${nftBalances.length} NFT${nftBalances.length === 1 ? "" : "s"}`;

  display.push("");
  display.push(`${"╭".grey}${"─".repeat(BALANCE_CARD_WIDTH - 2).grey}${"╮".grey}`);
  pushCardRow(display, header);
  pushCardRow(display, `${"Assets".dim}: ${summary.dim}`);

  if (isDefined(shieldPendingTimeline)) {
    pushCardRow(display, `${"Timeline".dim}: ${shieldPendingTimeline.etaText.dim}`);
  }

  display.push(`${"├".grey}${"─".repeat(BALANCE_CARD_WIDTH - 2).grey}${"┤".grey}`);

  if (isDefined(shieldPendingTimeline) && shieldPendingTimeline.detailLines.length > 0) {
    for (const line of shieldPendingTimeline.detailLines) {
      pushCardRow(display, `• ${line}`.dim);
    }
    display.push(`${"├".grey}${"─".repeat(BALANCE_CARD_WIDTH - 2).grey}${"┤".grey}`);
  }

  if (balances.length === 0 && nftBalances.length === 0) {
    const balanceHeader = walletManager.menuLoaded ? "NO" : "LOADING";
    pushCardRow(display, `${balanceHeader} balances...`.grey);
    display.push(`${"╰".grey}${"─".repeat(BALANCE_CARD_WIDTH - 2).grey}${"╯".grey}`);
    return display.join("\n");
  }

  const sortedBalances = [...balances].sort((a, b) => {
    if (a.amount === b.amount) {
      return a.symbol.localeCompare(b.symbol);
    }
    return a.amount > b.amount ? -1 : 1;
  });

  const amountStrings = sortedBalances.map((balance) =>
    getAmountForDisplay(balance, hideAmounts),
  );
  const amountColumnWidth = amountStrings.reduce((maxWidth, value) => {
    return Math.max(maxWidth, stripColors(value).length);
  }, hideAmounts ? 3 : 8);

  const symbolColumnWidth = Math.max(
    6,
    sortedBalances.reduce((maxWidth, balance) => {
      return Math.max(maxWidth, balance.symbol.length);
    }, 0),
  );

  for (let index = 0; index < sortedBalances.length; index += 1) {
    const balance = sortedBalances[index];
    const amount = amountStrings[index];
    const symbol = `[${balance.symbol}]`.cyan;
    const symbolPadded = padAnsiRight(symbol, symbolColumnWidth + 2);
    const amountPadded = padAnsiLeft(amount, amountColumnWidth);

    const usedWidth = stripColors(`${symbolPadded} ${amountPadded}  `).length;
    const availableNameWidth = Math.max(8, BALANCE_CARD_WIDTH - 2 - usedWidth);
    const name = truncateLabel(balance.name, availableNameWidth);

    pushCardRow(display, `${symbolPadded} ${amountPadded}  ${name}`);
  }

  if (nftBalances.length > 0) {
    display.push(`${"├".grey}${"─".repeat(BALANCE_CARD_WIDTH - 2).grey}${"┤".grey}`);
    pushCardRow(display, `${"NFT COLLECTIONS".cyan.bold}`);

    for (const [index, nft] of nftBalances.entries()) {
      const tokenLabel = `#${index + 1}`.dim;
      const amountLabel = hideAmounts ? "***" : nft.amount.toString();
      const name = truncateLabel(nft.tokenName, 22);
      const tokenId = truncateLabel(nft.tokenSubID, 16);
      pushCardRow(
        display,
        `${tokenLabel} ${name}  ID:${tokenId.dim}  x${amountLabel.bold}`,
      );
    }
  }

  display.push(`${"╰".grey}${"─".repeat(BALANCE_CARD_WIDTH - 2).grey}${"╯".grey}`);
  return display.join("\n");
};
