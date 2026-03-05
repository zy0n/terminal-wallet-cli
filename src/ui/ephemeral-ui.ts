import { isDefined } from "@railgun-community/shared-models";
import {
  activateScopedEphemeralWalletDerivationStrategy,
  getCurrentKnownEphemeralState,
  hasScopedEphemeralWalletDerivationStrategy,
  getKnownEphemeralAddresses,
  getKnownEphemeralIndexForAddress,
  listEphemeralSessionScopes,
  listScopedEphemeralWalletDerivationStrategyScopeIDs,
  manualRatchetEphemeralWallet,
  removeEphemeralSessionScope,
  setEphemeralSessionRatchetPolicy,
  setEphemeralWalletIndex,
  syncCurrentEphemeralWallet,
  upsertEphemeralSessionScope,
} from "../wallet/ephemeral-wallet-manager";
import { RailgunTransaction } from "../models/transaction-models";
import { getSaltedPassword } from "../wallet/wallet-password";
import {
  confirmPrompt,
  confirmPromptCatch,
  confirmPromptCatchRetry,
} from "./confirm-ui";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, Input } = require("enquirer");

const transactionChoices = Object.values(RailgunTransaction).map((name) => ({
  name,
  message: name,
}));

type ScopeSelection = {
  aborted: boolean;
  scopeID?: string;
};

const shortAddress = (address?: string) => {
  if (!isDefined(address) || address.length < 12) {
    return "unknown";
  }
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
};

const slotToScopeID = (slot: number) => {
  return `slot-${slot}`;
};

const promptOptionalScopeSelection = async (): Promise<ScopeSelection> => {
  const modePrompt = new Select({
    header: " ",
    message: "Stealth scope context",
    choices: [
      { name: "global", message: "Global (no scope)" },
      { name: "scope", message: "Named scope ID" },
      { name: "slot", message: "Slot number (maps to scope slot-<n>)" },
      { name: "cancel", message: "Cancel".grey },
    ],
    multiple: false,
  });

  const mode = await modePrompt.run().catch(confirmPromptCatch);
  if (!mode || mode === "cancel") {
    return { aborted: true };
  }
  if (mode === "global") {
    return { aborted: false, scopeID: undefined };
  }

  if (mode === "slot") {
    const slotPrompt = new Input({
      header: " ",
      message: "Slot number (0 or greater)",
      validate: (value: string) => {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 0;
      },
    });

    const slotInput = (await slotPrompt.run().catch(confirmPromptCatch)) as
      | string
      | undefined;
    if (!isDefined(slotInput)) {
      return { aborted: true };
    }

    return { aborted: false, scopeID: slotToScopeID(Number(slotInput)) };
  }

  const scopePrompt = new Input({
    header: " ",
    message: "Scope ID",
    validate: (value: string) => value.trim().length > 0,
  });

  const scopeInput = (await scopePrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(scopeInput)) {
    return { aborted: true };
  }

  return { aborted: false, scopeID: scopeInput.trim() };
};

const formatKnownAddresses = () => {
  const known = getKnownEphemeralAddresses();
  if (known.length === 0) {
    return "No known stealth accounts yet.".grey;
  }

  return known
    .map(({ index, address }) => {
      return `slot #${index.toString().padStart(3, "0")}  ${address}`;
    })
    .join("\n");
};

const formatKnownScopes = () => {
  const scopes = listEphemeralSessionScopes();
  if (!scopes.length) {
    return "No stealth scopes configured.".grey;
  }

  return scopes
    .map((scope) => {
      const txs = scope.policy.ratchetOnTransactions.join(", ") || "none";
      const strategyStatus = hasScopedEphemeralWalletDerivationStrategy(scope.scopeID)
        ? "strategy=attached".green
        : "strategy=none".yellow;
      return [
        `${scope.scopeID}`.cyan,
        `index=${scope.lastKnownIndex ?? "n/a"}`,
        `address=${shortAddress(scope.lastKnownAddress)}`,
        `ratchets=${scope.ratchetCount}`,
        `mode=${scope.policy.broadcastMode}`,
        `enabled=${scope.policy.enabled ? "yes" : "no"}`,
        `tx=[${txs}]`,
        strategyStatus,
      ].join(" · ");
    })
    .join("\n");
};

const getHeader = () => {
  const state = getCurrentKnownEphemeralState();
  const scopeCount = listEphemeralSessionScopes().length;
  const strategyCount = listScopedEphemeralWalletDerivationStrategyScopeIDs().length;
  if (!isDefined(state)) {
    return [
      "Stealth Account Manager",
      `Scopes: ${scopeCount} | Signer Strategies: ${strategyCount}`,
      "No stealth account state cached yet. Sync once to initialize.",
    ].join("\n");
  }

  return [
    "Stealth Account Manager",
    `Current Slot: ${state.currentIndex}`,
    `Current Stealth Address: ${state.currentAddress ?? "Unknown"}`,
    `Known Slots: ${state.knownCount} | Scopes: ${scopeCount} | Signer Strategies: ${strategyCount}`,
  ].join("\n");
};

const promptAddressLookup = async () => {
  const prompt = new Input({
    header: " ",
    message: "Enter stealth address to lookup slot",
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
    console.log("Address not found in known stealth cache.".yellow);
  } else {
    console.log(`Known slot for ${address}: ${index}`.green);
  }
  await confirmPromptCatchRetry("");
};

const promptAndApplyScopePolicy = async () => {
  const scopeSelection = await promptOptionalScopeSelection();
  if (scopeSelection.aborted || !isDefined(scopeSelection.scopeID)) {
    return;
  }

  upsertEphemeralSessionScope(scopeSelection.scopeID);

  const enabled = await confirmPrompt("Enable ratcheting for this scope?", {
    initial: true,
  });

  const modePrompt = new Select({
    header: " ",
    message: "Ratcheting broadcast mode",
    choices: [
      { name: "any", message: "Any transaction mode" },
      { name: "broadcasted-only", message: "Broadcasted-only" },
      { name: "self-signed-only", message: "Self-signed-only" },
    ],
    multiple: false,
  });
  const mode = await modePrompt.run().catch(confirmPromptCatch);
  if (!isDefined(mode)) {
    return;
  }

  const txPrompt = new Select({
    header: " ",
    message: "Transactions that should ratchet",
    choices: transactionChoices,
    multiple: true,
  });

  const txSelection = (await txPrompt.run().catch(confirmPromptCatch)) as
    | string[]
    | undefined;
  if (!isDefined(txSelection) || !txSelection.length) {
    console.log("At least one transaction type is required for ratcheting.".yellow);
    await confirmPromptCatchRetry("");
    return;
  }

  setEphemeralSessionRatchetPolicy(scopeSelection.scopeID, {
    enabled,
    broadcastMode: mode,
    ratchetOnTransactions: txSelection,
  });
  console.log(`Updated scope policy for ${scopeSelection.scopeID}.`.green);
  await confirmPromptCatchRetry("");
};

const runScopeManagerPrompt = async (): Promise<void> => {
  const prompt = new Select({
    header: ["Stealth Scope Manager", formatKnownScopes()].join("\n\n"),
    message: "Stealth Scope Tools",
    choices: [
      { name: "list", message: "List Scopes" },
      { name: "upsert-policy", message: "Create/Update Scope Ratchet Policy" },
      { name: "remove", message: "Remove Scope" },
      { name: "activate-signer", message: "Activate Scope Signer Strategy" },
      { name: "show-strategy-scopes", message: "Show Scopes with Signer Strategies" },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  switch (selection) {
    case "list": {
      console.log(formatKnownScopes());
      await confirmPromptCatchRetry("");
      return runScopeManagerPrompt();
    }
    case "upsert-policy": {
      await promptAndApplyScopePolicy();
      return runScopeManagerPrompt();
    }
    case "remove": {
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted || !isDefined(scopeSelection.scopeID)) {
        return runScopeManagerPrompt();
      }

      const confirmed = await confirmPrompt(
        `Remove stealth scope ${scopeSelection.scopeID}?`,
        { initial: false },
      );
      if (!confirmed) {
        return runScopeManagerPrompt();
      }

      const removed = removeEphemeralSessionScope(scopeSelection.scopeID);
      console.log(
        removed
          ? `Removed scope ${scopeSelection.scopeID}.`.green
          : `Scope ${scopeSelection.scopeID} was not found.`.yellow,
      );
      await confirmPromptCatchRetry("");
      return runScopeManagerPrompt();
    }
    case "activate-signer": {
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted || !isDefined(scopeSelection.scopeID)) {
        return runScopeManagerPrompt();
      }

      const hasStrategy = hasScopedEphemeralWalletDerivationStrategy(
        scopeSelection.scopeID,
      );
      if (!hasStrategy) {
        console.log(
          `No scoped signer strategy registered for ${scopeSelection.scopeID}.`
            .yellow,
        );
        await confirmPromptCatchRetry("");
        return runScopeManagerPrompt();
      }

      activateScopedEphemeralWalletDerivationStrategy(scopeSelection.scopeID);
      console.log(
        `Activated scoped signer strategy for ${scopeSelection.scopeID}.`.green,
      );
      await confirmPromptCatchRetry("");
      return runScopeManagerPrompt();
    }
    case "show-strategy-scopes": {
      const strategyScopes = listScopedEphemeralWalletDerivationStrategyScopeIDs();
      if (!strategyScopes.length) {
        console.log("No scoped signer strategies registered yet.".yellow);
      } else {
        console.log(strategyScopes.map((scopeID) => `${scopeID}`.cyan).join("\n"));
      }
      await confirmPromptCatchRetry("");
      return runScopeManagerPrompt();
    }
    default: {
      return;
    }
  }
};

export const runEphemeralManagerPrompt = async (): Promise<void> => {
  const prompt = new Select({
    header: getHeader(),
    message: "Stealth Account Tools",
    choices: [
      { name: "sync-current", message: "Sync Current Stealth Account" },
      { name: "manual-ratchet", message: "Ratchet to Next Stealth Slot" },
      { name: "set-index", message: "Set Specific Stealth Slot" },
      { name: "show-known", message: "Show Known Stealth Slots" },
      { name: "lookup-index", message: "Lookup Slot by Address" },
      { name: "manage-scopes", message: "Manage Stealth Scopes & Policies" },
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
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted) {
        return runEphemeralManagerPrompt();
      }

      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runEphemeralManagerPrompt();
      }
      const synced = await syncCurrentEphemeralWallet(
        encryptionKey,
        scopeSelection.scopeID,
      );
      if (!isDefined(synced)) {
        console.log("Failed to sync stealth account.".yellow);
      } else {
        console.log(
          `Synced slot ${synced.currentIndex}: ${synced.currentAddress}`.green,
        );
      }
      await confirmPromptCatchRetry("");
      return runEphemeralManagerPrompt();
    }
    case "manual-ratchet": {
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted) {
        return runEphemeralManagerPrompt();
      }

      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runEphemeralManagerPrompt();
      }
      const ratcheted = await manualRatchetEphemeralWallet(
        encryptionKey,
        scopeSelection.scopeID,
      );
      if (!isDefined(ratcheted)) {
        console.log("Failed to ratchet stealth account.".yellow);
      } else {
        console.log(
          `Ratcheted to slot ${ratcheted.currentIndex}: ${ratcheted.currentAddress}`
            .green,
        );
      }
      await confirmPromptCatchRetry("");
      return runEphemeralManagerPrompt();
    }
    case "set-index": {
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted) {
        return runEphemeralManagerPrompt();
      }

      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runEphemeralManagerPrompt();
      }

      const indexPrompt = new Input({
        header: " ",
        message: "Enter stealth slot index (0 or greater)",
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
        `Set stealth slot to ${index}?`,
        { initial: false },
      );
      if (!confirmSetIndex) {
        return runEphemeralManagerPrompt();
      }

      const updated = await setEphemeralWalletIndex(
        encryptionKey,
        index,
        scopeSelection.scopeID,
      ).catch(
        (err) => {
          console.log(`Failed to set index: ${(err as Error).message}`.yellow);
          return undefined;
        },
      );

      if (!isDefined(updated)) {
        console.log("Failed to set stealth slot.".yellow);
      } else {
        console.log(
          `Set slot ${updated.currentIndex}: ${updated.currentAddress}`.green,
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
    case "manage-scopes": {
      await runScopeManagerPrompt();
      return runEphemeralManagerPrompt();
    }
    default: {
      return;
    }
  }
};
