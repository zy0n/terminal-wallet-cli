import { isDefined } from "@railgun-community/shared-models";
import {
  approveWalletConnectSessionProposal,
  disconnectWalletConnectSession,
  getWalletConnectSessionSummary,
  getWalletConnectPendingSessionProposals,
  initializeWalletConnectKit,
  listWalletConnectSessions,
  pairWalletConnectURI,
  rejectWalletConnectSessionProposal,
} from "../walletconnect/walletconnect-bridge";
import { confirmPrompt, confirmPromptCatch, confirmPromptCatchRetry } from "./confirm-ui";
import { getCurrentWalletPublicAddress } from "../wallet/wallet-util";
import {
  getCurrentKnownEphemeralState,
  syncCurrentEphemeralWallet,
} from "../wallet/ephemeral-wallet-manager";
import { getSaltedPassword } from "../wallet/wallet-password";
import {
  getActiveStealthProfile,
  listStealthProfiles,
  setActiveStealthProfile,
} from "../wallet/stealth-profile-manager";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Input, Select } = require("enquirer");

const shortAddress = (address?: string) => {
  if (!isDefined(address) || address.length < 12) {
    return "n/a";
  }
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
};

const formatSessionLine = (session: {
  topic: string;
  version: number;
  relayProtocol?: string;
  connectedAddress?: string;
  scopeID?: string;
  status: string;
  updatedAt: number;
}) => {
  const updatedAt = new Date(session.updatedAt).toISOString();
  const accountInfo = session.connectedAddress
    ? ` · account=${session.connectedAddress}`
    : "";
  const scopeInfo = session.scopeID ? ` · scope=${session.scopeID}` : "";
  const relayInfo = session.relayProtocol ? ` · relay=${session.relayProtocol}` : "";
  return `${session.topic} · v${session.version} · ${session.status}${accountInfo}${scopeInfo}${relayInfo} · updated=${updatedAt}`;
};

const printWalletConnectSessions = () => {
  const sessions = listWalletConnectSessions();
  if (!sessions.length) {
    console.log("No WalletConnect sessions found.".yellow);
    return;
  }

  sessions.forEach((session) => {
    console.log(formatSessionLine(session).grey);
  });
};

const buildWalletConnectCardHeader = async () => {
  try {
    await initializeWalletConnectKit();
  } catch {
    // show cached card state if WalletConnect runtime cannot initialize yet
  }

  const summary = getWalletConnectSessionSummary();
  const sessions = listWalletConnectSessions().slice(0, 3);
  const pendingCount = summary.pendingProposals;

  const cardRows = [
    `${"┌─ WalletConnect Console".grey} ${"(Interactive Card)".dim}`,
    `${"│".grey} paired=${summary.paired.toString().green} disconnected=${summary.disconnected
      .toString()
      .grey} scoped=${summary.scoped.toString().cyan} pending=${pendingCount
      .toString()
      .yellow}`,
    `${"│".grey} latest-account=${shortAddress(summary.latestConnectedAddress)}`,
  ];

  if (!sessions.length) {
    cardRows.push(`${"│".grey} sessions: none`);
  } else {
    cardRows.push(`${"│".grey} recent sessions:`);
    sessions.forEach((session) => {
      const statusColor = session.status === "paired" ? "green" : "grey";
      cardRows.push(
        `${"│".grey} - ${session.topic.slice(0, 16)}... ${
          session.status[statusColor]
        } ${session.scopeID ? `scope=${session.scopeID}` : ""}`.trimEnd(),
      );
    });
  }

  cardRows.push(`${"└─".grey}`);
  return cardRows.join("\n");
};

const printPendingWalletConnectProposals = async () => {
  const proposals = await getWalletConnectPendingSessionProposals();
  if (!proposals.length) {
    console.log("No pending WalletConnect session proposals.".yellow);
    return;
  }

  proposals.forEach((proposal) => {
    const requiredNamespaces = Object.keys(proposal.requiredNamespaces).join(", ");
    const optionalNamespaces = Object.keys(proposal.optionalNamespaces ?? {}).join(", ");
    console.log(
      [
        `Proposal #${proposal.id} from ${proposal.proposerName}`,
        `pairingTopic=${proposal.pairingTopic}`,
        `required=[${requiredNamespaces || "none"}]`,
        `optional=[${optionalNamespaces || "none"}]`,
      ].join(" · ").grey,
    );
  });
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => {
    return typeof item === "string";
  }) as string[];
};

const printProposalPermissions = (proposal: {
  id: number;
  proposerName: string;
  proposerUrl: string;
  requiredNamespaces: Record<string, unknown>;
  optionalNamespaces?: Record<string, unknown>;
}) => {
  console.log(`Reviewing proposal #${proposal.id} from ${proposal.proposerName}`.cyan);
  console.log(`Proposer URL: ${proposal.proposerUrl}`.grey);

  const printNamespaceBlock = (
    label: string,
    namespaces: Record<string, unknown>,
  ) => {
    const namespaceEntries = Object.entries(namespaces);
    if (!namespaceEntries.length) {
      console.log(`${label}: none`.grey);
      return;
    }

    console.log(`${label}:`.yellow);
    namespaceEntries.forEach(([namespaceKey, rawNamespace]) => {
      const namespace = rawNamespace as {
        chains?: unknown;
        methods?: unknown;
        events?: unknown;
      };
      const chains = toStringArray(namespace.chains);
      const methods = toStringArray(namespace.methods);
      const events = toStringArray(namespace.events);

      console.log(
        [
          `  ${namespaceKey}`,
          `chains=[${chains.join(", ") || "none"}]`,
          `methods=[${methods.join(", ") || "none"}]`,
          `events=[${events.join(", ") || "none"}]`,
        ].join(" · ").grey,
      );
    });
  };

  printNamespaceBlock("Required", proposal.requiredNamespaces);
  printNamespaceBlock("Optional", proposal.optionalNamespaces ?? {});
};

const selectPendingProposalID = async (): Promise<Optional<number>> => {
  const proposals = await getWalletConnectPendingSessionProposals();
  if (!proposals.length) {
    console.log("No pending WalletConnect session proposals.".yellow);
    return undefined;
  }

  const prompt = new Select({
    header: " ",
    message: "Select pending WalletConnect proposal",
    choices: [
      ...proposals.map((proposal) => ({
        name: proposal.id.toString(),
        message: `#${proposal.id} ${proposal.proposerName} (${proposal.pairingTopic})`,
      })),
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return undefined;
  }

  const proposalID = Number(selection);
  if (!Number.isInteger(proposalID)) {
    return undefined;
  }
  return proposalID;
};

const runApprovePrompt = async () => {
  const proposalID = await selectPendingProposalID();
  if (!isDefined(proposalID)) {
    return;
  }

  const proposals = await getWalletConnectPendingSessionProposals();
  const selectedProposal = proposals.find((proposal) => {
    return proposal.id === proposalID;
  });
  if (!isDefined(selectedProposal)) {
    console.log(`Proposal #${proposalID} not found.`.yellow);
    return;
  }

  printProposalPermissions(selectedProposal);
  const confirmApprove = await confirmPrompt(
    `Approve WalletConnect proposal #${proposalID}?`,
    { initial: false },
  );
  if (!confirmApprove) {
    console.log("Approval canceled.".yellow);
    return;
  }

  const accountPrompt = new Select({
    header: " ",
    message: "Connect using which account?",
    choices: [
      { name: "public", message: `Public (${getCurrentWalletPublicAddress()})` },
      {
        name: "ephemeral",
        message: `Ephemeral (${getCurrentKnownEphemeralState()?.currentAddress ?? "not synced"})`,
      },
      {
        name: "stealth-profile",
        message: `Stealth Profile (${getActiveStealthProfile()?.name ?? "none active"})`,
      },
      { name: "exit-menu", message: "Cancel".grey },
    ],
    multiple: false,
  });

  const accountSelection = await accountPrompt.run().catch(confirmPromptCatch);
  if (!accountSelection || accountSelection === "exit-menu") {
    console.log("Approval canceled.".yellow);
    return;
  }

  let approvalAddress = getCurrentWalletPublicAddress();
  if (accountSelection === "ephemeral") {
    let ephemeralAddress = getCurrentKnownEphemeralState()?.currentAddress;
    if (!isDefined(ephemeralAddress)) {
      const shouldSyncEphemeral = await confirmPrompt(
        "No cached ephemeral address found. Sync now?",
        { initial: true },
      );
      if (!shouldSyncEphemeral) {
        console.log("Approval canceled (ephemeral not available).".yellow);
        return;
      }

      const encryptionKey = await getSaltedPassword();
      if (!isDefined(encryptionKey)) {
        console.log("Approval canceled (missing wallet password).".yellow);
        return;
      }

      const synced = await syncCurrentEphemeralWallet(encryptionKey);
      ephemeralAddress = synced?.currentAddress;
    }

    if (!isDefined(ephemeralAddress)) {
      console.log("Approval canceled (failed to resolve ephemeral address).".yellow);
      return;
    }

    approvalAddress = ephemeralAddress;
  }

  if (accountSelection === "stealth-profile") {
    const profiles = listStealthProfiles().filter((profile) => {
      return isDefined(profile.accountAddress);
    });
    if (!profiles.length) {
      console.log(
        "Approval canceled (no linked external stealth profiles configured).".yellow,
      );
      return;
    }

    const profilePrompt = new Select({
      header: " ",
      message: "Select external stealth profile",
      choices: [
        ...profiles.map((profile) => ({
          name: profile.id,
          message: `${profile.name} (${profile.accountAddress})${
            profile.scopeID ? ` · scope=${profile.scopeID}` : ""
          }`,
        })),
        { name: "exit-menu", message: "Cancel".grey },
      ],
      multiple: false,
    });

    const profileSelection = await profilePrompt.run().catch(confirmPromptCatch);
    if (!profileSelection || profileSelection === "exit-menu") {
      console.log("Approval canceled.".yellow);
      return;
    }

    const selectedProfile = profiles.find((profile) => profile.id === profileSelection);
    if (!isDefined(selectedProfile)) {
      console.log("Approval canceled (profile not found).".yellow);
      return;
    }
    if (!isDefined(selectedProfile.accountAddress)) {
      console.log("Approval canceled (selected profile is unlinked).".yellow);
      return;
    }

    setActiveStealthProfile(selectedProfile.id);
    approvalAddress = selectedProfile.accountAddress;
  }

  const scopePrompt = new Input({
    header: " ",
    message: "Optional stealth scope ID (blank for none)",
  });

  const scopeInput = (await scopePrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;

  const scopeID = isDefined(scopeInput) ? scopeInput.trim() : undefined;
  const approved = await approveWalletConnectSessionProposal(proposalID, {
    accountAddress: approvalAddress,
    scopeID: scopeID?.length ? scopeID : undefined,
  });

  console.log(
    `Approved proposal #${proposalID} -> topic ${approved.topic} via ${approved.accountAddress}`
      .green,
  );
  if (approved.scopeID) {
    console.log(`Scoped to ${approved.scopeID}`.grey);
  }
};

const runRejectPrompt = async () => {
  const proposalID = await selectPendingProposalID();
  if (!isDefined(proposalID)) {
    return;
  }

  const proposals = await getWalletConnectPendingSessionProposals();
  const selectedProposal = proposals.find((proposal) => {
    return proposal.id === proposalID;
  });
  if (isDefined(selectedProposal)) {
    const requiredNamespaceCount = Object.keys(
      selectedProposal.requiredNamespaces,
    ).length;
    const optionalNamespaceCount = Object.keys(
      selectedProposal.optionalNamespaces ?? {},
    ).length;
    console.log(
      [
        `Proposal #${proposalID}`,
        `proposer=${selectedProposal.proposerName}`,
        `required-namespaces=${requiredNamespaceCount}`,
        `optional-namespaces=${optionalNamespaceCount}`,
      ].join(" · ").yellow,
    );
  }

  const confirmReject = await confirmPrompt(
    `Reject WalletConnect proposal #${proposalID}?`,
    { initial: false },
  );
  if (!confirmReject) {
    console.log("Rejection canceled.".yellow);
    return;
  }

  await rejectWalletConnectSessionProposal(proposalID);
  console.log(`Rejected WalletConnect proposal #${proposalID}.`.green);
};

const runPairPrompt = async () => {
  const uriPrompt = new Input({
    header: " ",
    message: "Paste WalletConnect URI (wc:...)",
    validate: (value: string) => value.trim().startsWith("wc:"),
  });

  const wcURI = (await uriPrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;
  if (!isDefined(wcURI)) {
    return;
  }

  const scopePrompt = new Input({
    header: " ",
    message: "Optional stealth scope ID (blank for none)",
  });

  const scopeInput = (await scopePrompt.run().catch(confirmPromptCatch)) as
    | string
    | undefined;

  const scopeID = isDefined(scopeInput) ? scopeInput.trim() : undefined;
  const paired = await pairWalletConnectURI(wcURI.trim(), {
    scopeID: scopeID?.length ? scopeID : undefined,
  });

  console.log(
    `Paired WalletConnect topic ${paired.topic} (v${paired.version}) as ${paired.status}.`.green,
  );
  if (paired.scopeID) {
    console.log(`Scoped to ${paired.scopeID}`.grey);
  }
};

const runDisconnectPrompt = async () => {
  const sessions = listWalletConnectSessions().filter(
    (session) => session.status !== "disconnected",
  );

  if (!sessions.length) {
    console.log("No active WalletConnect sessions to disconnect.".yellow);
    return;
  }

  const prompt = new Select({
    header: " ",
    message: "Select WalletConnect session to disconnect",
    choices: [
      ...sessions.map((session) => ({
        name: session.topic,
        message: formatSessionLine(session),
      })),
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  const disconnected = await disconnectWalletConnectSession(selection);
  if (!disconnected) {
    console.log("Session not found.".yellow);
    return;
  }

  console.log(`Disconnected WalletConnect topic ${selection}.`.green);
};

export const runWalletConnectManagerPrompt = async (): Promise<void> => {
  const cardHeader = await buildWalletConnectCardHeader();
  const summary = getWalletConnectSessionSummary();

  const prompt = new Select({
    header: cardHeader,
    message: "WalletConnect Tools (interactive)",
    choices: [
      {
        name: "pair",
        message: "Pair WalletConnect URI",
      },
      {
        name: "pending",
        message: `View Pending Session Proposals (${summary.pendingProposals})`,
      },
      {
        name: "approve",
        message: `Approve Pending Session Proposal (${summary.pendingProposals})`,
        disabled: summary.pendingProposals === 0 ? "No pending proposals" : false,
      },
      {
        name: "reject",
        message: `Reject Pending Session Proposal (${summary.pendingProposals})`,
        disabled: summary.pendingProposals === 0 ? "No pending proposals" : false,
      },
      {
        name: "list",
        message: `List WalletConnect Sessions (${summary.total})`,
      },
      {
        name: "disconnect",
        message: `Disconnect WalletConnect Session (${summary.paired} paired)`,
        disabled: summary.paired === 0 ? "No paired sessions" : false,
      },
      { name: "refresh-card", message: "Refresh Card".cyan },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const selection = await prompt.run().catch(confirmPromptCatch);
  if (!selection || selection === "exit-menu") {
    return;
  }

  try {
    await initializeWalletConnectKit();

    switch (selection) {
      case "pair":
        await runPairPrompt();
        break;
      case "refresh-card":
        break;
      case "list":
        printWalletConnectSessions();
        break;
      case "pending":
        await printPendingWalletConnectProposals();
        break;
      case "approve":
        await runApprovePrompt();
        break;
      case "reject":
        await runRejectPrompt();
        break;
      case "disconnect":
        await runDisconnectPrompt();
        break;
      default:
        break;
    }
  } catch (error) {
    console.log(`WalletConnect tools failed: ${(error as Error).message}`.red);
  }

  await confirmPromptCatchRetry("");
  return runWalletConnectManagerPrompt();
};
