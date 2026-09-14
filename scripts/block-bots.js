/**
 * One-Time Bot Network Blocker — USDT Destination Clustering
 * 
 * Run: node scripts/block-bots.js
 * 
 * This script:
 * 1. Finds all addresses that received energy deliveries recently
 * 2. Looks up each sender's USDT transfer history on TronGrid
 * 3. Clusters wallets by common USDT destination (the bot operator's wallet)
 * 4. Blocks all wallets in clusters with >= 3 members
 * 5. Reports total damage (energy cost lost)
 * 
 * Safe to run multiple times — uses upserts everywhere.
 */

require('dotenv/config');
const mongoose = require('mongoose');
const axios = require('axios');

const Transaction = require('../models/Transaction.js');
const User = require('../models/User.js');
const BotCluster = require('../models/BotCluster.js');

const MONGODB_URL = process.env.MONGODB_URL;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const CLUSTER_THRESHOLD = 3; // min wallets sending USDT to same dest to be a bot cluster

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Get outgoing USDT activity and detect arbitrage bot signature.
 */
async function getUsdtActivity(address) {
  const headers = TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {};

  try {
    const res = await axios.get(
      `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20`,
      {
        headers,
        params: {
          contract_address: USDT_CONTRACT,
          limit: 30,
          only_confirmed: true,
        },
        timeout: 10000,
      }
    );

    const txs = res.data?.data || [];
    const destinations = new Set();
    let has2000UsdtTransfer = false;
    let has2_001UsdtTransfer = false;
    let hasHighValueFlashTransfer = false;

    for (const tx of txs) {
      if (tx.from === address && tx.to) {
        destinations.add(tx.to);
      }

      const amount = Number(tx.value) / 1e6;
      if (Math.abs(amount - 2000) < 0.001) {
        has2000UsdtTransfer = true;
      }
      if (Math.abs(amount - 2.001) < 0.0001) {
        has2_001UsdtTransfer = true;
      }
<<<<<<< HEAD
    }

    const isArbitrageBot = has2000UsdtTransfer && has2_001UsdtTransfer;
=======
      if (amount > 10000) {
        hasHighValueFlashTransfer = true;
      }
    }

    const isArbitrageBot = (has2000UsdtTransfer && has2_001UsdtTransfer) ||
                           (has2000UsdtTransfer && hasHighValueFlashTransfer);
>>>>>>> de03834d36e40add01a17f0a2b4a90fd1559db7b

    return {
      destinations: [...destinations],
      isArbitrageBot,
      has2000UsdtTransfer,
      has2_001UsdtTransfer,
    };
  } catch (e) {
    console.error(`  ⚠ TronGrid error for ${address}: ${e.message}`);
    return { destinations: [], isArbitrageBot: false };
  }
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  BOT NETWORK & ARBITRAGE SIGNATURE BLOCKER');
  console.log('='.repeat(60));

  await mongoose.connect(MONGODB_URL);
  console.log('✅ Connected to MongoDB\n');

  // Step 1: Find all senders with delivered transactions (last 7 days)
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentSenders = await Transaction.distinct('sender', {
    status: 'delivered',
    $or: [
      { processedAt: { $gte: since } },
      { receivedAt: { $gte: since } },
    ],
  });

  console.log(`📋 Found ${recentSenders.length} unique senders with deliveries in the last 7 days\n`);

  if (recentSenders.length === 0) {
    console.log('Nothing to analyze. Exiting.');
    await mongoose.disconnect();
    return;
  }

  // Step 2: Look up USDT activity & signatures for each sender
  const destToSenders = new Map(); // USDT destination → [sender addresses]
  const arbitrageBotSenders = [];
  const noUsdtTxs = [];
  let apiCalls = 0;

  for (const sender of recentSenders) {
    console.log(`  🔍 Checking USDT history for ${sender}...`);
    const activity = await getUsdtActivity(sender);
    apiCalls++;

    if (activity.isArbitrageBot) {
      console.log(`    🚨 ARBITRAGE BOT SIGNATURE DETECTED for ${sender} (2000/2.001 USDT loop)`);
      arbitrageBotSenders.push(sender);
    }

    if (activity.destinations.length === 0) {
      noUsdtTxs.push(sender);
    } else {
      for (const dest of activity.destinations) {
        if (!destToSenders.has(dest)) destToSenders.set(dest, []);
        destToSenders.get(dest).push(sender);
      }
    }

    // Rate limit: pause every 10 API calls
    if (apiCalls % 10 === 0) {
      console.log(`  ⏳ Pausing (${apiCalls} API calls made)...`);
      await sleep(1500);
    }
  }

  // Block individual signature bots
  if (arbitrageBotSenders.length > 0) {
    console.log(`\n🚫 Blocking ${arbitrageBotSenders.length} arbitrage signature bot wallets...`);
    await User.updateMany(
      { address: { $in: arbitrageBotSenders } },
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          blockReason: 'Arbitrage bot signature detected (2000/2.001 USDT loop)',
        },
      }
    );
    console.log(`✅ Successfully blocked ${arbitrageBotSenders.length} arbitrage bot wallets.`);
  }

  console.log(`\n📊 Analysis complete (${apiCalls} API calls made)`);
  console.log(`  Arbitrage signature bots blocked: ${arbitrageBotSenders.length}`);
  console.log(`  Unique USDT destinations found: ${destToSenders.size}`);
  console.log(`  Senders with no USDT txs: ${noUsdtTxs.length}\n`);

  // Step 3: Identify clusters
  const clusters = [];
  for (const [dest, senders] of destToSenders) {
    if (senders.length >= CLUSTER_THRESHOLD) {
      clusters.push({ dest, senders });
    }
  }

  // Show ALL destinations sorted by wallet count (for manual review)
  console.log('All USDT destinations by wallet count:');
  console.log('-'.repeat(60));
  const sorted = [...destToSenders.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [dest, senders] of sorted.slice(0, 20)) {
    const marker = senders.length >= CLUSTER_THRESHOLD ? '🔴 BOT' : '  ';
    console.log(`  ${marker} ${dest}: ${senders.length} wallets`);
  }
  console.log();

  console.log(`🎯 Bot clusters detected (≥${CLUSTER_THRESHOLD} wallets → same USDT dest): ${clusters.length}\n`);

  if (clusters.length === 0) {
    console.log('No clusters found. The bots may not have sent USDT yet, or threshold is too high.\n');
    await mongoose.disconnect();
    return;
  }

  // Step 4: Block clusters
  let totalBlocked = 0;
  let totalDeliveries = 0;
  let totalEnergyStolen = 0;
  let totalNetLoss = 0;

  for (const { dest, senders } of clusters) {
    console.log(`\n🕸️ Cluster: USDT destination ${dest}`);
    console.log(`  Linked wallets: ${senders.length}`);
    console.log(`  Wallets: ${senders.slice(0, 5).join(', ')}${senders.length > 5 ? '...' : ''}`);

    // Calculate damage
    const deliveries = await Transaction.find({
      sender: { $in: senders },
      status: 'delivered',
    }, { energyDelivered: 1, wholesaleCostTrx: 1, amountTrx: 1 }).lean();

    const clusterEnergy = deliveries.reduce((sum, d) => sum + (d.energyDelivered || 0), 0);
    const clusterCost = deliveries.reduce((sum, d) => sum + (d.wholesaleCostTrx || 0), 0);
    const clusterRevenue = deliveries.reduce((sum, d) => sum + (d.amountTrx || 0), 0);
    const netLoss = clusterCost - clusterRevenue;

    console.log(`  Deliveries: ${deliveries.length}`);
    console.log(`  Energy stolen: ${clusterEnergy.toLocaleString()}`);
    console.log(`  Your cost: ${clusterCost.toFixed(2)} TRX`);
    console.log(`  Revenue received: ${clusterRevenue.toFixed(2)} TRX`);
    console.log(`  Net loss: ${netLoss.toFixed(2)} TRX`);

    // Register cluster
    await BotCluster.findOneAndUpdate(
      { usdtDestination: dest },
      {
        $set: {
          isBlocked: true,
          detectedAt: new Date(),
          totalEnergyStolen: clusterEnergy,
          totalDeliveries: deliveries.length,
        },
        $addToSet: { linkedAddresses: { $each: senders } },
      },
      { upsert: true }
    );

    // Block all sender addresses
    const blockResult = await User.updateMany(
      { address: { $in: senders } },
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          blockReason: `Bot cluster (batch) — USDT dest: ${dest}`,
          clusterGroup: dest,
        },
      }
    );

    // Block the destination address itself
    await User.findOneAndUpdate(
      { address: dest },
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          blockReason: 'Bot operator — USDT destination of bot cluster (batch)',
        },
      },
      { upsert: true }
    );

    console.log(`  ✅ Blocked ${blockResult.modifiedCount || senders.length} wallets + destination`);

    totalBlocked += senders.length;
    totalDeliveries += deliveries.length;
    totalEnergyStolen += clusterEnergy;
    totalNetLoss += netLoss;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Clusters blocked:    ${clusters.length}`);
  console.log(`  Wallets blocked:     ${totalBlocked}`);
  console.log(`  Total deliveries:    ${totalDeliveries}`);
  console.log(`  Total energy stolen: ${totalEnergyStolen.toLocaleString()}`);
  console.log(`  Total net loss:      ${totalNetLoss.toFixed(2)} TRX`);
  console.log('='.repeat(60) + '\n');

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
