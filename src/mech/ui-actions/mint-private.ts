import { Contract, Interface, toBeHex, TransactionReceipt, zeroPadValue } from "ethers";
import { delay, NFTTokenType } from "@railgun-community/shared-models";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendBroadcastedTransaction, sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";
import { getFirstPollingProviderForChain } from "../../network/network-util";

import { populateShieldTransaction } from "../railgun-primitives";

import { encodeApprove, encodeMint } from "../encode";

import deployments from "../deployments";
import { status } from "../status";
import { generateHookedCall, pickBestBroadcaster, type HookedCrossContractInputs } from "./cross-contract";
import { RailgunTransaction } from "../../models/transaction-models";



export async function mintWithBroadcaster() {
  const { railgunSmartWallet, railgunNeuralLink } = deployments;

  const entries = await status();

  if (entries.some((e) => !e.isNFTBlocked)) {
    console.log(`NFT already Minted and Shielded`);
    return;
  }

  console.log("Minting NFT Privately");
  const mintTx = {
    to: railgunNeuralLink,
    data: encodeMint(),
  };


  const crossContractCalls = [
    mintTx,
  ]

  // const result = await sendSelfSignedTransaction(
  //   selfSignerInfo(),
  //   getCurrentNetwork(),
  //   mintTx,
  // );

  // force knowing the next index, try minting and shielding it. 

  const provider = getFirstPollingProviderForChain(getCurrentNetwork());
  
  const fromBlock = 78102773;
  
  const logs = await provider.getLogs({
    address: railgunNeuralLink,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer(address,address,uint256)
      "0x0000000000000000000000000000000000000000000000000000000000000000", // from address(0)
    ],
    fromBlock,
    toBlock: 'latest' 
  });
  
  // Calculate next ID based on the count of logs which represents mints. 
  const tokenId = BigInt(logs.length + 1).toString();
    console.log("TOKENID", tokenId)
  const crossContractInputs: HookedCrossContractInputs = {
    relayAdaptUnshieldERC20Amounts: [],
    relayAdaptShieldERC20Addresses: [],
    relayAdaptUnshieldNFTAmounts: [],
    relayAdaptShieldNFTAddresses: [
      {
        recipientAddress: getCurrentRailgunAddress(),
        nftAddress: deployments.railgunNeuralLink,
        nftTokenType: NFTTokenType.ERC721,
        tokenSubID: tokenId,
        amount: 1n,
      }
    ],
  }
  const selected = await pickBestBroadcaster()

  const hookedProved = await generateHookedCall(
    getCurrentNetwork(),
    crossContractCalls,
    crossContractInputs,
    selected
  )


  console.log("Waiting for Mint transaction...");
  // await delay(60_000)
  const result = await sendBroadcastedTransaction(
    RailgunTransaction.UnshieldBase,
    hookedProved,
    selected.broadcasterSelection,
    getCurrentNetwork(),
  );
  console.log("RESULT", result)
  return;
  // const receipt = await result?.wait(1);
  // if (!receipt) {
  //   console.log("Failed");
  //   return;
  // }
  // const tokenId = tokenIdFromLog(receipt);
  const _tokenId = BigInt(tokenId)
  {
    console.log("Approving NFT transfer");
    const approveTx = {
      to: railgunNeuralLink,
      data: encodeApprove(railgunSmartWallet().address, _tokenId),
    };
    const result = await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      approveTx,
    );
    console.log("Waiting for Approve transaction...");
    await result?.wait();
  }

  {
    console.log("Shielding NFT");
    const result = await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      await populateShieldTransaction({
        shieldNFTs: [
          {
            nftAddress: railgunNeuralLink,
            nftTokenType: NFTTokenType.ERC721,
            tokenSubID: zeroPadValue(toBeHex(tokenId), 32),
            amount: BigInt(1),
            recipientAddress: getCurrentRailgunAddress(),
          },
        ],
      }),
    );
    console.log("Waiting for Shield transaction...");
    await result?.wait();
  }
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}

// Example: tx is a TransactionResponse
function tokenIdFromLog(receipt: TransactionReceipt) {
  const iface = new Interface([
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  ]);

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Transfer") {
        return BigInt(parsed.args.tokenId); // BigInt
      }
    } catch (e) {
      // log not matching this iface, ignore
    }
  }

  throw new Error("No Transfer event found in transaction");
}
