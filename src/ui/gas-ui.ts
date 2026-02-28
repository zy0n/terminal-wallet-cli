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
    return "n/a";
  }
  const gwei = Number.parseFloat(formatUnits(value, "gwei"));
  if (!Number.isFinite(gwei)) {
    return formatUnits(value, "gwei");
  }
  return gwei >= 100
    ? gwei.toFixed(2)
    : gwei >= 1
      ? gwei.toFixed(4)
      : gwei.toFixed(6);
};

const formatNativeAmount = (value: bigint, decimals: number): string => {
  const amount = Number.parseFloat(formatUnits(value, decimals));
  if (!Number.isFinite(amount)) {
    return formatUnits(value, decimals);
  }
  if (amount >= 1) {
    return amount.toFixed(6);
  }
  if (amount >= 0.0001) {
    return amount.toFixed(8);
  }
  return amount.toExponential(2);
};

const pad = (value: string, width: number): string => {
  return value.length >= width ? value : value.padEnd(width, " ");
};

const parseGweiInput = (input: string): bigint | undefined => {
  const trimmed = input.trim();
  if (!trimmed.length) {
    return undefined;
  }
  return parseUnits(trimmed, "gwei");
};

const getSelectionLabel = (
  chainName: NetworkName,
  title: string,
  quote: GasSelectionQuote,
  gasEstimate?: bigint,
) => {
  const baseToken = NETWORK_CONFIG[chainName].baseToken;
  const perGasUnit = quote.maxFeePerGas ?? quote.gasPrice;
  const expectedCost =
    isDefined(perGasUnit) && isDefined(gasEstimate)
      ? `${formatNativeAmount(perGasUnit * gasEstimate, baseToken.decimals)} ${baseToken.symbol}`
      : "n/a";

  const gasPrice = formatGwei(quote.gasPrice);
  const maxFee = formatGwei(quote.maxFeePerGas);
  const maxPriority = formatGwei(quote.maxPriorityFeePerGas);
  return `${pad(title, 12).yellow} ${pad(gasPrice, 12).cyan} ${pad(maxFee, 12).cyan} ${pad(maxPriority, 12).cyan} ${expectedCost.cyan}`;
};

const getMatrixHeader = () => {
  return `${pad("Preset", 12).bold} ${pad("GasPrice", 12).bold} ${pad("MaxFee", 12).bold} ${pad("Tip", 12).bold} ${"Expected".bold}`;
};

export const runGasFeeSelectionPrompt = async (
  chainName: NetworkName,
  gasEstimate?: bigint,
): Promise<boolean> => {
  const quotes = await getGasSelectionQuotes(chainName);

  const speedChoices = quotes.supportsSpeedPresets
    ? [
        {
          name: "slow",
          message: getSelectionLabel(chainName, "Slow", quotes.slow, gasEstimate),
        },
        {
          name: "average",
          message: getSelectionLabel(chainName, "Average", quotes.average, gasEstimate),
        },
        {
          name: "fast",
          message: getSelectionLabel(chainName, "Fast", quotes.fast, gasEstimate),
        },
      ]
    : [];

  const speedPrompt = new Select({
    header: " ",
    message: "Gas Fee Speed / Price",
    choices: [
      {
        name: "header-columns",
        message: getMatrixHeader().grey,
        role: "separator",
      },
      {
        name: "header-divider",
        message: `${"-".repeat(66)}`.grey,
        role: "separator",
      },
      {
        name: "recommended",
        message: getSelectionLabel(
          chainName,
          "Recommended",
          quotes.recommended,
          gasEstimate,
        ),
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
