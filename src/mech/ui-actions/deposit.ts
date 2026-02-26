import {
  delay,
  RailgunERC20Amount,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendBroadcastedTransaction, sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { populateUnshieldTransaction } from "../railgun-primitives";
import { findAvailableMech } from "../status";
import { pickBestBroadcaster } from "./cross-contract";
import { RailgunTransaction } from "../../models/transaction-models";

export async function depositIntoMech({
  /*
   * Assets to unshield FROM Railgun (these will be available in contract calls)
   */
  unshieldNFTs = [],
  unshieldERC20s = [],
}: {
  unshieldNFTs?: RailgunNFTAmount[];
  unshieldERC20s?: RailgunERC20Amount[];
}) {
  if (unshieldNFTs.length + unshieldERC20s.length === 0) {
    throw new Error("Nothing to deposit");
  }

  const entry = await findAvailableMech();
  if (!entry) {
    throw new Error("No suitable Mech address found");
  }

  const { mechAddress } = entry;
  
  const selected = await pickBestBroadcaster();
  const { broadcasterSelection, selfSignerInfo } = selected;
  console.log("selected", selected)
  const transaction = await populateUnshieldTransaction({
    unshieldNFTs: unshieldNFTs.map((entry) => ({
      ...entry,
      recipientAddress: mechAddress,
    })),
    unshieldERC20s: unshieldERC20s.map((entry) => ({
      ...entry,
      recipientAddress: mechAddress,
    })),
    broadcasterSelection,
  });


  let result;
  if (broadcasterSelection) {
    result = await sendBroadcastedTransaction(
      RailgunTransaction.Unshield,
      transaction,
      broadcasterSelection,
      getCurrentNetwork(),
    );
  } else if (selfSignerInfo) {
    result = await sendSelfSignedTransaction(
      selfSignerInfo,
      getCurrentNetwork(),
      transaction,
    );
  } else {
    throw new Error("No broadcaster or self-signer selected.");
  }
  console.log("Waiting for deposit...");
  console.log("RESULT", result)
  await delay(60_000)
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
