import {
  NetworkName,
  RailgunERC20AmountRecipient,
  SelectedBroadcaster,
  isDefined,
} from "@railgun-community/shared-models";
import { delay } from "../util/util";
import { formatUnits, parseUnits } from "ethers";
import { getWakuClient } from "../waku/connect-waku";
import {
  addRemovedBroadcaster,
  resetBroadcasterFilters,
} from "../waku/broadcaster-util";
import {
  getDisplayStringFromBalance,
  getMaxBalanceLength,
  getMaxSymbolLengthFromBalances,
  getPrivateERC20BalancesForChain,
  getPublicERC20BalancesForAddress,
  getPublicERC20BalancesForChain,
} from "../balance/balance-util";
import {
  RailgunDisplayBalance,
  RailgunReadableAmount,
  RailgunSelectedAmount,
} from "../models/balance-models";
import { getChainForName } from "../network/network-util";
import { getTokenInfo } from "../balance/token-util";

const { Select, Input, NumberPrompt } = require("enquirer");
import {
  confirmPromptCatch,
  confirmPrompt,
  confirmPromptCatchRetry,
  confirmPromptCatchMessage,
} from "./confirm-ui";
import { validateEthAddress } from "@railgun-community/wallet";
import { updatePublicBalancesForChain } from "../balance/balance-cache";
import {
  runInputPublicAddress,
  runInputRailgunAddress,
} from "./known-address-ui";
import { getFormattedAddress } from "./address-ui";

export const tokenSelectionPrompt = async (
  chainName: NetworkName,
  display: string = "Token Selection",
  multiple: boolean = true,
  publicBalances: boolean = false,
  amountRecipients?: RailgunERC20AmountRecipient[],
  addGasToken: boolean = false,
  publicAddressOverride?: string,
) => {
  const balances = publicBalances
    ? isDefined(publicAddressOverride)
      ? await getPublicERC20BalancesForAddress(
        chainName,
        publicAddressOverride,
        publicBalances && addGasToken,
      )
      : await getPublicERC20BalancesForChain(
        chainName,
        publicBalances && addGasToken,
      )
    : await getPrivateERC20BalancesForChain(chainName);

  if (balances.length === 0) {
    await confirmPromptCatchRetry(
      "There are no spendable balances at this time. ".red,
    );
    return multiple ? [] : undefined;
  }

  const maxSymbolLength = getMaxSymbolLengthFromBalances(balances);
  const maxBalanceLength = getMaxBalanceLength(balances);
  const names = balances.map((bal: RailgunDisplayBalance, i) => {
    let spentBalance = 0n;
    amountRecipients?.forEach((tokenInfo) => {
      if (
        tokenInfo.tokenAddress.toLowerCase() === bal.tokenAddress.toLowerCase()
      ) {
        spentBalance += tokenInfo.amount;
      }
    });

    const newAmount = bal.amount - spentBalance;
    bal.amount = newAmount;
    const balanceDisplayString = getDisplayStringFromBalance(
      bal,
      maxBalanceLength,
      maxSymbolLength,
    );
    return {
      value: `${i}`,
      disabled: newAmount <= 0n,
      message: balanceDisplayString,
    };
  });

  if (names.length === 0) {
    console.log("There are no tokens available to use for fees. ");
    return undefined;
  }

  const prompt = new Select({
    format() {
      if (!this.state.submitted || this.state.cancelled) return "";
      if (Array.isArray(this.selected)) {
        return this.selected
          .map((choice: any) =>
            this.styles.primary(choice.message.split("]")[1].trim()),
          )
          .join(", ");
      }
      return this.styles.primary(this.selected.message.split("]")[1].trim());
    },
    emptyError: "No ERC20s Selected",
    header: " ",
    hint: multiple
      ? "(Use <space> to select, <return> to submit)"
      : "(Use <return> to select)",
    message: display,
    choices: names,
    multiple,
  });

  const result = await prompt.run().catch(confirmPromptCatch);

  if (result) {
    if (multiple) {
      const selections = result?.map((i: number) => {
        return balances[i];
      });
      return selections;
    }
    return balances[parseInt(result)];
  }
  return multiple ? [] : undefined;
};

export const feeTokenSelectionPrompt = async (
  chainName: NetworkName,
  publicBalances: boolean = false,
  amountRecipients: RailgunERC20AmountRecipient[],
) => {
  const selection = await tokenSelectionPrompt(
    chainName,
    "Fee Token Selection",
    false,
    publicBalances,
    amountRecipients,
  );

  return selection;
};

export const runFeeTokenSelector = async (
  chainName: NetworkName,
  amountRecipients: RailgunERC20AmountRecipient[],
  currentBroadcaster?: SelectedBroadcaster,
  use7702Only: boolean = false,
): Promise<{ bestBroadcaster: SelectedBroadcaster } | undefined> => {
  const formatFeeRatioToOneEth = (feePerUnitGas: string) => {
    const ratio = parseFloat(formatUnits(BigInt(feePerUnitGas), 18));
    return ratio.toFixed(6);
  };

  const getBroadcasterChoicesForToken = (
    broadcasters: SelectedBroadcaster[],
    feeTokenSymbol: string,
  ) => {
    return broadcasters.map((broadcaster, index) => {
      const shortAddress = getFormattedAddress(broadcaster.railgunAddress);
      const reliabilityPct = Math.round((broadcaster.tokenFee.reliability ?? 0) * 100);
      const feeRatioToOneEth = formatFeeRatioToOneEth(
        broadcaster.tokenFee.feePerUnitGas,
      );
      return {
        name: `${index}`,
        message: `${shortAddress.cyan}  1 ETH: ${`${feeRatioToOneEth} ${feeTokenSymbol}`.yellow}  reliability: ${`${reliabilityPct}%`.green}  wallets: ${broadcaster.tokenFee.availableWallets}`,
      };
    });
  };

  const broadcasterSelectionPrompt = async (feeTokenAddress: string) => {
    const waku = getWakuClient();
    const chain = getChainForName(chainName);
    const broadcasters = waku.findBroadcastersForToken(
      chain,
      feeTokenAddress.toLowerCase(),
      true,
      use7702Only,
    );

    if (!isDefined(broadcasters) || broadcasters.length === 0) {
      return undefined;
    }

    return [...broadcasters].sort((a, b) => {
      const feeA = BigInt(a.tokenFee.feePerUnitGas);
      const feeB = BigInt(b.tokenFee.feePerUnitGas);
      return feeA < feeB ? -1 : feeA > feeB ? 1 : 0;
    })[0];
  };

  const manualBroadcasterSelectionPrompt = async (feeTokenAddress: string) => {
    const waku = getWakuClient();
    const chain = getChainForName(chainName);
    const feeTokenInfo = await getTokenInfo(chainName, feeTokenAddress).catch(
      () => undefined,
    );
    const feeTokenSymbol = feeTokenInfo?.symbol ?? "TOKEN";

    const broadcasters = waku.findBroadcastersForToken(
      chain,
      feeTokenAddress.toLowerCase(),
      true,
      use7702Only,
    );

    if (!isDefined(broadcasters) || broadcasters.length === 0) {
      return undefined;
    }

    const ordered = [...broadcasters].sort((a, b) => {
      const feeA = BigInt(a.tokenFee.feePerUnitGas);
      const feeB = BigInt(b.tokenFee.feePerUnitGas);
      return feeA < feeB ? -1 : feeA > feeB ? 1 : 0;
    });

    const prompt = new Select({
      header: " ",
      message: "Select Broadcaster",
      choices: [
        ...getBroadcasterChoicesForToken(ordered, feeTokenSymbol),
        { name: "go-back", message: "Go Back".grey },
      ],
      multiple: false,
    });

    const selected = await prompt.run().catch(confirmPromptCatch);
    if (!selected || selected === "go-back") {
      return undefined;
    }

    return ordered[parseInt(selected, 10)];
  };

  const autoSelectFeeTokenAndBroadcaster = async () => {
    const balances = await getPrivateERC20BalancesForChain(chainName);
    const waku = getWakuClient();
    const chain = getChainForName(chainName);

    let bestBroadcaster: SelectedBroadcaster | undefined;
    for (const balance of balances) {
      let spentBalance = 0n;
      amountRecipients.forEach((tokenInfo) => {
        if (
          tokenInfo.tokenAddress.toLowerCase() ===
          balance.tokenAddress.toLowerCase()
        ) {
          spentBalance += tokenInfo.amount;
        }
      });

      const availableAmount = balance.amount - spentBalance;
      if (availableAmount <= 0n) {
        continue;
      }

      const broadcasters = waku.findBroadcastersForToken(
        chain,
        balance.tokenAddress.toLowerCase(),
        true,
        use7702Only,
      );

      if (!isDefined(broadcasters) || broadcasters.length === 0) {
        continue;
      }

      const cheapestForToken = [...broadcasters].sort((a, b) => {
        const feeA = BigInt(a.tokenFee.feePerUnitGas);
        const feeB = BigInt(b.tokenFee.feePerUnitGas);
        return feeA < feeB ? -1 : feeA > feeB ? 1 : 0;
      })[0];

      if (!bestBroadcaster) {
        bestBroadcaster = cheapestForToken;
        continue;
      }

      const currentBest = BigInt(bestBroadcaster.tokenFee.feePerUnitGas);
      const nextBest = BigInt(cheapestForToken.tokenFee.feePerUnitGas);
      if (nextBest < currentBest) {
        bestBroadcaster = cheapestForToken;
      }
    }

    return bestBroadcaster;
  };

  const additionalChoices = currentBroadcaster
    ? [
        {
          name: "different-broadcaster",
          message: "Select Different Broadcaster".grey,
        },
        {
          name: "clear-broadcaster-list",
          message: "Clear Broadcaster Address Blocklist".grey,
        },
      ]
    : [];
  const feeTokenOptionPrompt = new Select({
    header: " ",
    message: "Transaction Fee Options",
    choices: [
      {
        name: "relayed-full-auto",
        message: "Use Broadcaster (Full-auto)",
      },
      {
        name: "relayed-token-auto",
        message: "Use Broadcaster (Select token & auto broadcaster)",
      },
      {
        name: "relayed-manual",
        message: "Use Broadcaster (Manual)",
      },
      {
        name: "self-signed",
        message: `Self Sign Transaction ${"Self-Broadcast".yellow}`,
      },
      ...additionalChoices,
      { name: "go-back", message: "Cancel Selection".grey },
    ],
    multiple: false,
  });
  const feeOption = await feeTokenOptionPrompt.run().catch(confirmPromptCatch);
  if (feeOption) {
    let feeTokenAddress;

    switch (feeOption) {
      case "different-broadcaster": {
        if (currentBroadcaster) {
          feeTokenAddress = currentBroadcaster.tokenAddress;
          addRemovedBroadcaster(currentBroadcaster.railgunAddress);
        }
        // WANT THIS FALL THROUGH here
      }
      case "relayed-manual": {
        {
          if (feeOption !== "different-broadcaster") {
            const feeToken = await feeTokenSelectionPrompt(
              chainName,
              false,
              amountRecipients,
            );
            if (!feeToken) {
              console.log("THROWING ERROR WHY?");
              return runFeeTokenSelector(
                chainName,
                amountRecipients,
                currentBroadcaster,
                use7702Only,
              );
            }
            feeTokenAddress = feeToken.tokenAddress;
          }
          try {
            const bestBroadcaster = await manualBroadcasterSelectionPrompt(
              feeTokenAddress,
            );
            if (bestBroadcaster) {
              return { bestBroadcaster };
            }
            console.log("No Broadcasters Found for Token".yellow);
            return runFeeTokenSelector(
              chainName,
              amountRecipients,
              currentBroadcaster,
              use7702Only,
            );
          } catch (err) {
            console.log(err);
          }
        }
        break;
      }
      case "relayed-token-auto": {
        const feeToken = await feeTokenSelectionPrompt(
          chainName,
          false,
          amountRecipients,
        );
        if (!feeToken) {
          return runFeeTokenSelector(
            chainName,
            amountRecipients,
            currentBroadcaster,
            use7702Only,
          );
        }
        try {
          const bestBroadcaster = await broadcasterSelectionPrompt(
            feeToken.tokenAddress,
          );
          if (bestBroadcaster) {
            return { bestBroadcaster };
          }
          console.log("No Broadcasters Found for Selected Fee Token".yellow);
          return runFeeTokenSelector(
            chainName,
            amountRecipients,
            currentBroadcaster,
            use7702Only,
          );
        } catch (err) {
          console.log(err);
        }
        break;
      }
      case "relayed-full-auto": {
        try {
          const bestBroadcaster = await autoSelectFeeTokenAndBroadcaster();
          if (bestBroadcaster) {
            return { bestBroadcaster };
          }
          console.log("No Broadcasters Found for Available Fee Tokens".yellow);
          return runFeeTokenSelector(
            chainName,
            amountRecipients,
            currentBroadcaster,
            use7702Only,
          );
        } catch (err) {
          console.log(err);
        }
        break;
      }
      case "self-signed": {
        return undefined;
      }
      case "clear-broadcaster-list": {
        resetBroadcasterFilters();
        return runFeeTokenSelector(
          chainName,
          amountRecipients,
          undefined,
          use7702Only,
        );
      }
      case "go-back": {
        throw new Error("Going back to previous menu.");
      }
    }
  } else {
    throw new Error("No Fee Selection Made");
  }
};

export const getTokenAmountSelectionPrompt = async (
  token: RailgunReadableAmount,
  currentBalance: string,
  recipientAddress?: string,
): Promise<string | undefined> => {
  const recipentString = isDefined(recipientAddress)
    ? `Recipient: ${getFormattedAddress(recipientAddress)}\n`
    : "";

  const selectionHeader = `
  `;
  const prompt = new Input({
    header: `\nHow much ${token.name.cyan} do you wish to transfer?\n${
      recipentString.cyan
    }Your Balance: ${currentBalance.toString().yellow}\n`,
    message: `${token.symbol}:`,
    min: 0,
    initial: currentBalance,
    max: currentBalance,
    result(value: string) {
      return parseUnits(value, token.decimals) <
        parseUnits(currentBalance, token.decimals)
        ? value
        : currentBalance;
    },
    validate(value: string) {
      return (
        typeof value !== "undefined" && parseUnits(value, token.decimals) > 0
      );
    },
  });
  const result = await prompt.run().catch(async (err: any) => {
    await confirmPromptCatchMessage(
      `[${token.symbol.cyan}] Transfer Skipped. `,
    );
  });

  if (result === false) {
    return undefined;
  }

  return result;
};

export const runTokenAmountSelection = async (
  currentBalance: string,
  token: RailgunReadableAmount,
  publicTransfer: boolean,
  isShieldEvent = false,
  recipientAddress?: string,
): Promise<RailgunSelectedAmount | undefined> => {
  if (!recipientAddress) {
    recipientAddress = publicTransfer
      ? await runInputPublicAddress(`[${token.symbol}] `, isShieldEvent)
      : await runInputRailgunAddress(`[${token.symbol}] `, isShieldEvent);

    if (!recipientAddress) {
      return undefined;
    }
  }

  const result = await getTokenAmountSelectionPrompt(
    token,
    currentBalance,
    recipientAddress,
  );
  if (!isDefined(result)) {
    return undefined;
  }
  const newSelection = {
    ...token,
    selectedAmount: parseUnits(result, token.decimals),
    recipientAddress,
  };
  return newSelection;
};

export const tokenAmountSelectionPrompt = async (
  balances: RailgunReadableAmount[],
  publicTransfer: boolean,
  singleTransfer = false,
  isShieldEvent = false,
  recipientAddress?: string,
): Promise<RailgunSelectedAmount[]> => {
  const selections = [];

  const addressType = publicTransfer ? "[0x]" : "[0zk]";
  const transferType = publicTransfer ? "PUBLIC" : "PRIVATE";

  try {
    for (const bal of balances) {
      const { symbol } = bal;
      let currentBalance = bal.amount;
      let currentMax = formatUnits(currentBalance, bal.decimals);

      let completed = false;
      while (!completed) {
        currentMax = formatUnits(currentBalance, bal.decimals);
        const selection = await runTokenAmountSelection(
          currentMax,
          bal,
          publicTransfer,
          isShieldEvent,
          recipientAddress,
        );
        if (selection) {
          currentBalance = currentBalance - selection.selectedAmount;
          const newSelection = { ...selection, amount: currentBalance };
          selections.push(newSelection);
          if (!singleTransfer && currentBalance > 0n) {
            const addAddress = await confirmPrompt(
              `Add another ${addressType} ${transferType} address to this ${symbol} transfer?`,
            );
            completed = !addAddress;
          } else {
            completed = true;
          }
        } else {
          completed = true;
        }
        await delay(200);
      }
    }
  } catch (err: any) {
    /* empty */
  }
  return selections;
};

export const transferTokenAmountSelectionPrompt = async (
  chainName: NetworkName,
  publicBalances = false,
  publicTransfer = false,
  singleAddressSelection = false,
  isShieldEvent = false,
) => {
  const transferType = publicBalances ? "Publicly" : "Privately";
  const selections = await tokenSelectionPrompt(
    chainName,
    `Send ERC20 Tokens ${transferType}`,
    true,
    publicBalances,
  );

  const amountSelections = await tokenAmountSelectionPrompt(
    selections,
    publicTransfer,
    singleAddressSelection,
    isShieldEvent,
  );
  return { amountSelections };
};

export const runAddTokenPrompt = async (
  chainName: NetworkName,
): Promise<void> => {
  const prompt = new Input({
    header: " ",
    message: `Please enter Token Address.`,
    validate: (value: string) => {
      return validateEthAddress(value);
    },
  });

  const resultAddress = await prompt.run().catch(confirmPromptCatch);

  if (resultAddress) {
    try {
      console.log("Collecting Token Info...".yellow);
      await getTokenInfo(chainName, resultAddress);
      console.log("Updating Balance.".yellow);
      await updatePublicBalancesForChain(chainName);
      return;
    } catch (error) {
      console.log("Unable to get Token Info from Address provided.");
    }
  }

  const confirm = await confirmPrompt(
    `Unable to get Token Info from Address provided. Would you like to try again?`,
    {
      initial: true,
    },
  ).catch(confirmPromptCatch);

  if (confirm) {
    return runAddTokenPrompt(chainName);
  }
};
