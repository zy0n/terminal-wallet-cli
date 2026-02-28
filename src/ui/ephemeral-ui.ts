import { isDefined } from "@railgun-community/shared-models";
import {
  getCurrentKnownEphemeralState,
  getKnownEphemeralAddresses,
  getKnownEphemeralIndexForAddress,
  manualRatchetEphemeralWallet,
  setEphemeralWalletIndex,
  syncCurrentEphemeralWallet,
} from "../wallet/ephemeral-wallet-manager";
import { getSaltedPassword } from "../wallet/wallet-password";
import {
  confirmPrompt,
  confirmPromptCatch,
  confirmPromptCatchRetry,
} from "./confirm-ui";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, Input } = require("enquirer");

const formatKnownAddresses = () => {
  const known = getKnownEphemeralAddresses();
  if (known.length === 0) {
    return "No known ephemeral addresses yet.".grey;
  }

  return known
    .map(({ index, address }) => {
      return `#${index.toString().padStart(3, "0")}  ${address}`;
    })
    .join("\n");
};

const getHeader = () => {
  const state = getCurrentKnownEphemeralState();
  if (!isDefined(state)) {
    return [
      "Ephemeral Wallet Manager",
      "No ephemeral state cached yet. Sync once to initialize.",
    ].join("\n");
  }

  return [
    "Ephemeral Wallet Manager",
    `Current Index: ${state.currentIndex}`,
    `Current Address: ${state.currentAddress ?? "Unknown"}`,
    `Known Addresses: ${state.knownCount}`,
  ].join("\n");
};

const promptAddressLookup = async () => {
  const prompt = new Input({
    header: " ",
    message: "Enter ephemeral address to lookup index",
    validate: (value: string) => {
      return value.startsWith("0x") && value.length === 42;
    },
  });

  const address = (await prompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(address)) {
    return;
  }

  const index = getKnownEphemeralIndexForAddress(address);
  if (!isDefined(index)) {
    console.log("Address not found in known ephemeral cache.".yellow);
  } else {
    console.log(`Known index for ${address}: ${index}`.green);
  }
  await confirmPromptCatchRetry("");
};

export const runEphemeralManagerPrompt = async (): Promise<void> => {
  const prompt = new Select({
    header: getHeader(),
    message: "Ephemeral Wallet Tools",
    choices: [
      { name: "sync-current", message: "Sync Current Ephemeral Address" },
      { name: "manual-ratchet", message: "Ratchet to Next Index" },
      { name: "set-index", message: "Set Specific Ephemeral Index" },
      { name: "show-known", message: "Show Known Address/Index History" },
      { name: "lookup-index", message: "Lookup Index by Address" },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  switch (selection) {
    case "sync-current": {
      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runEphemeralManagerPrompt();
      }
      const synced = await syncCurrentEphemeralWallet(encryptionKey);
      if (!isDefined(synced)) {
        console.log("Failed to sync ephemeral address.".yellow);
      } else {
        console.log(
          `Synced index ${synced.currentIndex}: ${synced.currentAddress}`.green,
        );
      }
      await confirmPromptCatchRetry("");
      return runEphemeralManagerPrompt();
    }
    case "manual-ratchet": {
      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runEphemeralManagerPrompt();
      }
      const ratcheted = await manualRatchetEphemeralWallet(encryptionKey);
      if (!isDefined(ratcheted)) {
        console.log("Failed to ratchet ephemeral address.".yellow);
      } else {
        console.log(
          `Ratcheted to index ${ratcheted.currentIndex}: ${ratcheted.currentAddress}`
            .green,
        );
      }
      await confirmPromptCatchRetry("");
      return runEphemeralManagerPrompt();
    }
    case "set-index": {
      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runEphemeralManagerPrompt();
      }

      const indexPrompt = new Input({
        header: " ",
        message: "Enter ephemeral index (0 or greater)",
        validate: (value: string) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 0;
        },
      });

      const indexInput = (await indexPrompt.run().catch(confirmPromptCatch)) as
        | string
        | undefined;
      if (!isDefined(indexInput)) {
        return runEphemeralManagerPrompt();
      }

      const index = Number(indexInput);
      const confirmSetIndex = await confirmPrompt(
        `Set ephemeral index to ${index}?`,
        { initial: false },
      );
      if (!confirmSetIndex) {
        return runEphemeralManagerPrompt();
      }

      const updated = await setEphemeralWalletIndex(encryptionKey, index).catch(
        (err) => {
          console.log(`Failed to set index: ${(err as Error).message}`.yellow);
          return undefined;
        },
      );

      if (!isDefined(updated)) {
        console.log("Failed to set ephemeral index.".yellow);
      } else {
        console.log(
          `Set index ${updated.currentIndex}: ${updated.currentAddress}`.green,
        );
      }

      await confirmPromptCatchRetry("");
      return runEphemeralManagerPrompt();
    }
    case "show-known": {
      console.log(formatKnownAddresses());
      await confirmPromptCatchRetry("");
      return runEphemeralManagerPrompt();
    }
    case "lookup-index": {
      await promptAddressLookup();
      return runEphemeralManagerPrompt();
    }
    default: {
      return;
    }
  }
};
