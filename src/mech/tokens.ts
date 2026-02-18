import { NetworkName } from "@railgun-community/shared-models";
import {
  tokenAmountSelectionPrompt,
  tokenSelectionPrompt,
} from "../ui/token-ui";
import { Balances } from "./pilot";
import {
  getERC20AddressesForChain,
  getERC20Balance,
  getTokenInfo,
} from "../balance/token-util";
import { RailgunDisplayBalance } from "../models/balance-models";
import { formatUnits } from "ethers";
import {
  getDisplayStringFromBalance,
  getMaxBalanceLength,
  getMaxSymbolLengthFromBalances,
} from "../balance/balance-util";
import { confirmPromptCatch } from "../ui/confirm-ui";
import { delay } from "../util/util";

export const promptTokenBalances = async (
  chainName: NetworkName,
  mechAddress: string,
): Promise<Balances> => {
  const selections = await tokenSelectionPrompt(
    chainName,
    `Select tokens to move into the mech`,
    true, // select multiple tokens
  );

  const amountSelections = await tokenAmountSelectionPrompt(
    selections,
    false, // private transfer
    true, // single recipient
    false, // not a shield event
    mechAddress, // don't ask for recipient address
  );

  return amountSelections.reduce((acc, selection) => {
    acc[selection.tokenAddress as `0x${string}`] = selection.selectedAmount;
    return acc;
  }, {} as Balances);
};

export const promptMechBalances = async (
  chainName: NetworkName,
  mechAddress: string,
): Promise<Balances> => {
  // Discover ERC20 balances held by the mech address on-chain
  const addresses = getERC20AddressesForChain(chainName);
  const mechBalances: RailgunDisplayBalance[] = [];
  console.log("Scanning mech balances....".yellow);

  for (const tokenAddress of addresses) {
    try {
      const amount = await getERC20Balance(
        chainName,
        tokenAddress,
        mechAddress,
      );
      if (amount > 0n) {
        const { name, symbol, decimals } = await getTokenInfo(
          chainName,
          tokenAddress,
        );
        mechBalances.push({ tokenAddress, amount, decimals, name, symbol });
      }
    } catch (err) {
      // Skip tokens that fail to query — don't block the rest
    }
    await delay(500);
  }

  if (mechBalances.length === 0) {
    console.log("The mech has no ERC20 balances at this time.".yellow);
    return {} as Balances;
  }

  const maxSymbolLength = getMaxSymbolLengthFromBalances(mechBalances);
  const maxBalanceLength = getMaxBalanceLength(mechBalances);

  const { Select } = require("enquirer");
  const choices = mechBalances.map((bal, i) => ({
    name: `${i}`,
    value: `${i}`,
    message: getDisplayStringFromBalance(bal, maxBalanceLength, maxSymbolLength),
    disabled: bal.amount <= 0n,
  }));

  const prompt = new Select({
    format() {
      if (!this.state.submitted || this.state.cancelled) return "";
      if (Array.isArray(this.selected)) {
        return this.selected
          .map((choice: any) => this.styles.primary(choice.message))
          .join(", ");
      }
      return this.styles.primary(this.selected.message);
    },
    emptyError: "No tokens selected",
    header: " ",
    hint: "(Use <space> to select, <return> to submit)",
    message: "Select tokens to withdraw from the mech",
    choices,
    multiple: true,
  });

  const result = await prompt.run().catch(confirmPromptCatch);
  if (!result || result === false || result.length === 0) {
    return {} as Balances;
  }

  const selectedBalances = (result as string[]).map(
    (i) => mechBalances[parseInt(i)],
  );

  if (selectedBalances.some((bal) => !bal)) {
    console.log("Invalid selection detected.".red);
    return {} as Balances;
  }

  const readableSelections = selectedBalances.map((bal) => ({
    tokenAddress: bal.tokenAddress,
    amount: bal.amount,
    symbol: bal.symbol,
    name: bal.name,
    decimals: bal.decimals,
    amountReadable: formatUnits(bal.amount, bal.decimals),
  }));

  let amountSelections;
  try {
    amountSelections = await tokenAmountSelectionPrompt(
      readableSelections,
      false, // not a public transfer
      true, // single recipient
      true, // is a shield event
    );
  } catch (err) {
    // User cancelled during amount/address entry
    return {} as Balances;
  }

  if (!amountSelections || amountSelections.length === 0) {
    return {} as Balances;
  }

  return amountSelections.reduce((acc, selection) => {
    acc[selection.tokenAddress as `0x${string}`] = selection.selectedAmount;
    return acc;
  }, {} as Balances);
};