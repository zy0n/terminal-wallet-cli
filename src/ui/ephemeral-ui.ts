import { isDefined } from "@railgun-community/shared-models";
import {
  activateScopedEphemeralWalletDerivationStrategy,
  getActiveEphemeralSessionScopeID,
  getCurrentKnownEphemeralState,
  getDefaultActiveStealthScopeID,
  getEphemeralSessionScope,
  hasScopedEphemeralWalletDerivationStrategy,
  getKnownEphemeralAddresses,
  getKnownEphemeralIndexForAddress,
  listEphemeralSessionScopes,
  listKnownEphemeralSessionScopeIDs,
  listScopedEphemeralWalletDerivationStrategyScopeIDs,
  manualRatchetEphemeralWallet,
  removeEphemeralSessionScope,
  setActiveEphemeralSessionScopeID,
  setEphemeralSessionRatchetPolicy,
  setCurrentEphemeralWalletSession,
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
  getGasBalanceForAddress,
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
import { createLiveSelect } from "./live-select";
import { getChainForName, getWrappedTokenInfoForChain } from "../network/network-util";
import { getERC20Balance } from "../balance/token-util";
import { HDNodeWallet, formatUnits } from "ethers";

const { Select, Input } = require("enquirer");

const transactionChoices = Object.values(RailgunTransaction).map((name) => ({
  name,
  message: name,
}));

type ScopeSelection = {
  aborted: boolean;
  scopeID?: string;
};

type StealthScopeAddressEntry = {
  key: string;
  address: string;
  profileID?: string;
  profileName?: string;
  knownIndex?: number;
  source: "known" | "session" | "profile";
};

const LEGACY_UNSCOPED_SCOPE_ID = "__legacy_unscoped__";

const getCurrentChainScopedScopeID = (scopeID?: string): Optional<string> => {
  if (!isDefined(scopeID)) {
    return undefined;
  }

  const normalizedScopeID = scopeID.trim();
  if (!normalizedScopeID.length) {
    return undefined;
  }

  const currentChain = getChainForName(getCurrentNetwork());
  const baseScopeID = normalizedScopeID.replace(/^chain-\d+:/, "");
  return `chain-${currentChain.id}:${baseScopeID}`;
};

const shortAddress = (address?: string) => {
  if (!isDefined(address) || address.length < 12) {
    return "unknown";
  }
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
};

const sortScopeIDs = (scopeIDs: string[]) => {
  return [...scopeIDs].sort((left, right) => {
    const leftIsNumeric = /^\d+$/.test(left);
    const rightIsNumeric = /^\d+$/.test(right);

    if (leftIsNumeric && rightIsNumeric) {
      return Number(left) - Number(right);
    }

    if (leftIsNumeric) {
      return -1;
    }

    if (rightIsNumeric) {
      return 1;
    }

    return left.localeCompare(right);
  });
};

const formatScopeName = (scopeID: string) => {
  if (scopeID === LEGACY_UNSCOPED_SCOPE_ID) {
    return "Legacy Unscoped Profiles";
  }

  if (scopeID === getDefaultActiveStealthScopeID()) {
    return `Internal Scope ${scopeID}`;
  }

  if (/^\d+$/.test(scopeID)) {
    return `User Scope ${scopeID}`;
  }

  return `Scope ${scopeID}`;
};

const isLegacyUnscopedProfile = (profile: {
  scopeID?: string;
  signerStrategyScopeID?: string;
  slot?: number;
}) => {
  return !isDefined(profile.scopeID)
    && !isDefined(profile.signerStrategyScopeID)
    && !isDefined(profile.slot);
};

const isLegacyUnscopedScope = (scopeID: string) => {
  return scopeID === LEGACY_UNSCOPED_SCOPE_ID;
};

const formatPublicBalanceSummary = async (address?: string) => {
  if (!isDefined(address)) {
    return "n/a";
  }

  const chainName = getCurrentNetwork();
  const wrappedInfo = getWrappedTokenInfoForChain(chainName);

  try {
    const [nativeBalance, wrappedBalance] = await Promise.all([
      getGasBalanceForAddress(address),
      getERC20Balance(chainName, wrappedInfo.wrappedAddress, address),
    ]);

    const nativeReadable = Number(
      formatUnits(nativeBalance, wrappedInfo.decimals),
    ).toFixed(6);
    const wrappedReadable = Number(
      formatUnits(wrappedBalance, wrappedInfo.decimals),
    ).toFixed(6);

    return `${wrappedInfo.symbol}=${nativeReadable} · ${wrappedInfo.wrappedSymbol}=${wrappedReadable}`;
  } catch {
    return "unavailable";
  }
};

const isCancelLifecycleError = (error: unknown) => {
  const message = (error as Error)?.message?.toLowerCase?.() ?? "";
  return (
    message.includes("going back")
    || message.includes("cancel")
    || message.includes("aborted")
  );
};

const runTransactionBuilderSafely = async (
  chainName: ReturnType<typeof getCurrentNetwork>,
  transactionType: RailgunTransaction,
  params: {
    selections: unknown[];
    confirmAmountsDisabled?: boolean;
    selfSignerWallet?: HDNodeWallet;
    force7702Unshield?: boolean;
  },
) => {
  try {
    await runTransactionBuilder(chainName, transactionType, params as any);
  } catch (error) {
    if (isCancelLifecycleError(error)) {
      return;
    }
    console.log(`Transaction flow failed: ${(error as Error).message}`.yellow);
    await confirmPromptCatchRetry("");
  }
};

const promptERC20FundingRoute = async (): Promise<
  Optional<"standard" | "7702">
> => {
  const prompt = new Select({
    header: " ",
    message: "ERC20 funding route",
    choices: [
      { name: "standard", message: "Standard unshield ERC20" },
      {
        name: "7702",
        message: "7702 unshield ERC20 (broadcaster / type-4 authorization)",
      },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return undefined;
  }

  return selection as "standard" | "7702";
};

const getProfileScopeID = (profile: {
  signerStrategyScopeID?: string;
  scopeID?: string;
  slot?: number;
}) => {
  if (isDefined(profile.signerStrategyScopeID) && profile.signerStrategyScopeID.trim().length) {
    return getCurrentChainScopedScopeID(profile.signerStrategyScopeID);
  }
  if (isDefined(profile.scopeID) && profile.scopeID.trim().length) {
    return getCurrentChainScopedScopeID(profile.scopeID);
  }
  if (isDefined(profile.slot)) {
    return getCurrentChainScopedScopeID(slotToScopeID(profile.slot));
  }
  return undefined;
};

const collectStealthAppScopeIDs = () => {
  const scopeIDs = new Set<string>([
    getDefaultActiveStealthScopeID(),
    getActiveEphemeralSessionScopeID(),
    ...listKnownEphemeralSessionScopeIDs(),
  ]);

  let hasLegacyUnscopedProfiles = false;

  for (const profile of listStealthProfiles()) {
    if (isLegacyUnscopedProfile(profile)) {
      hasLegacyUnscopedProfiles = true;
    }

    const preferredScopeID = getProfileScopeID(profile);
    if (isDefined(preferredScopeID)) {
      scopeIDs.add(preferredScopeID);
    }

    if (isDefined(profile.scopeID) && profile.scopeID.trim().length) {
      scopeIDs.add(profile.scopeID.trim());
    }
  }

  if (hasLegacyUnscopedProfiles) {
    scopeIDs.add(LEGACY_UNSCOPED_SCOPE_ID);
  }

  return sortScopeIDs([...scopeIDs.values()]);
};

const getProfilesForScope = (scopeID: string) => {
  if (isLegacyUnscopedScope(scopeID)) {
    return listStealthProfiles().filter((profile) => isLegacyUnscopedProfile(profile));
  }

  return listStealthProfiles().filter((profile) => {
    return getStealthSignerScopeCandidatesForProfile(profile).includes(scopeID);
  });
};

const getKnownAddressesForScope = (scopeID: string): StealthScopeAddressEntry[] => {
  const entries = new Map<string, StealthScopeAddressEntry>();
  const addEntry = (entry: StealthScopeAddressEntry) => {
    const key = entry.address.toLowerCase();
    const existing = entries.get(key);

    if (!isDefined(existing)) {
      entries.set(key, entry);
      return;
    }

    entries.set(key, {
      ...existing,
      ...entry,
      profileID: entry.profileID ?? existing.profileID,
      profileName: entry.profileName ?? existing.profileName,
      knownIndex: isDefined(entry.knownIndex) ? entry.knownIndex : existing.knownIndex,
    });
  };

  if (scopeID === getDefaultActiveStealthScopeID()) {
    for (const known of getKnownEphemeralAddresses()) {
      addEntry({
        key: `${scopeID}:${known.address.toLowerCase()}`,
        address: known.address,
        knownIndex: known.index,
        source: "known",
      });
    }
  }

  const sessionScope = isLegacyUnscopedScope(scopeID)
    ? undefined
    : getEphemeralSessionScope(scopeID);
  if (isDefined(sessionScope) && isDefined(sessionScope.lastKnownAddress)) {
    addEntry({
      key: `${scopeID}:${sessionScope.lastKnownAddress.toLowerCase()}`,
      address: sessionScope.lastKnownAddress,
      knownIndex: sessionScope.lastKnownIndex,
      source: "session",
    });
  }

  for (const profile of getProfilesForScope(scopeID)) {
    if (!isDefined(profile.accountAddress)) {
      continue;
    }

    addEntry({
      key: `${scopeID}:${profile.accountAddress.toLowerCase()}`,
      address: profile.accountAddress,
      profileID: profile.id,
      profileName: profile.name,
      knownIndex: profile.slot,
      source: "profile",
    });
  }

  return [...entries.values()].sort((left, right) => {
    if (isDefined(left.profileID) && !isDefined(right.profileID)) {
      return -1;
    }
    if (!isDefined(left.profileID) && isDefined(right.profileID)) {
      return 1;
    }
    return left.address.localeCompare(right.address);
  });
};

const formatScopeAddressEntry = (
  entry: StealthScopeAddressEntry,
  activeProfileID?: string,
) => {
  const activeProfileTag = entry.profileID === activeProfileID ? "[ACTIVE PROFILE]".green : "";
  const profileTag = isDefined(entry.profileName)
    ? `${entry.profileName}`.cyan
    : "unmanaged".yellow;
  const indexTag = isDefined(entry.knownIndex) ? `idx=${entry.knownIndex}` : "idx=n/a";
  return [
    shortAddress(entry.address),
    profileTag,
    indexTag,
    `source=${entry.source}`,
    activeProfileTag,
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
};

const getStealthSignerScopeCandidatesForProfile = (profile: {
  scopeID?: string;
  signerStrategyScopeID?: string;
  slot?: number;
}) => {
  const candidates: string[] = [];
  const add = (value?: string) => {
    if (!isDefined(value)) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed.length) {
      return;
    }
    if (!candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  const addScopeWithChainFallback = (value?: string) => {
    if (!isDefined(value)) {
      return;
    }

    add(getCurrentChainScopedScopeID(value));
    add(value);
  };

  addScopeWithChainFallback(profile.signerStrategyScopeID);
  addScopeWithChainFallback(profile.scopeID);
  if (isDefined(profile.slot)) {
    addScopeWithChainFallback(slotToScopeID(profile.slot));
  }

  if (isDefined(profile.signerStrategyScopeID)) {
    const maybeNumber = Number(profile.signerStrategyScopeID);
    if (Number.isInteger(maybeNumber) && maybeNumber >= 0) {
      addScopeWithChainFallback(slotToScopeID(maybeNumber));
    }
  }

  return candidates;
};

const prepareStealthSessionForTransaction = async (profile: {
  name: string;
  accountAddress?: string;
  signerStrategyScopeID?: string;
  scopeID?: string;
  slot?: number;
}) => {
  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) {
    return undefined;
  }

  try {
    const targetAddress = profile.accountAddress?.toLowerCase();

    const tryResolveStealthSession = async (
      scopeID?: string,
      index?: number,
    ): Promise<Optional<Awaited<ReturnType<typeof setCurrentEphemeralWalletSession>>>> => {
      if (typeof index === "number") {
        const indexed = await setEphemeralWalletIndex(encryptionKey, index, scopeID);
        const indexedAddress = indexed?.currentAddress?.toLowerCase();
        if (isDefined(targetAddress) && indexedAddress !== targetAddress) {
          return undefined;
        }
      }

      const session = await setCurrentEphemeralWalletSession(
        encryptionKey,
        scopeID,
        { skipAutoSync: true },
      );
      if (!isDefined(session)) {
        return undefined;
      }

      const sessionAddress = session.currentAddress.toLowerCase();
      if (isDefined(targetAddress) && sessionAddress !== targetAddress) {
        return undefined;
      }

      return session;
    };

    const uniqueScopeCandidates = new Set<string>();
    for (const scopeID of getStealthSignerScopeCandidatesForProfile(profile)) {
      uniqueScopeCandidates.add(scopeID);
    }
    if (isDefined(targetAddress)) {
      for (const sessionScope of listEphemeralSessionScopes()) {
        if (sessionScope.lastKnownAddress?.toLowerCase() === targetAddress) {
          uniqueScopeCandidates.add(sessionScope.scopeID);
        }
      }
    }

    const uniqueIndexCandidates = new Set<number>();
    if (typeof profile.slot === "number") {
      uniqueIndexCandidates.add(profile.slot);
    }
    if (isDefined(targetAddress)) {
      const knownIndex = getKnownEphemeralIndexForAddress(targetAddress);
      if (typeof knownIndex === "number") {
        uniqueIndexCandidates.add(knownIndex);
      }
      for (const sessionScope of listEphemeralSessionScopes()) {
        if (
          sessionScope.lastKnownAddress?.toLowerCase() === targetAddress
          && typeof sessionScope.lastKnownIndex === "number"
        ) {
          uniqueIndexCandidates.add(sessionScope.lastKnownIndex);
        }
      }
    }

    const scopeCandidates = [...uniqueScopeCandidates.values()];
    const indexCandidates = [...uniqueIndexCandidates.values()];

    let session: Awaited<ReturnType<typeof setCurrentEphemeralWalletSession>> | undefined;
    let matchedScope: Optional<string>;
    let matchedIndex: Optional<number>;

    for (const scopeID of [...scopeCandidates, getProfileScopeID(profile), undefined]) {
      for (const index of indexCandidates) {
        const resolved = await tryResolveStealthSession(scopeID, index);
        if (!isDefined(resolved)) {
          continue;
        }
        session = resolved;
        matchedScope = scopeID;
        matchedIndex = index;
        break;
      }
      if (isDefined(session)) {
        break;
      }

      const resolved = await tryResolveStealthSession(scopeID);
      if (!isDefined(resolved)) {
        continue;
      }
      session = resolved;
      matchedScope = scopeID;
      break;
    }

    if (!isDefined(session) && isDefined(targetAddress)) {
      const knownIndices = getKnownEphemeralAddresses().map((entry) => entry.index);
      const fallbackIndexSet = new Set<number>([...indexCandidates, ...knownIndices]);
      const highestKnownIndex = fallbackIndexSet.size
        ? Math.max(...[...fallbackIndexSet.values()])
        : 0;
      const fallbackUpperBound = Math.min(Math.max(highestKnownIndex + 8, 32), 128);
      for (let index = 0; index <= fallbackUpperBound; index += 1) {
        fallbackIndexSet.add(index);
      }

      const fallbackIndices = [...fallbackIndexSet.values()].sort((left, right) => {
        return left - right;
      });

      for (const scopeID of [...scopeCandidates, getProfileScopeID(profile), undefined]) {
        for (const index of fallbackIndices) {
          const resolved = await tryResolveStealthSession(scopeID, index);
          if (!isDefined(resolved)) {
            continue;
          }
          session = resolved;
          matchedScope = scopeID;
          matchedIndex = index;
          break;
        }
        if (isDefined(session)) {
          break;
        }
      }
    }

    if (!isDefined(session)) {
      if (isDefined(targetAddress)) {
        console.log(
          [
            "Resolved stealth signer does not match the active stealth profile address.",
            `profile=${profile.accountAddress}`,
            "session=<unresolved>",
          ].join(" ").yellow,
        );
      } else {
        console.log("Failed to set current ephemeral wallet session.".yellow);
      }
      await confirmPromptCatchRetry("");
      return undefined;
    }

    console.log(
      `Using stealth session ${session.currentAddress} (index ${session.currentIndex})${
        session.scopeID ? ` scope=${session.scopeID}` : ""
      }${isDefined(matchedScope) ? ` matched-scope=${matchedScope}` : ""}${isDefined(matchedIndex) ? ` matched-index=${matchedIndex}` : ""} for ${profile.name}.`.grey,
    );

    return session;
  } catch (error) {
    console.log(
      `Failed to set current ephemeral wallet session: ${(error as Error).message}`.yellow,
    );
    await confirmPromptCatchRetry("");
    return undefined;
  }
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

const getStealthProfilesForScope = (scopeID: string) => {
  return listStealthProfiles().filter((profile) => {
    if (isLegacyUnscopedScope(scopeID)) {
      return isLegacyUnscopedProfile(profile);
    }
    return getStealthSignerScopeCandidatesForProfile(profile).includes(scopeID);
  });
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

const printStealthProfilesForScope = (scopeID: string) => {
  const profiles = getStealthProfilesForScope(scopeID);
  const summary = getStealthProfileSummary();

  if (!profiles.length) {
    console.log(`No external stealth profiles found for ${formatScopeName(scopeID)}.`.yellow);
    return;
  }

  console.log(
    `Profiles in ${formatScopeName(scopeID)}=${profiles.length} total=${summary.total}`.grey,
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

  const sessionReady = await prepareStealthSessionForTransaction(activeProfile);
  if (!sessionReady) {
    return;
  }

  const fundingRoute = await promptERC20FundingRoute();
  if (!isDefined(fundingRoute)) {
    return;
  }

  await runTransactionBuilderSafely(chainName, RailgunTransaction.Unshield, {
    selections: amountSelections,
    confirmAmountsDisabled: false,
    force7702Unshield: fundingRoute === "7702",
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

  const sessionReady = await prepareStealthSessionForTransaction(activeProfile);
  if (!sessionReady) {
    return;
  }

  await runTransactionBuilderSafely(chainName, RailgunTransaction.UnshieldBase, {
    selections: amountSelections,
    confirmAmountsDisabled: false,

  });
};

export const runStealthProfileFundUnshieldPrompt = async (): Promise<void> => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const prompt = new Select({
    header: await buildStealthCardHeader(),
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

  const sessionReady = await prepareStealthSessionForTransaction(activeProfile);
  if (!sessionReady) {
    return;
  }

  const destinationPrivateAddress = getCurrentRailgunAddress();
  const chainName = getCurrentNetwork();

  const selections = await tokenSelectionPrompt(
    chainName,
    "Reshield ERC20 from External Stealth Profile",
    true,
    true,
    undefined,
    false,
    activeProfile.accountAddress,
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

  await runTransactionBuilderSafely(chainName, RailgunTransaction.Shield, {
    selections: amountSelections,
    confirmAmountsDisabled: false,
    selfSignerWallet: sessionReady.signer,

  });
};

const runWithdrawReshieldETHFromProfile = async () => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const sessionReady = await prepareStealthSessionForTransaction(activeProfile);
  if (!sessionReady) {
    return;
  }

  const destinationPrivateAddress = getCurrentRailgunAddress();
  const chainName = getCurrentNetwork();
  const wrappedReadableAmount = await getWrappedTokenBalance(
    chainName,
    true,
    activeProfile.accountAddress,
  );
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

  await runTransactionBuilderSafely(chainName, RailgunTransaction.ShieldBase, {
    selections: amountSelections,
    confirmAmountsDisabled: false,
    selfSignerWallet: sessionReady.signer,

  });
};

export const runStealthProfileWithdrawReshieldPrompt = async (): Promise<void> => {
  const activeProfile = await getRequiredLinkedActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    return;
  }

  const prompt = new Select({
    header: await buildStealthCardHeader(),
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

const buildStealthCardHeader = async () => {
  const summary = getStealthProfileSummary();
  const internalState = getCurrentKnownEphemeralState();
  const activeScopeID = getActiveEphemeralSessionScopeID();
  const scopeCount = collectStealthAppScopeIDs().length;
  const allProfiles = listStealthProfiles();
  const profiles = allProfiles.slice(0, 3);
  const activeProfile = allProfiles.find((profile) => profile.id === summary.activeProfileID);
  const [activePublicBalances, internalPublicBalances] = await Promise.all([
    formatPublicBalanceSummary(summary.activeAccountAddress),
    formatPublicBalanceSummary(internalState?.currentAddress),
  ]);
  const suggestedAction = !summary.total
    ? "Create your first profile".green
    : !summary.activeProfileID
      ? "Choose an active profile".yellow
      : !summary.hasActiveLinkedAddress
        ? "Link or generate a 0x address".yellow
        : "Fund or withdraw active profile".cyan;

  const rows = [
    `${"┌─ Stealth App Manager".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} profiles=${summary.total.toString().cyan} · ${summary.linked
      .toString()
      .green} linked · scopes=${scopeCount.toString().cyan} · ${summary.withSignerScope
      .toString()
      .magenta} signer-bound`,
    `${"│".grey} active scope=${formatScopeName(activeScopeID).cyan}`,
    `${"│".grey} active profile=${activeProfile?.name ?? "none"} · account=${shortAddress(summary.activeAccountAddress)}`,
    `${"│".grey} active public balances=${activePublicBalances}`,
    `${"│".grey} internal slot=${internalState?.currentIndex ?? "n/a"} · address=${shortAddress(
      internalState?.currentAddress,
    )}`,
    `${"│".grey} internal public balances=${internalPublicBalances}`,
    `${"│".grey} next best action=${suggestedAction}`,
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

const buildStealthAppManagerChoices = () => {
  const activeScopeID = getActiveEphemeralSessionScopeID();
  const activeProfile = getActiveStealthProfile();
  const activeProfileSummary = getStealthProfileSummary();
  const scopeChoices = collectStealthAppScopeIDs().map((scopeID) => {
    const addresses = getKnownAddressesForScope(scopeID);
    const profileCount = getProfilesForScope(scopeID).length;
    const activeTag = scopeID === activeScopeID ? "[ACTIVE]".green : "";
    return {
      name: `scope:${scopeID}`,
      message: [
        formatScopeName(scopeID).cyan,
        `addresses=${addresses.length}`,
        `profiles=${profileCount}`,
        activeTag,
      ]
        .filter((part) => part.length > 0)
        .join(" · "),
    };
  });

  const choices: any[] = [
    {
      message: ` >> ${"Scopes".grey.bold} <<`,
      role: "separator",
    },
    ...scopeChoices,
    { name: "create-user-scope", message: "Create user-defined scope" },
    {
      message: ` >> ${"Profiles".grey.bold} <<`,
      role: "separator",
    },
    { name: "manage-profiles", message: `Manage profiles (${activeProfileSummary.total})` },
    { name: "set-active-profile", message: `Set active profile (${activeProfile?.name ?? "none"})` },
  ];

  if (activeProfileSummary.hasActiveLinkedAddress) {
    choices.push({
      name: "active-profile-actions",
      message: `Open active profile actions (${activeProfile?.name ?? "linked profile"})`.cyan,
    });
  }

  choices.push({ name: "exit-menu", message: "Go Back".grey });
  return choices;
};

const promptCreateUserScope = async (): Promise<Optional<string>> => {
  const prompt = new Input({
    header: " ",
    message: "New user scope ID (1 or greater)",
    validate: (value: string) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 1;
    },
  });

  const scopeInput = (await prompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(scopeInput)) {
    return undefined;
  }

  return scopeInput.trim();
};

const buildStealthScopeHeader = async (scopeID: string) => {
  const isActiveScope = getActiveEphemeralSessionScopeID() === scopeID;
  const scope = isLegacyUnscopedScope(scopeID)
    ? undefined
    : getEphemeralSessionScope(scopeID);
  const addresses = getKnownAddressesForScope(scopeID);
  const profiles = getProfilesForScope(scopeID);
  const referenceAddress = scope?.lastKnownAddress ?? addresses[0]?.address;
  const publicBalances = await formatPublicBalanceSummary(referenceAddress);

  return [
    `${"┌─".grey} ${formatScopeName(scopeID).cyan} ${"(Scope View)".dim}`,
    `${"│".grey} active=${isActiveScope ? "yes".green : "no".grey} · addresses=${addresses.length} · profiles=${profiles.length}`,
    `${"│".grey} last index=${scope?.lastKnownIndex ?? "n/a"} · ratchets=${scope?.ratchetCount ?? 0}`,
    `${"│".grey} last address=${shortAddress(referenceAddress)} · balances=${publicBalances}`,
    ...(isLegacyUnscopedScope(scopeID)
      ? [`${"│".grey} legacy profiles without explicit scope metadata`]
      : []),
    `${"└─".grey}`,
  ].join("\n");
};

const buildStealthScopeChoices = (scopeID: string) => {
  const addresses = getKnownAddressesForScope(scopeID);
  const activeProfileID = getStealthProfileSummary().activeProfileID;
  const choices: any[] = isLegacyUnscopedScope(scopeID)
    ? []
    : [
      {
        name: "set-active-scope",
        message: getActiveEphemeralSessionScopeID() === scopeID
          ? `Active scope = ${formatScopeName(scopeID)}`.green
          : `Set active scope to ${formatScopeName(scopeID)}`,
      },
      { name: "poll-scope", message: "Poll scope".cyan },
      { name: "manual-ratchet", message: "Ratchet scope" },
      { name: "set-index", message: "Set scope index" },
      { name: "scope-policy", message: "Update ratchet policy" },
    ];

  if (!isLegacyUnscopedScope(scopeID) && scopeID !== getDefaultActiveStealthScopeID()) {
    choices.push({ name: "remove-scope", message: "Remove scope" });
  }

  if (addresses.length) {
    choices.push(
      {
        message: ` >> ${"Addresses".grey.bold} <<`,
        role: "separator",
      },
      ...addresses.map((entry) => ({
        name: `address:${entry.key}`,
        message: formatScopeAddressEntry(entry, activeProfileID),
      })),
    );
  }

  choices.push({ name: "exit-menu", message: "Go Back".grey });
  return choices;
};

const pollScopeAddress = async (
  scopeID: string,
  entry?: StealthScopeAddressEntry,
) => {
  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) {
    return undefined;
  }

  const knownIndex = entry?.knownIndex;
  if (isDefined(knownIndex)) {
    return setEphemeralWalletIndex(encryptionKey, knownIndex, scopeID).catch(
      (error) => {
        console.log(`Failed to poll address: ${(error as Error).message}`.yellow);
        return undefined;
      },
    );
  }

  if (isLegacyUnscopedScope(scopeID)) {
    return undefined;
  }

  return setCurrentEphemeralWalletSession(encryptionKey, scopeID).catch((error) => {
    console.log(`Failed to poll scope: ${(error as Error).message}`.yellow);
    return undefined;
  });
};

const runScopeAddressPrompt = async (
  scopeID: string,
  entry: StealthScopeAddressEntry,
): Promise<void> => {
  setActiveEphemeralSessionScopeID(scopeID);
  if (isDefined(entry.profileID)) {
    setActiveStealthProfile(entry.profileID);
  }

  await pollScopeAddress(scopeID, entry);
  const publicBalances = await formatPublicBalanceSummary(entry.address);
  const profile = isDefined(entry.profileID) ? getStealthProfile(entry.profileID) : undefined;

  const prompt = new Select({
    header: [
      `${"┌─ Address Profile".grey} ${"(Scope Selection)".dim}`,
      `${"│".grey} scope=${formatScopeName(scopeID).cyan}`,
      `${"│".grey} address=${entry.address}`,
      `${"│".grey} profile=${profile?.name ?? "none"} · balances=${publicBalances}`,
      `${"└─".grey}`,
    ].join("\n"),
    message: "Address actions",
    choices: [
      {
        name: "set-active-profile",
        message: isDefined(profile)
          ? `Set active profile (${profile.name})`
          : "No linked profile".grey,
        disabled: !isDefined(profile),
      },
      {
        name: "profile-funds",
        message: isDefined(profile)
          ? `Open profile balances & actions (${profile.name})`.cyan
          : "No linked profile actions".grey,
        disabled: !isDefined(profile),
      },
      { name: "repoll", message: "Poll address again" },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  switch (selection) {
    case "set-active-profile": {
      if (isDefined(profile)) {
        setActiveStealthProfile(profile.id);
        console.log(`Active profile set to ${profile.name}.`.green);
        await confirmPromptCatchRetry("");
      }
      return runScopeAddressPrompt(scopeID, entry);
    }
    case "profile-funds": {
      if (!isDefined(profile)) {
        return runScopeAddressPrompt(scopeID, entry);
      }
      setActiveStealthProfile(profile.id);
      await runActiveStealthProfilePrompt();
      return;
    }
    case "repoll": {
      await pollScopeAddress(scopeID, entry);
      return runScopeAddressPrompt(scopeID, entry);
    }
    default: {
      return;
    }
  }
};

const runStealthScopePrompt = async (scopeID: string): Promise<void> => {
  const prompt = createLiveSelect({
    header: () => buildStealthScopeHeader(scopeID),
    message: formatScopeName(scopeID),
    choices: () => buildStealthScopeChoices(scopeID),
    multiple: false,
    refreshIntervalMs: 1200,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  if (selection.startsWith("address:")) {
    const key = selection.slice("address:".length);
    const entry = getKnownAddressesForScope(scopeID).find((item) => item.key === key);
    if (isDefined(entry)) {
      await runScopeAddressPrompt(scopeID, entry);
    }
    return runStealthScopePrompt(scopeID);
  }

  switch (selection) {
    case "set-active-scope": {
      setActiveEphemeralSessionScopeID(scopeID);
      console.log(`Active scope set to ${formatScopeName(scopeID)}.`.green);
      await confirmPromptCatchRetry("");
      return runStealthScopePrompt(scopeID);
    }
    case "poll-scope": {
      setActiveEphemeralSessionScopeID(scopeID);
      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runStealthScopePrompt(scopeID);
      }
      const synced = await syncCurrentEphemeralWallet(encryptionKey, scopeID);
      if (!isDefined(synced)) {
        console.log(`Failed to poll ${formatScopeName(scopeID)}.`.yellow);
      } else {
        console.log(`Polled ${formatScopeName(scopeID)} @ slot ${synced.currentIndex}: ${synced.currentAddress}`.green);
      }
      await confirmPromptCatchRetry("");
      return runStealthScopePrompt(scopeID);
    }
    case "manual-ratchet": {
      setActiveEphemeralSessionScopeID(scopeID);
      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runStealthScopePrompt(scopeID);
      }
      const ratcheted = await manualRatchetEphemeralWallet(encryptionKey, scopeID);
      if (!isDefined(ratcheted)) {
        console.log(`Failed to ratchet ${formatScopeName(scopeID)}.`.yellow);
      } else {
        console.log(`Ratcheted ${formatScopeName(scopeID)} to slot ${ratcheted.currentIndex}: ${ratcheted.currentAddress}`.green);
      }
      await confirmPromptCatchRetry("");
      return runStealthScopePrompt(scopeID);
    }
    case "set-index": {
      setActiveEphemeralSessionScopeID(scopeID);
      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        return runStealthScopePrompt(scopeID);
      }

      const indexPrompt = new Input({
        header: " ",
        message: `Set index for ${formatScopeName(scopeID)}`,
        validate: (value: string) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) && parsed >= 0;
        },
      });

      const indexInput = (await indexPrompt.run().catch(confirmPromptCatch)) as
        | string
        | undefined;
      if (!isDefined(indexInput)) {
        return runStealthScopePrompt(scopeID);
      }

      const next = await setEphemeralWalletIndex(encryptionKey, Number(indexInput), scopeID).catch(
        (error) => {
          console.log(`Failed to set scope index: ${(error as Error).message}`.yellow);
          return undefined;
        },
      );

      if (isDefined(next)) {
        console.log(`Set ${formatScopeName(scopeID)} to slot ${next.currentIndex}: ${next.currentAddress}`.green);
        await confirmPromptCatchRetry("");
      }
      return runStealthScopePrompt(scopeID);
    }
    case "scope-policy": {
      setActiveEphemeralSessionScopeID(scopeID);
      upsertEphemeralSessionScope(scopeID);
      await promptAndApplyScopePolicyForScope(scopeID);
      return runStealthScopePrompt(scopeID);
    }
    case "remove-scope": {
      const confirmed = await confirmPrompt(`Remove ${formatScopeName(scopeID)}?`, {
        initial: false,
      });
      if (!confirmed) {
        return runStealthScopePrompt(scopeID);
      }

      const removed = removeEphemeralSessionScope(scopeID);
      console.log(
        removed
          ? `Removed ${formatScopeName(scopeID)}.`.green
          : `${formatScopeName(scopeID)} was not found.`.yellow,
      );
      await confirmPromptCatchRetry("");
      return;
    }
    default: {
      return;
    }
  }
};

const buildExternalStealthProfileChoices = () => {
  const summary = getStealthProfileSummary();
  const activeProfile = getActiveStealthProfile();
  const activeScopeID = getActiveEphemeralSessionScopeID();
  const scopedProfiles = getStealthProfilesForScope(activeScopeID);
  const activeSignerScopeID = activeProfile?.signerStrategyScopeID;
  const choices: any[] = [
    {
      name: "create-profile",
      message: summary.total === 0 ? "Create your first profile".green : "Create profile",
    },
  ];

  if (summary.total > 0) {
    choices.push(
      {
        message: ` >> ${"Profiles".grey.bold} <<`,
        role: "separator",
      },
      {
        name: "open-active-profile",
        message: activeProfile
          ? `Open active profile (${activeProfile.name})`.cyan
          : "Open active profile".grey,
        disabled: !isDefined(activeProfile),
      },
      {
        name: "list-scope-profiles",
        message: `View profiles in ${formatScopeName(activeScopeID)} (${scopedProfiles.length})`,
      },
      { name: "list-profiles", message: `View all profiles (${summary.total})` },
      { name: "edit-profile", message: "Edit profile" },
      { name: "set-active", message: "Choose active profile" },
      { name: "remove-profile", message: "Remove profile" },
    );
  }

  if (summary.hasActiveLinkedAddress) {
    choices.push(
      {
        message: ` >> ${"Active Profile Funds".grey.bold} <<`,
        role: "separator",
      },
      { name: "funds-menu", message: `Manage funds for ${activeProfile?.name ?? "active profile"}` },
    );
  }

  if (isDefined(activeSignerScopeID)) {
    choices.push(
      {
        message: ` >> ${"Signer Tools".grey.bold} <<`,
        role: "separator",
      },
      {
        name: "activate-profile-signer",
        message: `Activate signer strategy (${activeSignerScopeID})`,
      },
    );
  }

  choices.push({ name: "exit-menu", message: "Go Back".grey });
  return choices;
};

const buildExternalStealthProfilesHeader = async () => {
  const summary = getStealthProfileSummary();
  const activeScopeID = getActiveEphemeralSessionScopeID();
  const activeProfile = getActiveStealthProfile();
  const scopeProfiles = getProfilesForScope(activeScopeID);
  const activeBalances = await formatPublicBalanceSummary(activeProfile?.accountAddress);

  return [
    `${"┌─ External Profiles".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} active scope=${formatScopeName(activeScopeID).cyan} · in-scope profiles=${scopeProfiles.length} · total=${summary.total}`,
    `${"│".grey} active profile=${activeProfile?.name ?? "none"} · address=${shortAddress(activeProfile?.accountAddress)}`,
    `${"│".grey} active public balances=${activeBalances}`,
    `${"└─".grey}`,
  ].join("\n");
};

const buildActiveStealthProfileHeader = async () => {
  const activeProfile = getActiveStealthProfile();
  const activeScopeID = getActiveEphemeralSessionScopeID();

  if (!isDefined(activeProfile)) {
    return [
      `${"┌─ Active Profile".grey} ${"(Interactive Card)".dim}`,
      `${"│".grey} no active profile selected`,
      `${"└─".grey}`,
    ].join("\n");
  }

  const preferredScopeID = getProfileScopeID(activeProfile) ?? activeScopeID;
  const publicBalances = await formatPublicBalanceSummary(activeProfile.accountAddress);

  return [
    `${"┌─ Active Profile".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} profile=${activeProfile.name.cyan} · account=${shortAddress(activeProfile.accountAddress)}`,
    `${"│".grey} profile scope=${formatScopeName(preferredScopeID).cyan} · active scope=${formatScopeName(activeScopeID).cyan}`,
    `${"│".grey} public balances=${publicBalances}`,
    `${"└─".grey}`,
  ].join("\n");
};

const buildActiveStealthProfileChoices = () => {
  const activeProfile = getActiveStealthProfile();
  const choices: any[] = [
    { name: "fund-unshield-eth", message: "Fund with private ETH" },
    { name: "fund-unshield-erc20", message: "Fund with private ERC20" },
    { name: "withdraw-reshield-eth", message: "Withdraw ETH to private balance" },
    { name: "withdraw-reshield-erc20", message: "Withdraw ERC20 to private balance" },
  ];

  if (isDefined(activeProfile)) {
    choices.push(
      {
        message: ` >> ${"Profile State".grey.bold} <<`,
        role: "separator",
      },
      { name: "set-profile-active-scope", message: "Set active scope to this profile" },
      { name: "edit-profile", message: `Edit profile (${activeProfile.name})` },
    );
  }

  choices.push({ name: "exit-menu", message: "Go Back".grey });
  return choices;
};

const runActiveStealthProfilePrompt = async (): Promise<void> => {
  const activeProfile = getActiveStealthProfile();
  if (!isDefined(activeProfile)) {
    console.log("No active stealth profile selected.".yellow);
    await confirmPromptCatchRetry("");
    return;
  }

  const prompt = createLiveSelect({
    header: buildActiveStealthProfileHeader,
    message: `Profile: ${activeProfile.name}`,
    choices: buildActiveStealthProfileChoices,
    multiple: false,
    refreshIntervalMs: 1200,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  switch (selection) {
    case "fund-unshield-erc20": {
      await runFundUnshieldERC20ForActiveProfile();
      return runActiveStealthProfilePrompt();
    }
    case "fund-unshield-eth": {
      await runFundUnshieldETHForActiveProfile();
      return runActiveStealthProfilePrompt();
    }
    case "withdraw-reshield-erc20": {
      await runWithdrawReshieldERC20FromProfile();
      return runActiveStealthProfilePrompt();
    }
    case "withdraw-reshield-eth": {
      await runWithdrawReshieldETHFromProfile();
      return runActiveStealthProfilePrompt();
    }
    case "set-profile-active-scope": {
      const preferredScopeID = getProfileScopeID(activeProfile);
      const nextScopeID = preferredScopeID ?? getActiveEphemeralSessionScopeID();
      setActiveEphemeralSessionScopeID(nextScopeID);
      console.log(`Active scope set to ${formatScopeName(nextScopeID)} for ${activeProfile.name}.`.green);
      await confirmPromptCatchRetry("");
      return runActiveStealthProfilePrompt();
    }
    case "edit-profile": {
      const profileInput = await promptStealthProfileInput(activeProfile);
      if (!isDefined(profileInput)) {
        return runActiveStealthProfilePrompt();
      }

      upsertStealthProfile({
        ...profileInput,
        id: activeProfile.id,
      });
      console.log(`Updated profile ${activeProfile.name}.`.green);
      await confirmPromptCatchRetry("");
      return runActiveStealthProfilePrompt();
    }
    default: {
      return;
    }
  }
};

const buildStealthManagerChoices = () => {
  const summary = getStealthProfileSummary();
  const activeProfile = getActiveStealthProfile();
  const choices: any[] = [];

  if (!summary.total) {
    choices.push({ name: "quick-profiles", message: "Create your first stealth profile".green });
  } else if (summary.hasActiveLinkedAddress) {
    choices.push({
      name: "quick-funds",
      message: `Active profile funds${activeProfile ? ` (${activeProfile.name})` : ""}`.cyan,
    });
  } else if (!summary.activeProfileID) {
    choices.push({ name: "quick-profiles", message: "Choose an active stealth profile".yellow });
  } else {
    choices.push({ name: "quick-profiles", message: "Link or generate address for active profile".yellow });
  }

  choices.push(
    {
      message: ` >> ${"Stealth Accounts".grey.bold} <<`,
      role: "separator",
    },
    {
      name: "external-profiles",
      message: `Manage stealth profiles (${summary.total})`,
    },
  );

  if (summary.hasActiveLinkedAddress) {
    choices.push({
      name: "funds-menu",
      message: "Manage active profile funds",
    });
  }

  choices.push(
    {
      message: ` >> ${"Internal Tools".grey.bold} <<`,
      role: "separator",
    },
    {
      name: "internal-tools",
      message: "Manage internal slots, sync, and scopes",
    },
    { name: "exit-menu", message: "Go Back".grey },
  );

  return choices;
};

const buildInternalStealthToolsHeader = async () => {
  const state = getCurrentKnownEphemeralState();
  const internalPublicBalances = await formatPublicBalanceSummary(
    state?.currentAddress,
  );
  const knownCount = getKnownEphemeralAddresses().length;
  const scopeCount = listEphemeralSessionScopes().length;

  return [
    `${"┌─ Internal Stealth Tools".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} current slot=${state?.currentIndex ?? "n/a"} · known addresses=${knownCount} · scopes=${scopeCount}`,
    `${"│".grey} current address=${shortAddress(state?.currentAddress)}`,
    `${"│".grey} public balances=${internalPublicBalances}`,
    `${"│".grey} next best action=${(state?.currentAddress ? "Sync or ratchet current slot" : "Sync current slot first").cyan}`,
    `${"└─".grey}`,
  ].join("\n");
};

const buildInternalStealthToolChoices = () => {
  const state = getCurrentKnownEphemeralState();
  const knownCount = getKnownEphemeralAddresses().length;
  const scopeCount = listEphemeralSessionScopes().length;

  const choices: any[] = [
    {
      name: "sync-current",
      message: state?.currentAddress
        ? "Sync current internal stealth account".cyan
        : "Sync current internal stealth account".green,
    },
    { name: "manual-ratchet", message: "Ratchet to next internal slot" },
    { name: "set-index", message: "Set specific internal slot" },
  ];

  if (knownCount > 0) {
    choices.push(
      {
        message: ` >> ${"Known Accounts".grey.bold} <<`,
        role: "separator",
      },
      { name: "show-known", message: `View known internal slots (${knownCount})` },
      { name: "lookup-index", message: "Find slot by address" },
    );
  }

  choices.push(
    {
      message: ` >> ${"Scopes".grey.bold} <<`,
      role: "separator",
    },
    { name: "manage-scopes", message: `Manage scopes & ratchet policy (${scopeCount})` },
    { name: "exit-menu", message: "Go Back".grey },
  );

  return choices;
};

const buildInternalScopeManagerHeader = () => {
  const scopes = listEphemeralSessionScopes();
  const strategyScopes = listScopedEphemeralWalletDerivationStrategyScopeIDs();

  return [
    `${"┌─ Internal Scope Manager".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} scopes=${scopes.length.toString().cyan} · signer strategies=${strategyScopes.length.toString().magenta}`,
    `${"│".grey} ${scopes.length ? "most recent scopes:" : "no internal stealth scopes configured yet.".grey}`,
    ...(scopes.slice(0, 3).map((scope) => {
      const strategyStatus = hasScopedEphemeralWalletDerivationStrategy(scope.scopeID)
        ? "strategy".green
        : "no-strategy".yellow;
      return `${"│".grey} • ${scope.scopeID.cyan} · idx=${scope.lastKnownIndex ?? "n/a"} · ${strategyStatus}`;
    })),
    `${"└─".grey}`,
  ].join("\n");
};

const buildInternalScopeManagerChoices = () => {
  const scopes = listEphemeralSessionScopes();
  const strategyScopes = listScopedEphemeralWalletDerivationStrategyScopeIDs();
  const choices: any[] = [
    {
      name: "upsert-policy",
      message: scopes.length ? "Create or update scope ratchet policy" : "Create first scope policy".green,
    },
  ];

  if (scopes.length > 0) {
    choices.push(
      {
        message: ` >> ${"Scopes".grey.bold} <<`,
        role: "separator",
      },
      { name: "list", message: `View scopes (${scopes.length})` },
      { name: "remove", message: "Remove scope" },
    );
  }

  if (strategyScopes.length > 0) {
    choices.push(
      {
        message: ` >> ${"Signer Strategies".grey.bold} <<`,
        role: "separator",
      },
      { name: "activate-signer", message: "Activate scope signer strategy" },
      { name: "show-strategy-scopes", message: `View scopes with signer strategies (${strategyScopes.length})` },
    );
  }

  choices.push({ name: "exit-menu", message: "Go Back".grey });
  return choices;
};

const selectStealthProfileID = async (
  message: string,
  profiles = listStealthProfiles(),
): Promise<Optional<string>> => {
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

const promptStealthProfileScopeMode = async (existing?: {
  scopeID?: string;
  slot?: number;
}) => {
  const activeScopeID = getActiveEphemeralSessionScopeID();
  const existingHasSlot = isDefined(existing?.slot);
  const existingScopeID = existing?.scopeID?.trim();
  const defaultChoice = isLegacyUnscopedProfile(existing ?? {})
    ? "legacy-unscoped"
    : existingHasSlot
    ? "slot-derived"
    : existingScopeID && existingScopeID !== activeScopeID
      ? "custom-scope"
      : "active-scope";

  const modePrompt = new Select({
    header: " ",
    message: "Profile scope mode",
    choices: [
      {
        name: "active-scope",
        message: `Use active scope (${formatScopeName(activeScopeID)})`,
      },
      {
        name: "custom-scope",
        message: "Use a custom explicit scope ID",
      },
      {
        name: "slot-derived",
        message: "Derive from slot number (slot-<n>)",
      },
      {
        name: "legacy-unscoped",
        message: "Keep profile unscoped (legacy compatibility)",
      },
    ],
    initial: defaultChoice,
    multiple: false,
  });

  const mode = (await modePrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(mode)) {
    return undefined;
  }

  if (mode === "active-scope") {
    return {
      scopeID: activeScopeID,
      slot: undefined,
    };
  }

  if (mode === "custom-scope") {
    const scopeID = await promptOptionalText(
      "Custom scope ID",
      existingScopeID && existingScopeID !== activeScopeID ? existingScopeID : "",
    );
    if (!isDefined(scopeID)) {
      return undefined;
    }

    return {
      scopeID,
      slot: undefined,
    };
  }

  if (mode === "legacy-unscoped") {
    return {
      scopeID: undefined,
      slot: undefined,
    };
  }

  const slotPrompt = new Input({
    header: " ",
    message: "Slot number for slot-derived scope",
    initial: isDefined(existing?.slot) ? String(existing?.slot) : "",
    validate: (value: string) => {
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

  return {
    scopeID: undefined,
    slot: Number(slotInput),
  };
};

const resolveGeneratedStealthProfileAddress = async (
  slot?: number,
  scopeID?: string,
): Promise<Optional<string>> => {
  const derivedScopeID = isDefined(scopeID)
    ? scopeID
    : isDefined(slot)
    ? slotToScopeID(slot)
    : getActiveEphemeralSessionScopeID();

  if (isDefined(slot)) {
    const encryptionKey = await getSaltedPassword();
    if (!isDefined(encryptionKey)) {
      return undefined;
    }
    let updated;
    try {
      updated = await setEphemeralWalletIndex(
        encryptionKey,
        slot,
        derivedScopeID,
      );
    } catch (error) {
      if (!isCancelLifecycleError(error)) {
        console.log(`Failed to generate address for slot ${slot}: ${(error as Error).message}`.yellow);
      }
      return undefined;
    }
    return updated?.currentAddress;
  }

  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) {
    return undefined;
  }
  let synced;
  try {
    synced = await syncCurrentEphemeralWallet(encryptionKey, derivedScopeID);
  } catch (error) {
    if (!isCancelLifecycleError(error)) {
      console.log(`Failed to sync stealth address: ${(error as Error).message}`.yellow);
    }
    return undefined;
  }
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

  const scopeMode = await promptStealthProfileScopeMode(existing);
  if (!isDefined(scopeMode)) {
    return undefined;
  }

  const { scopeID: scopeInput, slot } = scopeMode;

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
  const prompt = createLiveSelect({
    header: buildExternalStealthProfilesHeader,
    message: "External Profiles",
    choices: buildExternalStealthProfileChoices,
    multiple: false,
    refreshIntervalMs: 1200,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  switch (selection) {
    case "open-active-profile": {
      await runActiveStealthProfilePrompt();
      return runExternalStealthProfileManagerPrompt();
    }
    case "list-scope-profiles": {
      printStealthProfilesForScope(getActiveEphemeralSessionScopeID());
      await confirmPromptCatchRetry("");
      return runExternalStealthProfileManagerPrompt();
    }
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
    case "funds-menu": {
      await runActiveStealthProfilePrompt();
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

      const strategyScopeID = getCurrentChainScopedScopeID(
        activeProfile.signerStrategyScopeID,
      );
      if (!isDefined(strategyScopeID)) {
        console.log("Active profile has no usable signer strategy scope ID.".yellow);
        await confirmPromptCatchRetry("");
        return runExternalStealthProfileManagerPrompt();
      }
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

const promptAndApplyScopePolicyForScope = async (scopeID: string) => {
  upsertEphemeralSessionScope(scopeID);

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

  setEphemeralSessionRatchetPolicy(scopeID, {
    enabled,
    broadcastMode: mode,
    ratchetOnTransactions: txSelection,
  });
  console.log(`Updated scope policy for ${scopeID}.`.green);
  await confirmPromptCatchRetry("");
};

const promptAndApplyScopePolicy = async () => {
  const scopeSelection = await promptOptionalScopeSelection();
  if (scopeSelection.aborted || !isDefined(scopeSelection.scopeID)) {
    return;
  }

  return promptAndApplyScopePolicyForScope(scopeSelection.scopeID);
};

const runInternalScopeManagerPrompt = async (): Promise<void> => {
  const prompt = createLiveSelect({
    header: buildInternalScopeManagerHeader,
    message: "Internal Scope Tools",
    choices: buildInternalScopeManagerChoices,
    multiple: false,
    refreshIntervalMs: 1200,
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
  const prompt = createLiveSelect({
    header: buildInternalStealthToolsHeader,
    message: "Internal Stealth Tools",
    choices: buildInternalStealthToolChoices,
    multiple: false,
    refreshIntervalMs: 1200,
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
  const prompt = createLiveSelect({
    header: buildStealthCardHeader,
    message: "Stealth App Manager",
    choices: buildStealthAppManagerChoices,
    multiple: false,
    refreshIntervalMs: 1200,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  if (selection.startsWith("scope:")) {
    const scopeID = selection.slice("scope:".length);
    await runStealthScopePrompt(scopeID);
    return runEphemeralManagerPrompt();
  }

  switch (selection) {
    case "manage-profiles": {
      await runExternalStealthProfileManagerPrompt();
      return runEphemeralManagerPrompt();
    }
    case "set-active-profile": {
      const profileID = await selectStealthProfileID("Set active profile");
      if (isDefined(profileID)) {
        const profile = setActiveStealthProfile(profileID);
        console.log(`Active profile set to ${profile.name} (${profile.id}).`.green);
        await confirmPromptCatchRetry("");
      }
      return runEphemeralManagerPrompt();
    }
    case "active-profile-actions": {
      await runActiveStealthProfilePrompt();
      return runEphemeralManagerPrompt();
    }
    case "create-user-scope": {
      const scopeID = await promptCreateUserScope();
      if (!isDefined(scopeID)) {
        return runEphemeralManagerPrompt();
      }

      upsertEphemeralSessionScope(scopeID);
      setActiveEphemeralSessionScopeID(scopeID);
      console.log(`Created ${formatScopeName(scopeID)} and set it active.`.green);
      await confirmPromptCatchRetry("");
      return runEphemeralManagerPrompt();
    }
    default: {
      return;
    }
  }
};
