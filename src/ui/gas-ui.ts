import "colors";
import { EVMGasType, NETWORK_CONFIG, NetworkName, isDefined } from "@railgun-community/shared-models";
import { formatUnits, parseUnits } from "ethers";
import {
  GasFeeSelection,
  GasSelectionQuote,
  getGasSelectionQuotes,
  setGasFeeSelectionForChain,
} from "../gas/gas-util";
import { confirmPromptCatch } from "./confirm-ui";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, Input } = require("enquirer");

const formatGwei = (value?: bigint) => {
  if (!isDefined(value)) {
    return "n/a".grey;
  }
  return `${formatUnits(value, "gwei")} gwei`.cyan;
};

const parseGweiInput = (input: string): bigint | undefined => {
  const trimmed = input.trim();
  if (!trimmed.length) {
    return undefined;
  }
  return parseUnits(trimmed, "gwei");
};

const getSelectionLabel = (title: string, quote: GasSelectionQuote) => {
  const gasPrice = formatGwei(quote.gasPrice);
  const maxFee = formatGwei(quote.maxFeePerGas);
  const maxPriority = formatGwei(quote.maxPriorityFeePerGas);
  return `${title}: gasPrice ${gasPrice} | maxFee ${maxFee} | tip ${maxPriority}`;
};

export const runGasFeeSelectionPrompt = async (
  chainName: NetworkName,
): Promise<boolean> => {
  const quotes = await getGasSelectionQuotes(chainName);

  const speedChoices = quotes.supportsSpeedPresets
    ? [
        {
          name: "slow",
          message: getSelectionLabel("Slow", quotes.slow),
        },
        {
          name: "average",
          message: getSelectionLabel("Average", quotes.average),
        },
        {
          name: "fast",
          message: getSelectionLabel("Fast", quotes.fast),
        },
      ]
    : [];

  const speedPrompt = new Select({
    header: " ",
    message: "Gas Fee Speed / Price",
    choices: [
      {
        name: "recommended",
        message: getSelectionLabel("Recommended", quotes.recommended),
      },
      ...speedChoices,
      {
        name: "custom",
        message: "Custom gas values".yellow,
      },
      {
        name: "cancel",
        message: "Keep current selection".grey,
      },
    ],
    multiple: false,
  });

  const selection = await speedPrompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "cancel") {
    return false;
  }

  if (selection !== "custom") {
    setGasFeeSelectionForChain(chainName, {
      preset: selection,
    } as GasFeeSelection);
    return true;
  }

  const { defaultEVMGasType } = NETWORK_CONFIG[chainName];
  const defaults = quotes.recommended;

  const gasPricePrompt = new Input({
    header: " ",
    message: "Gas Price (gwei, leave blank to keep default)",
    initial: formatUnits(defaults.gasPrice ?? 0n, "gwei"),
  });

  const maxFeePrompt = new Input({
    header: " ",
    message: "Max Fee Per Gas (gwei, leave blank to keep default)",
    initial: formatUnits(defaults.maxFeePerGas ?? 0n, "gwei"),
  });

  const maxPriorityPrompt = new Input({
    header: " ",
    message: "Max Priority Fee (gwei, leave blank to keep default)",
    initial: formatUnits(defaults.maxPriorityFeePerGas ?? 0n, "gwei"),
  });

  const gasPriceInput =
    defaultEVMGasType === EVMGasType.Type0 || defaultEVMGasType === EVMGasType.Type1
      ? await gasPricePrompt.run().catch(confirmPromptCatch)
      : "";

  const maxFeeInput =
    defaultEVMGasType === EVMGasType.Type2 || defaultEVMGasType === EVMGasType.Type4
      ? await maxFeePrompt.run().catch(confirmPromptCatch)
      : "";

  const maxPriorityInput =
    defaultEVMGasType === EVMGasType.Type2 || defaultEVMGasType === EVMGasType.Type4
      ? await maxPriorityPrompt.run().catch(confirmPromptCatch)
      : "";

  setGasFeeSelectionForChain(chainName, {
    preset: "custom",
    gasPrice: parseGweiInput(gasPriceInput ?? "") ?? defaults.gasPrice,
    maxFeePerGas: parseGweiInput(maxFeeInput ?? "") ?? defaults.maxFeePerGas,
    maxPriorityFeePerGas:
      parseGweiInput(maxPriorityInput ?? "") ?? defaults.maxPriorityFeePerGas,
  });

  return true;
};
