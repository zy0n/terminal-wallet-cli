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
import { runTransactionBuilder } from "../transaction/transaction-builder";
import { getCurrentNetwork } from "../engine/engine";
import {
  getCurrentRailgunAddress,
  getCurrentWalletPublicAddress,
} from "../wallet/wallet-util";
import {
  tokenAmountSelectionPrompt,
  tokenSelectionPrompt,
} from "./token-ui";
import { getWrappedTokenBalance } from "../balance/balance-util";
import {
  getActiveStealthProfile,
  getStealthProfile,
  getStealthProfileSummary,
  listStealthProfiles,
  removeStealthProfile,
  setActiveStealthProfile,
  upsertStealthProfile,
} from "../wallet/stealth-profile-manager";
import {
  confirmPrompt,
  confirmPromptCatch,
  confirmPromptCatchRetry,
} from "./confirm-ui";

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
    return "No known internal stealth accounts yet.".grey;
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
    return "No internal stealth scopes configured.".grey;
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

const formatStealthProfileLine = (
  profile: {
    id: string;
    name: string;
    accountAddress?: string;
    scopeID?: string;
    slot?: number;
    signerStrategyScopeID?: string;
    updatedAt: number;
  },
  activeProfileID?: string,
) => {
  const activeTag = profile.id === activeProfileID ? "[ACTIVE]".green : "";
  const scopeTag = profile.scopeID ? `scope=${profile.scopeID}` : "scope=none";
  const slotTag = isDefined(profile.slot) ? `slot=${profile.slot}` : "slot=none";
  const signerTag = profile.signerStrategyScopeID
    ? `signer=${profile.signerStrategyScopeID}`
    : "signer=none";
  const updatedAt = new Date(profile.updatedAt).toISOString();

  return [
    `${profile.name}`.cyan,
    isDefined(profile.accountAddress)
      ? shortAddress(profile.accountAddress)
      : "unlinked".yellow,
    scopeTag,
    slotTag,
    signerTag,
    `updated=${updatedAt}`,
    activeTag,
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
};

const printStealthProfiles = () => {
  const summary = getStealthProfileSummary();
  const profiles = listStealthProfiles();

  if (!profiles.length) {
    console.log("No external stealth profiles found.".yellow);
    return;
  }

  console.log(
    `Profiles=${summary.total} scoped=${summary.scoped} slotted=${summary.slotted} signer-bound=${summary.withSignerScope}`.grey,
  );
  profiles.forEach((profile) => {
    console.log(formatStealthProfileLine(profile, summary.activeProfileID).grey);
  });
};

const getRequiredActiveStealthProfile = async () => {
  const activeProfile = getActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    console.log("No active stealth profile selected.".yellow);
    await confirmPromptCatchRetry("");
    return undefined;
  }
  return activeProfile;
};

const getRequiredLinkedActiveStealthProfile = async () => {
  const activeProfile = await getRequiredActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return undefined;
  }

  if (!isDefined(activeProfile.accountAddress)) {
    console.log(
      "Active profile has no account address. Edit profile and set a 0x address first."
        .yellow,
    );
    await confirmPromptCatchRetry("");
    return undefined;
  }

  return activeProfile as typeof activeProfile & { accountAddress: string };
};

const runFundUnshieldERC20ForActiveProfile = async () => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const chainName = getCurrentNetwork();
  const selections = await tokenSelectionPrompt(
    chainName,
    "Unshield ERC20 to External Stealth Profile",
    true,
    false,
  );

  const amountSelections = await tokenAmountSelectionPrompt(
    selections,
    true,
    true,
    true,
    activeProfile.accountAddress,
  );

  if (!amountSelections.length) {
    console.log("No ERC20 amounts selected for unshield.".yellow);
    await confirmPromptCatchRetry("");
    return;
  }

  await runTransactionBuilder(chainName, RailgunTransaction.Unshield, {
    selections: { amountSelections },
  });
};

const runFundUnshieldETHForActiveProfile = async () => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const chainName = getCurrentNetwork();
  const wrappedReadableAmount = await getWrappedTokenBalance(chainName);
  const amountSelections = await tokenAmountSelectionPrompt(
    [wrappedReadableAmount],
    true,
    true,
    true,
    activeProfile.accountAddress,
  );

  if (!amountSelections.length) {
    console.log("No ETH amount selected for unshield.".yellow);
    await confirmPromptCatchRetry("");
    return;
  }

  console.log("Note: Unshielding ETH will require an additional step to convert from wrapped ETH to native ETH.".yellow);
  console.log(amountSelections)

  await runTransactionBuilder(chainName, RailgunTransaction.UnshieldBase, {
    selections: { amountSelections },
  });
};

export const runStealthProfileFundUnshieldPrompt = async (): Promise<void> => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const prompt = new Select({
    header: buildStealthCardHeader(),
    message: `Fund Active Profile (${activeProfile.name})`,
    choices: [
      { name: "eth", message: "Unshield ETH to active profile" },
      { name: "erc20", message: "Unshield ERC20 to active profile" },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  if (selection === "eth") {
    await runFundUnshieldETHForActiveProfile();
    return;
  }

  await runFundUnshieldERC20ForActiveProfile();
};

const runWithdrawReshieldERC20FromProfile = async () => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const currentPublicAddress = getCurrentWalletPublicAddress().toLowerCase();
  if (activeProfile.accountAddress.toLowerCase() !== currentPublicAddress) {
    console.log(
      [
        "Reshield requires the active signer account to match the active stealth profile address.",
        `profile=${activeProfile.accountAddress}`,
        `current=${currentPublicAddress}`,
      ].join(" ").yellow,
    );
    await confirmPromptCatchRetry("");
    return;
  }

  const destinationPrivateAddress = getCurrentRailgunAddress();
  const chainName = getCurrentNetwork();

  const selections = await tokenSelectionPrompt(
    chainName,
    "Reshield ERC20 from External Stealth Profile",
    true,
    true,
  );

  const amountSelections = await tokenAmountSelectionPrompt(
    selections,
    false,
    false,
    true,
    destinationPrivateAddress,
  );

  if (!amountSelections.length) {
    console.log("No ERC20 amounts selected for reshield.".yellow);
    await confirmPromptCatchRetry("");
    return;
  }

  console.log(
    [
      `Reshield profile=${activeProfile.name}`,
      `source-public=${activeProfile.accountAddress}`,
      `destination-private=${destinationPrivateAddress}`,
    ].join(" · ").cyan,
  );

  await runTransactionBuilder(chainName, RailgunTransaction.Shield, {
    selections: { amountSelections },
  });
};

const runWithdrawReshieldETHFromProfile = async () => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const currentPublicAddress = getCurrentWalletPublicAddress().toLowerCase();
  if (activeProfile.accountAddress.toLowerCase() !== currentPublicAddress) {
    console.log(
      [
        "Reshield requires the active signer account to match the active stealth profile address.",
        `profile=${activeProfile.accountAddress}`,
        `current=${currentPublicAddress}`,
      ].join(" ").yellow,
    );
    await confirmPromptCatchRetry("");
    return;
  }

  const destinationPrivateAddress = getCurrentRailgunAddress();
  const chainName = getCurrentNetwork();
  const wrappedReadableAmount = await getWrappedTokenBalance(chainName, true);
  const amountSelections = await tokenAmountSelectionPrompt(
    [wrappedReadableAmount],
    false,
    true,
    true,
    destinationPrivateAddress,
  );

  if (!amountSelections.length) {
    console.log("No ETH amount selected for reshield.".yellow);
    await confirmPromptCatchRetry("");
    return;
  }

  console.log(
    [
      `Reshield profile=${activeProfile.name}`,
      `source-public=${activeProfile.accountAddress}`,
      `destination-private=${destinationPrivateAddress}`,
    ].join(" · ").cyan,
  );

  await runTransactionBuilder(chainName, RailgunTransaction.ShieldBase, {
    selections: { amountSelections },
  });
};

export const runStealthProfileWithdrawReshieldPrompt = async (): Promise<void> => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const prompt = new Select({
    header: buildStealthCardHeader(),
    message: `Withdraw Active Profile (${activeProfile.name})`,
    choices: [
      { name: "eth", message: "Reshield ETH from active profile" },
      { name: "erc20", message: "Reshield ERC20 from active profile" },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  if (selection === "eth") {
    await runWithdrawReshieldETHFromProfile();
    return;
  }

  await runWithdrawReshieldERC20FromProfile();
};

const buildStealthCardHeader = () => {
  const summary = getStealthProfileSummary();
  const internalState = getCurrentKnownEphemeralState();
  const profiles = listStealthProfiles().slice(0, 3);

  const rows = [
    `${"┌─ Stealth Account Manager".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} external-profiles=${summary.total.toString().cyan} active=${
      summary.activeProfileID ? "yes".green : "no".yellow
    } with-address=${summary.linked.toString().green} scoped=${summary.scoped.toString().grey} slotted=${summary.slotted
      .toString()
      .grey}`,
    `${"│".grey} active-account=${shortAddress(summary.activeAccountAddress)}`,
    `${"│".grey} internal-railgun-slot=${internalState?.currentIndex ?? "n/a"} internal-address=${shortAddress(
      internalState?.currentAddress,
    )}`,
  ];

  if (!profiles.length) {
    rows.push(`${"│".grey} recent profiles: none`);
  } else {
    rows.push(`${"│".grey} recent profiles:`);
    profiles.forEach((profile) => {
      const activeMark = summary.activeProfileID === profile.id ? "*".green : "-".grey;
      rows.push(
        `${"│".grey} ${activeMark} ${profile.name} ${
          isDefined(profile.accountAddress)
            ? shortAddress(profile.accountAddress)
            : "unlinked".yellow
        } ${
          profile.scopeID ? `scope=${profile.scopeID}` : ""
        }`.trimEnd(),
      );
    });
  }

  rows.push(`${"└─".grey}`);
  return rows.join("\n");
};

const selectStealthProfileID = async (
  message: string,
): Promise<Optional<string>> => {
  const profiles = listStealthProfiles();
  const summary = getStealthProfileSummary();

  if (!profiles.length) {
    console.log("No external stealth profiles found.".yellow);
    await confirmPromptCatchRetry("");
    return undefined;
  }

  const prompt = new Select({
    header: " ",
    message,
    choices: [
      ...profiles.map((profile) => ({
        name: profile.id,
        message: formatStealthProfileLine(profile, summary.activeProfileID),
      })),
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return undefined;
  }

  return selection;
};

const promptOptionalText = async (
  message: string,
  initial = "",
): Promise<Optional<string>> => {
  const prompt = new Input({
    header: " ",
    message,
    initial,
  });

  const value = (await prompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;

  if (!isDefined(value)) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized.length) {
    return undefined;
  }
  return normalized;
};

const resolveGeneratedStealthProfileAddress = async (
  slot?: number,
  scopeID?: string,
): Promise<Optional<string>> => {
  const derivedScopeID = isDefined(scopeID)
    ? scopeID
    : isDefined(slot)
    ? slotToScopeID(slot)
    : undefined;

  if (isDefined(slot)) {
    const encryptionKey = await getSaltedPassword();
    if (!isDefined(encryptionKey)) {
      return undefined;
    }
    const updated = await setEphemeralWalletIndex(
      encryptionKey,
      slot,
      derivedScopeID,
    );
    return updated?.currentAddress;
  }

  const knownState = getCurrentKnownEphemeralState();
  if (isDefined(knownState?.currentAddress)) {
    return knownState?.currentAddress;
  }

  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) {
    return undefined;
  }
  const synced = await syncCurrentEphemeralWallet(encryptionKey, derivedScopeID);
  return synced?.currentAddress;
};

const promptStealthProfileInput = async (
  existing?: {
    id: string;
    name: string;
    accountAddress?: string;
    scopeID?: string;
    slot?: number;
    signerStrategyScopeID?: string;
  },
) => {
  const namePrompt = new Input({
    header: " ",
    message: "Profile name",
    initial: existing?.name ?? "",
    validate: (value: string) => value.trim().length > 0,
  });

  const nameInput = (await namePrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(nameInput)) {
    return undefined;
  }

  const scopeInput = await promptOptionalText(
    "Optional scope ID (blank for none)",
    existing?.scopeID ?? "",
  );

  const slotPrompt = new Input({
    header: " ",
    message: "Optional slot number (blank for none)",
    initial: isDefined(existing?.slot) ? String(existing?.slot) : "",
    validate: (value: string) => {
      if (!value.trim().length) {
        return true;
      }
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 0;
    },
  });

  const slotInput = (await slotPrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(slotInput)) {
    return undefined;
  }
  const slot = slotInput.trim().length ? Number(slotInput) : undefined;

  const signerStrategyScopeID = await promptOptionalText(
    "Optional signer strategy scope ID (blank for none)",
    existing?.signerStrategyScopeID ?? "",
  );

  const generatedAddress = await resolveGeneratedStealthProfileAddress(
    slot,
    scopeInput,
  );
  if (!isDefined(generatedAddress)) {
    console.log(
      "Could not generate stealth account address (wallet password required or generation failed)."
        .yellow,
    );
    await confirmPromptCatchRetry("");
    return undefined;
  }

  console.log(
    `Generated profile account address: ${generatedAddress}`.green,
  );

  return {
    id: existing?.id,
    name: nameInput.trim(),
    accountAddress: generatedAddress,
    scopeID: scopeInput,
    slot,
    signerStrategyScopeID,
  };
};

const runExternalStealthProfileManagerPrompt = async (): Promise<void> => {
  const summary = getStealthProfileSummary();
  const prompt = new Select({
    header: buildStealthCardHeader(),
    message: "External Stealth Profiles",
    choices: [
      {
        name: "list-profiles",
        message: `List Profiles (${summary.total})`,
      },
      {
        name: "create-profile",
        message: "Create Profile",
      },
      {
        name: "edit-profile",
        message: "Edit Profile",
        disabled: summary.total === 0 ? "No profiles" : false,
      },
      {
        name: "set-active",
        message: "Set Active Profile",
        disabled: summary.total === 0 ? "No profiles" : false,
      },
      {
        name: "fund-unshield-erc20",
        message: "Fund Active Profile (Unshield ERC20)",
        disabled:
          summary.total === 0
            ? "No profiles"
            : !summary.hasActiveLinkedAddress
            ? "Active profile needs a 0x address"
            : false,
      },
      {
        name: "fund-unshield-eth",
        message: "Fund Active Profile (Unshield ETH)",
        disabled:
          summary.total === 0
            ? "No profiles"
            : !summary.hasActiveLinkedAddress
            ? "Active profile needs a 0x address"
            : false,
      },
      {
        name: "withdraw-reshield-erc20",
        message: "Withdraw Active Profile (Reshield ERC20)",
        disabled:
          summary.total === 0
            ? "No profiles"
            : !summary.hasActiveLinkedAddress
            ? "Active profile needs a 0x address"
            : false,
      },
      {
        name: "withdraw-reshield-eth",
        message: "Withdraw Active Profile (Reshield ETH)",
        disabled:
          summary.total === 0
            ? "No profiles"
            : !summary.hasActiveLinkedAddress
            ? "Active profile needs a 0x address"
            : false,
      },
      {
        name: "remove-profile",
        message: "Remove Profile",
        disabled: summary.total === 0 ? "No profiles" : false,
      },
      {
        name: "activate-profile-signer",
        message: "Activate Active Profile Signer Strategy",
        disabled:
          !summary.activeProfileID || !summary.withSignerScope
            ? "No active signer-bound profile"
            : false,
      },
      {
        name: "refresh-card",
        message: "Refresh Card".cyan,
      },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  switch (selection) {
    case "list-profiles": {
      printStealthProfiles();
      await confirmPromptCatchRetry("");
      return runExternalStealthProfileManagerPrompt();
    }
    case "create-profile": {
      const profileInput = await promptStealthProfileInput();
      if (!isDefined(profileInput)) {
        return runExternalStealthProfileManagerPrompt();
      }

      const created = upsertStealthProfile(profileInput);
      setActiveStealthProfile(created.id);
      console.log(
        `Created profile ${created.name} (${created.id}) with generated address ${created.accountAddress} and set it active.`
          .green,
      );
      await confirmPromptCatchRetry("");
      return runExternalStealthProfileManagerPrompt();
    }
    case "edit-profile": {
      const profileID = await selectStealthProfileID("Select profile to edit");
      if (!isDefined(profileID)) {
        return runExternalStealthProfileManagerPrompt();
      }

      const profile = getStealthProfile(profileID);
      if (!isDefined(profile)) {
        return runExternalStealthProfileManagerPrompt();
      }

      const profileInput = await promptStealthProfileInput(profile);
      if (!isDefined(profileInput)) {
        return runExternalStealthProfileManagerPrompt();
      }

      const updated = upsertStealthProfile({
        ...profileInput,
        id: profile.id,
      });
      console.log(`Updated profile ${updated.name} (${updated.id}).`.green);
      await confirmPromptCatchRetry("");
      return runExternalStealthProfileManagerPrompt();
    }
    case "set-active": {
      const profileID = await selectStealthProfileID("Set active profile");
      if (!isDefined(profileID)) {
        return runExternalStealthProfileManagerPrompt();
      }

      const active = setActiveStealthProfile(profileID);
      console.log(`Active profile set to ${active.name} (${active.id}).`.green);
      await confirmPromptCatchRetry("");
      return runExternalStealthProfileManagerPrompt();
    }
    case "fund-unshield-erc20": {
      await runFundUnshieldERC20ForActiveProfile();
      return runExternalStealthProfileManagerPrompt();
    }
    case "fund-unshield-eth": {
      await runFundUnshieldETHForActiveProfile();
      return runExternalStealthProfileManagerPrompt();
    }
    case "withdraw-reshield-erc20": {
      await runWithdrawReshieldERC20FromProfile();
      return runExternalStealthProfileManagerPrompt();
    }
    case "withdraw-reshield-eth": {
      await runWithdrawReshieldETHFromProfile();
      return runExternalStealthProfileManagerPrompt();
    }
    case "remove-profile": {
      const profileID = await selectStealthProfileID("Remove profile");
      if (!isDefined(profileID)) {
        return runExternalStealthProfileManagerPrompt();
      }

      const profile = getStealthProfile(profileID);
      if (!isDefined(profile)) {
        return runExternalStealthProfileManagerPrompt();
      }

      const confirmed = await confirmPrompt(
        `Remove external stealth profile ${profile.name}?`,
        { initial: false },
      );
      if (!confirmed) {
        return runExternalStealthProfileManagerPrompt();
      }

      const removed = removeStealthProfile(profileID);
      console.log(
        removed
          ? `Removed profile ${profile.name} (${profileID}).`.green
          : `Profile ${profileID} was not found.`.yellow,
      );
      await confirmPromptCatchRetry("");
      return runExternalStealthProfileManagerPrompt();
    }
    case "activate-profile-signer": {
      const activeProfile = getActiveStealthProfile();
      if (!isDefined(activeProfile)) {
        console.log("No active stealth profile selected.".yellow);
        await confirmPromptCatchRetry("");
        return runExternalStealthProfileManagerPrompt();
      }

      if (!isDefined(activeProfile.signerStrategyScopeID)) {
        console.log("Active profile has no signer strategy scope ID.".yellow);
        await confirmPromptCatchRetry("");
        return runExternalStealthProfileManagerPrompt();
      }

      const strategyScopeID = activeProfile.signerStrategyScopeID;
      const hasScopedStrategy = hasScopedEphemeralWalletDerivationStrategy(
        strategyScopeID,
      );
      if (!hasScopedStrategy) {
        console.log(
          `No scoped signer strategy registered for ${strategyScopeID}.`.yellow,
        );
        await confirmPromptCatchRetry("");
        return runExternalStealthProfileManagerPrompt();
      }

      activateScopedEphemeralWalletDerivationStrategy(strategyScopeID);
      console.log(
        `Activated signer strategy scope ${strategyScopeID} for active profile ${activeProfile.name}.`
          .green,
      );
      await confirmPromptCatchRetry("");
      return runExternalStealthProfileManagerPrompt();
    }
    case "refresh-card": {
      return runExternalStealthProfileManagerPrompt();
    }
    default: {
      return;
    }
  }
};

const promptAddressLookup = async () => {
  const prompt = new Input({
    header: " ",
    message: "Enter internal stealth address to lookup slot",
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
    console.log("Address not found in known internal stealth cache.".yellow);
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

const runInternalScopeManagerPrompt = async (): Promise<void> => {
  const prompt = new Select({
    header: ["Internal Railgun Scope Manager", formatKnownScopes()].join("\n\n"),
    message: "Internal Scope Tools",
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
      return runInternalScopeManagerPrompt();
    }
    case "upsert-policy": {
      await promptAndApplyScopePolicy();
      return runInternalScopeManagerPrompt();
    }
    case "remove": {
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted || !isDefined(scopeSelection.scopeID)) {
        return runInternalScopeManagerPrompt();
      }

      const confirmed = await confirmPrompt(
        `Remove internal scope ${scopeSelection.scopeID}?`,
        { initial: false },
      );
      if (!confirmed) {
        return runInternalScopeManagerPrompt();
      }

      const removed = removeEphemeralSessionScope(scopeSelection.scopeID);
      console.log(
        removed
          ? `Removed scope ${scopeSelection.scopeID}.`.green
          : `Scope ${scopeSelection.scopeID} was not found.`.yellow,
      );
      await confirmPromptCatchRetry("");
      return runInternalScopeManagerPrompt();
    }
    case "activate-signer": {
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted || !isDefined(scopeSelection.scopeID)) {
        return runInternalScopeManagerPrompt();
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
        return runInternalScopeManagerPrompt();
      }

      activateScopedEphemeralWalletDerivationStrategy(scopeSelection.scopeID);
      console.log(
        `Activated scoped signer strategy for ${scopeSelection.scopeID}.`.green,
      );
      await confirmPromptCatchRetry("");
      return runInternalScopeManagerPrompt();
    }
    case "show-strategy-scopes": {
      const strategyScopes = listScopedEphemeralWalletDerivationStrategyScopeIDs();
      if (!strategyScopes.length) {
        console.log("No scoped signer strategies registered yet.".yellow);
      } else {
        console.log(strategyScopes.map((scopeID) => `${scopeID}`.cyan).join("\n"));
      }
      await confirmPromptCatchRetry("");
      return runInternalScopeManagerPrompt();
    }
    default: {
      return;
    }
  }
};

const runInternalStealthToolsPrompt = async (): Promise<void> => {
  const state = getCurrentKnownEphemeralState();
  const prompt = new Select({
    header: [
      "Internal Railgun Stealth Tools",
      `Current Slot: ${state?.currentIndex ?? "n/a"}`,
      `Current Address: ${state?.currentAddress ?? "unknown"}`,
    ].join("\n"),
    message: "Internal Stealth Tools",
    choices: [
      { name: "sync-current", message: "Sync Current Internal Stealth Account" },
      { name: "manual-ratchet", message: "Ratchet to Next Internal Stealth Slot" },
      { name: "set-index", message: "Set Specific Internal Stealth Slot" },
      { name: "show-known", message: "Show Known Internal Stealth Slots" },
      { name: "lookup-index", message: "Lookup Internal Slot by Address" },
      { name: "manage-scopes", message: "Manage Internal Scopes & Policies" },
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
        return runInternalStealthToolsPrompt();
      }

      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runInternalStealthToolsPrompt();
      }
      const synced = await syncCurrentEphemeralWallet(
        encryptionKey,
        scopeSelection.scopeID,
      );
      if (!isDefined(synced)) {
        console.log("Failed to sync internal stealth account.".yellow);
      } else {
        console.log(
          `Synced slot ${synced.currentIndex}: ${synced.currentAddress}`.green,
        );
      }
      await confirmPromptCatchRetry("");
      return runInternalStealthToolsPrompt();
    }
    case "manual-ratchet": {
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted) {
        return runInternalStealthToolsPrompt();
      }

      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runInternalStealthToolsPrompt();
      }
      const ratcheted = await manualRatchetEphemeralWallet(
        encryptionKey,
        scopeSelection.scopeID,
      );
      if (!isDefined(ratcheted)) {
        console.log("Failed to ratchet internal stealth account.".yellow);
      } else {
        console.log(
          `Ratcheted to slot ${ratcheted.currentIndex}: ${ratcheted.currentAddress}`
            .green,
        );
      }
      await confirmPromptCatchRetry("");
      return runInternalStealthToolsPrompt();
    }
    case "set-index": {
      const scopeSelection = await promptOptionalScopeSelection();
      if (scopeSelection.aborted) {
        return runInternalStealthToolsPrompt();
      }

      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runInternalStealthToolsPrompt();
      }

      const indexPrompt = new Input({
        header: " ",
        message: "Enter internal stealth slot index (0 or greater)",
        validate: (value: string) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 0;
        },
      });

      const indexInput = (await indexPrompt.run().catch(confirmPromptCatch)) as
        | string
        | undefined;
      if (!isDefined(indexInput)) {
        return runInternalStealthToolsPrompt();
      }

      const index = Number(indexInput);
      const confirmSetIndex = await confirmPrompt(
        `Set internal stealth slot to ${index}?`,
        { initial: false },
      );
      if (!confirmSetIndex) {
        return runInternalStealthToolsPrompt();
      }

      const updated = await setEphemeralWalletIndex(
        encryptionKey,
        index,
        scopeSelection.scopeID,
      ).catch(
        (err) => {
          console.log(`Failed to set slot: ${(err as Error).message}`.yellow);
          return undefined;
        },
      );

      if (!isDefined(updated)) {
        console.log("Failed to set internal stealth slot.".yellow);
      } else {
        console.log(
          `Set slot ${updated.currentIndex}: ${updated.currentAddress}`.green,
        );
      }

      await confirmPromptCatchRetry("");
      return runInternalStealthToolsPrompt();
    }
    case "show-known": {
      console.log(formatKnownAddresses());
      await confirmPromptCatchRetry("");
      return runInternalStealthToolsPrompt();
    }
    case "lookup-index": {
      await promptAddressLookup();
      return runInternalStealthToolsPrompt();
    }
    case "manage-scopes": {
      await runInternalScopeManagerPrompt();
      return runInternalStealthToolsPrompt();
    }
    default: {
      return;
    }
  }
};

export const runEphemeralManagerPrompt = async (): Promise<void> => {
  const summary = getStealthProfileSummary();
  const prompt = new Select({
    header: buildStealthCardHeader(),
    message: "Stealth Account Tools",
    choices: [
      {
        name: "external-profiles",
        message: `Manage External Stealth Profiles (${summary.total})`,
      },
      {
        name: "internal-tools",
        message: "Internal Railgun Stealth Tools",
      },
      {
        name: "refresh-card",
        message: "Refresh Card".cyan,
      },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  switch (selection) {
    case "external-profiles": {
      await runExternalStealthProfileManagerPrompt();
      return runEphemeralManagerPrompt();
    }
    case "internal-tools": {
      await runInternalStealthToolsPrompt();
      return runEphemeralManagerPrompt();
    }
    case "refresh-card": {
      return runEphemeralManagerPrompt();
    }
    default: {
      return;
    }
  }
};
