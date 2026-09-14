/**
 * Anti-Bot Detection Engine for TxFree — v2
 * 
 * Core insight from blockchain forensics:
 * - Bot wallets all send USDT to the SAME destination after receiving energy
 * - Funding sources vary (not useful for clustering)
 * - The USDT destination address is the bot operator's real wallet
 * 
 * Detection approach:
 * 1. PRE-DELIVERY: Account age gating + risk scoring for micro tier
 * 2. POST-DELIVERY: Background job checks where recipients sent USDT
 *    If N recipients → same USDT destination → bot cluster → block all
 * 3. PRE-DELIVERY (after first detection): Check if sender has previously
 *    sent USDT to a known bot destination
 */

const axios = require('axios');
const User = require('../models/User.js');
const BotCluster = require('../models/BotCluster.js');
const Transaction = require('../models/Transaction.js');
const { sendTelegramMessage } = require('./notifications.js');
require('dotenv/config');

const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ANTIBOT_ENABLED = process.env.ANTIBOT_V2_ENABLED !== 'false'; // on by default

// ---------- Configuration ----------
const MIN_ACCOUNT_AGE_HOURS = 24;                    // Minimum account age for 0.1 TRX tier
const MIN_ACCOUNT_TX_COUNT = 5;                      // Minimum total txs for 0.1 TRX tier
const USDT_DEST_CLUSTER_THRESHOLD = 3;               // 3+ wallets sending USDT to same dest = bot
const RISK_BLOCK_THRESHOLD = 60;                     // Score >= 60 = reject transaction
const RISK_PERMANENT_BLOCK_THRESHOLD = 80;           // Score >= 80 = permanent block
const UNIQUE_MICRO_SENDERS_PER_HOUR = 15;            // Max distinct new senders on 0.1 TRX per hour
const SCAN_LOOKBACK_MS = 2 * 60 * 60 * 1000;        // Scan USDT destinations from last 2 hours

// In-memory cache for account profiles to avoid hammering TronGrid
// Key: address, Value: { accountAgeMs, txCount, fetchedAt }
const profileCache = new Map();
const PROFILE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// In-memory cache for USDT destinations
// Key: sender address, Value: { destinations: [string], fetchedAt }
const usdtDestCache = new Map();
const USDT_DEST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------- Logging ----------
function log(level, msg) {
  const line = `${new Date().toISOString()} [ANTIBOT][${level}] ${msg}`;
  console.log(line);
}
const info  = (m) => log('INFO', m);
const warn  = (m) => log('WARN', m);
const error = (m) => log('ERROR', m);

// ---------- Account Profiling ----------

/**
 * Fetch account profile from TronGrid: creation date and tx count.
 * Uses in-memory cache to minimize API calls.
 */
async function getAccountProfile(address) {
  const cached = profileCache.get(address);
  if (cached && (Date.now() - cached.fetchedAt) < PROFILE_CACHE_TTL_MS) {
    return cached;
  }

  const headers = TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {};

  try {
    const res = await axios.get(
      `https://api.trongrid.io/v1/accounts/${address}/transactions`,
      {
        headers,
        params: {
          limit: 10,
          order_by: 'block_timestamp,asc',
          only_confirmed: true,
        },
        timeout: 8000,
      }
    );

    const txs = res.data?.data || [];

    if (txs.length === 0) {
      const profile = { accountAgeMs: 0, txCount: 0, fetchedAt: Date.now() };
      profileCache.set(address, profile);
      return profile;
    }

    const firstTxTimestamp = txs[0]?.block_timestamp || Date.now();
    const accountAgeMs = Date.now() - firstTxTimestamp;

    const profile = {
      accountAgeMs,
      txCount: txs.length, // up to 10, good enough for scoring
      fetchedAt: Date.now(),
    };

    profileCache.set(address, profile);
    return profile;
  } catch (e) {
    warn(`Failed to fetch account profile for ${address}: ${e.message}`);
    // Permissive defaults on API failure
    return { accountAgeMs: Infinity, txCount: 999, fetchedAt: Date.now() };
  }
}

// ---------- USDT Activity & Bot Signature Tracking ----------

/**
 * Detect "paired probe" pattern: the bot sends amount X, then receives back X ± small delta.
 * This catch-all works regardless of what dollar amounts the bot uses.
 * Returns true if 2+ such paired round-trips are found.
 */
function detectPairedProbes(txs, address) {
  const outgoing = []; // { amount, timestamp }
  const incoming = []; // { amount, timestamp }

  for (const tx of txs) {
    const amount = Number(tx.value) / 1e6;
    if (amount <= 0) continue;

    if (tx.from === address) {
      outgoing.push({ amount, ts: tx.block_timestamp || 0 });
    } else if (tx.to === address) {
      incoming.push({ amount, ts: tx.block_timestamp || 0 });
    }
  }

  // Look for round-trip pairs: outgoing X matched by incoming X ± 0.5%
  // The bot sends a probe (e.g. 2000 USDT out), then gets a rebate (e.g. 2.001 USDT in)
  // OR sends a large drain (69k out), matched by a large incoming (69k in)
  let pairedCount = 0;
  const usedIncoming = new Set();

  for (const out of outgoing) {
    for (let i = 0; i < incoming.length; i++) {
      if (usedIncoming.has(i)) continue;
      const inc = incoming[i];
      const diff = Math.abs(out.amount - inc.amount);
      const tolerance = Math.max(out.amount * 0.005, 0.01); // 0.5% or $0.01
      if (diff <= tolerance) {
        pairedCount++;
        usedIncoming.add(i);
        break;
      }
    }
  }

  return pairedCount >= 2; // 2+ matched round-trips = bot
}

/**
 * Detect vanity suffix clustering: bot contracts share identical last 5+ chars.
 * E.g. TRJ4pAS6...huHSnC, TRJ4RAyg...huHSnC, TKrskQVo...huHSnC
 * Real users never interact with 2+ different addresses sharing the same suffix.
 */
function detectVanitySuffix(txs, address) {
  const counterparties = new Set();

  for (const tx of txs) {
    if (tx.from === address && tx.to) counterparties.add(tx.to);
    if (tx.to === address && tx.from) counterparties.add(tx.from);
  }

  // Group by last 5 characters
  const suffixGroups = {};
  for (const addr of counterparties) {
    if (addr.length < 10) continue;
    const suffix = addr.slice(-5);
    if (!suffixGroups[suffix]) suffixGroups[suffix] = [];
    suffixGroups[suffix].push(addr);
  }

  // If 2+ DIFFERENT addresses share the same 5-char suffix → vanity contract bot
  for (const [suffix, addrs] of Object.entries(suffixGroups)) {
    if (addrs.length >= 2) {
      return { detected: true, suffix, addresses: addrs };
    }
  }

  return { detected: false };
}

/**
 * Fetch the USDT (TRC20) transfer activity for a given address.
 * Uses 3 layers of detection (all amount-agnostic):
 *   1. Hardcoded signature (2000/2.001 — fast path for known current bots)
 *   2. Paired probe detection (send X, receive X±delta — catches ANY future amounts)
 *   3. Vanity suffix clustering (2+ counterparties with same address suffix)
 */
async function getUsdtActivity(address) {
  const cached = usdtDestCache.get(address);
  if (cached && (Date.now() - cached.fetchedAt) < USDT_DEST_CACHE_TTL_MS) {
    return cached;
  }

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
        timeout: 8000,
      }
    );

    const trc20Txs = res.data?.data || [];
    const destinations = [];

    // --- Layer 1: Hardcoded signature (current known bots) ---
    // Specifically requires the exact probe/rebate loop (2000 out + 2.001 in)
    let has2000UsdtTransfer = false;
    let has2_001UsdtTransfer = false;

    for (const tx of trc20Txs) {
      if (tx.from === address && tx.to) {
        destinations.push(tx.to);
      }

      const amount = Number(tx.value) / 1e6;
      if (Math.abs(amount - 2000) < 0.001) has2000UsdtTransfer = true;
      if (Math.abs(amount - 2.001) < 0.0001) has2_001UsdtTransfer = true;
    }

    const hardcodedSignature = has2000UsdtTransfer && has2_001UsdtTransfer;

    // --- Layer 2: Paired probe detection (amount-agnostic) ---
    const hasPairedProbes = detectPairedProbes(trc20Txs, address);

    // --- Layer 3: Vanity suffix clustering ---
    const vanityResult = detectVanitySuffix(trc20Txs, address);

    const isArbitrageBot = hardcodedSignature || hasPairedProbes || vanityResult.detected;

    let botReason = null;
    if (hardcodedSignature) botReason = 'Hardcoded signature (2000/2.001 USDT loop)';
    else if (hasPairedProbes) botReason = 'Paired probe transfers detected (send X → receive X±δ)';
    else if (vanityResult.detected) botReason = `Vanity suffix cluster: ${vanityResult.addresses.slice(0, 3).join(', ')} (suffix: ...${vanityResult.suffix})`;

    const uniqueDest = [...new Set(destinations)];
    const result = {
      destinations: uniqueDest,
      isArbitrageBot,
      botReason,
      hasPairedProbes,
      hasVanitySuffix: vanityResult.detected,
      fetchedAt: Date.now(),
    };

    usdtDestCache.set(address, result);
    return result;
  } catch (e) {
    warn(`Failed to fetch USDT activity for ${address}: ${e.message}`);
    return { destinations: [], isArbitrageBot: false, botReason: null, fetchedAt: Date.now() };
  }
}

/**
 * Fetch the USDT (TRC20) transfer destinations for a given address.
 */
async function getUsdtDestinations(address) {
  const activity = await getUsdtActivity(address);
  return activity.destinations || [];
}

/**
 * Check if a sender has previously sent USDT to any known bot destination.
 * This catches new wallets that are part of an already-detected bot cluster.
 */
async function hasSentToKnownBotDest(sender) {
  const destinations = await getUsdtDestinations(sender);
  if (destinations.length === 0) return { matched: false, dest: null };

  // Check if any of these destinations are in our blocked clusters
  const cluster = await BotCluster.findOne(
    { usdtDestination: { $in: destinations }, isBlocked: true },
    { usdtDestination: 1 }
  ).lean();

  if (cluster) {
    return { matched: true, dest: cluster.usdtDestination };
  }
  return { matched: false, dest: null };
}

// ---------- Bot Cluster by USDT Destination ----------

/**
 * Background scanner: Check recent energy recipients and trace their USDT destinations.
 * If N recipients all send USDT to the same address → bot cluster.
 * 
 * Call this periodically (e.g., every 5 minutes from the cron job).
 */
async function scanForBotClusters() {
  if (!ANTIBOT_ENABLED) {
    info('Bot cluster scan skipped (ANTIBOT_ENABLED is false)');
    return;
  }

  const since = new Date(Date.now() - SCAN_LOOKBACK_MS);

  // Get all unique senders who received energy recently (checks both processedAt and receivedAt)
  const recentRecipients = await Transaction.distinct('sender', {
    status: 'delivered',
    $or: [
      { processedAt: { $gte: since } },
      { receivedAt: { $gte: since } },
    ],
  });

  info(`🔍 Bot cluster scan started: found ${recentRecipients.length} delivered wallet(s) in last 2h`);

  if (recentRecipients.length < USDT_DEST_CLUSTER_THRESHOLD) {
    info(`ℹ️ Found ${recentRecipients.length}/${USDT_DEST_CLUSTER_THRESHOLD} unique recipients (needs 3+ to form a cluster). Scan finished.`);
    return;
  }

  info(`Analyzing USDT transfer destinations for ${recentRecipients.length} wallets...`);

  // Map: USDT destination → list of senders who sent to it
  const destToSenders = new Map();
  let apiCalls = 0;
  let skippedBlocked = 0;

  for (const sender of recentRecipients) {
    // Skip already-blocked senders
    const user = await User.findOne({ address: sender, isBlocked: true }, { _id: 1 }).lean();
    if (user) {
      skippedBlocked++;
      continue;
    }

    const activity = await getUsdtActivity(sender);
    apiCalls++;

    // If arbitrage/flash-loan bot pattern detected, block immediately
    if (activity.isArbitrageBot) {
      warn(`🚨 Bot pattern detected for ${sender}: ${activity.botReason}`);
      await User.findOneAndUpdate(
        { address: sender },
        {
          $set: {
            isBlocked: true,
            blockedAt: new Date(),
            blockReason: `Bot pattern: ${activity.botReason}`,
          },
        },
        { upsert: true }
      );

      sendTelegramMessage(
        `🤖 BOT BLOCKED (Pattern Detection)\n` +
        `Sender: ${sender}\n` +
        `Pattern: ${activity.botReason}\n` +
        `Action: Permanently blocked from all services`
      ).catch(() => {});
      continue;
    }

    for (const dest of activity.destinations || []) {
      if (!destToSenders.has(dest)) destToSenders.set(dest, []);
      destToSenders.get(dest).push(sender);
    }

    // Rate limit: pause every 10 API calls
    if (apiCalls % 10 === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  info(`Fetched USDT destinations for ${apiCalls} active wallets (${skippedBlocked} already blocked skipped)`);

  // Detect clusters
  for (const [dest, senders] of destToSenders) {
    if (senders.length >= USDT_DEST_CLUSTER_THRESHOLD) {
      // Check if this cluster is already known
      const existing = await BotCluster.findOne({ usdtDestination: dest }).lean();
      if (existing?.isBlocked) {
        // Already blocked, just add any new linked addresses
        await BotCluster.findOneAndUpdate(
          { usdtDestination: dest },
          { $addToSet: { linkedAddresses: { $each: senders } } }
        );

        // Block any new senders that weren't blocked yet
        await User.updateMany(
          { address: { $in: senders }, isBlocked: { $ne: true } },
          {
            $set: {
              isBlocked: true,
              blockedAt: new Date(),
              blockReason: `Bot cluster — USDT destination: ${dest}`,
              clusterGroup: dest,
            },
          }
        );
        continue;
      }

      // NEW cluster detected!
      warn(`🕸️ New bot cluster: ${senders.length} wallets all send USDT to ${dest}`);

      // Calculate damage
      const deliveries = await Transaction.find({
        sender: { $in: senders },
        status: 'delivered',
      }, { energyDelivered: 1, wholesaleCostTrx: 1, amountTrx: 1 }).lean();

      const totalEnergy = deliveries.reduce((s, d) => s + (d.energyDelivered || 0), 0);
      const totalCost = deliveries.reduce((s, d) => s + (d.wholesaleCostTrx || 0), 0);
      const totalRevenue = deliveries.reduce((s, d) => s + (d.amountTrx || 0), 0);

      // Register the cluster
      await BotCluster.findOneAndUpdate(
        { usdtDestination: dest },
        {
          $set: {
            isBlocked: true,
            detectedAt: new Date(),
            totalEnergyStolen: totalEnergy,
            totalDeliveries: deliveries.length,
          },
          $addToSet: { linkedAddresses: { $each: senders } },
        },
        { upsert: true }
      );

      // Block all senders in the cluster
      await User.updateMany(
        { address: { $in: senders } },
        {
          $set: {
            isBlocked: true,
            blockedAt: new Date(),
            blockReason: `Bot cluster — USDT destination: ${dest}`,
            clusterGroup: dest,
          },
        }
      );

      // Also block the USDT destination address itself (it may try to use our service)
      await User.findOneAndUpdate(
        { address: dest },
        {
          $set: {
            isBlocked: true,
            blockedAt: new Date(),
            blockReason: 'Bot operator — USDT destination of bot cluster',
          },
        },
        { upsert: true }
      );

      // Telegram alert
      sendTelegramMessage(
        `🕸️ BOT CLUSTER DETECTED\n` +
        `USDT Destination: ${dest}\n` +
        `Linked Wallets: ${senders.length}\n` +
        `Wallets: ${senders.slice(0, 5).join(', ')}${senders.length > 5 ? '...' : ''}\n` +
        `Energy Stolen: ${totalEnergy.toLocaleString()}\n` +
        `Your Cost: ${totalCost.toFixed(2)} TRX\n` +
        `Revenue: ${totalRevenue.toFixed(2)} TRX\n` +
        `Net Loss: ${(totalCost - totalRevenue).toFixed(2)} TRX\n` +
        `Action: All ${senders.length} wallets + destination blocked`
      ).catch(() => {});
    }
  }

  info(`Scan complete. ${apiCalls} API calls made.`);
}

// ---------- Unique Micro Senders Per Hour ----------

/**
 * Count distinct senders who got delivered 0.1 TRX energy in the last hour.
 */
async function getUniqueMicroSendersLastHour() {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const result = await Transaction.distinct('sender', {
    amountTrx: { $lte: 0.15 },
    status: 'delivered',
    processedAt: { $gte: since },
  });
  return result.length;
}

// ---------- Risk Scoring ----------

/**
 * Compute a risk score (0-100) for a micro-tier transaction.
 * Higher = more likely a bot.
 */
async function computeRiskScore(sender, profile) {
  let score = 0;
  const reasons = [];

  // Using micro tier
  score += 10;
  reasons.push('+10 micro tier');

  // Account age
  const ageHours = profile.accountAgeMs / (60 * 60 * 1000);
  if (ageHours < 1) {
    score += 40;
    reasons.push('+40 age < 1h');
  } else if (ageHours < 24) {
    score += 25;
    reasons.push('+25 age < 24h');
  } else if (ageHours < 7 * 24) {
    score += 10;
    reasons.push('+10 age < 7d');
  }

  // Transaction count
  if (profile.txCount < 3) {
    score += 20;
    reasons.push('+20 txs < 3');
  } else if (profile.txCount < 5) {
    score += 15;
    reasons.push('+15 txs < 5');
  } else if (profile.txCount < 10) {
    score += 10;
    reasons.push('+10 txs < 10');
  }

  // Has previously sent USDT to a known bot destination
  const botDestCheck = await hasSentToKnownBotDest(sender);
  if (botDestCheck.matched) {
    score += 50;
    reasons.push(`+50 sent USDT to known bot dest ${botDestCheck.dest}`);
  }

  // Positive signal: has old successful deliveries (established user)
  const oldDelivery = await Transaction.findOne({
    sender,
    status: 'delivered',
    processedAt: { $lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
  }, { _id: 1 }).lean();
  if (oldDelivery) {
    score -= 20;
    reasons.push('-20 established user');
  }

  score = Math.max(0, Math.min(100, score));
  return { score, reasons };
}

// ---------- Main Anti-Bot Check (Pre-Delivery) ----------

/**
 * Run anti-bot checks before delivering energy.
 * Returns { allowed: true } or { allowed: false, reason, status }.
 * 
 * Heavy checks ONLY apply to the 0.1 TRX tier.
 * Higher tiers are frictionless.
 */
async function checkAntiBot(sender, amount, priceTrx) {
  if (!ANTIBOT_ENABLED) {
    return { allowed: true };
  }

  // Higher tiers: no extra friction
  if (priceTrx !== 0.1) {
    return { allowed: true };
  }

  // --- From here: micro tier only (0.1 TRX) ---

  // Check 1: Is sender already blocked? (redundant with existing check, but defense in depth)
  const user = await User.findOne({ address: sender }, { isBlocked: 1, clusterGroup: 1 }).lean();
  if (user?.isBlocked) {
    return {
      allowed: false,
      reason: 'Wallet blocked (bot detected)',
      status: 'blocked_bot',
    };
  }

  // Check 2: Is sender in a known bot cluster?
  const inCluster = await BotCluster.findOne(
    { linkedAddresses: sender, isBlocked: true },
    { usdtDestination: 1 }
  ).lean();
  if (inCluster) {
    // Block the sender (wasn't blocked yet but is in a cluster)
    await User.findOneAndUpdate(
      { address: sender },
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          blockReason: `Bot cluster member — dest: ${inCluster.usdtDestination}`,
          clusterGroup: inCluster.usdtDestination,
        },
      },
      { upsert: true }
    );
    return {
      allowed: false,
      reason: 'Wallet linked to bot network',
      status: 'blocked_bot_cluster',
    };
  }

  // Check 3: Has sender previously sent USDT to a known bot destination?
  const botDestCheck = await hasSentToKnownBotDest(sender);
  if (botDestCheck.matched) {
    warn(`${sender} previously sent USDT to known bot dest ${botDestCheck.dest}`);

    // Block and add to cluster
    await User.findOneAndUpdate(
      { address: sender },
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          blockReason: `Sent USDT to bot destination: ${botDestCheck.dest}`,
          clusterGroup: botDestCheck.dest,
        },
      },
      { upsert: true }
    );

    await BotCluster.findOneAndUpdate(
      { usdtDestination: botDestCheck.dest },
      { $addToSet: { linkedAddresses: sender } }
    );

    sendTelegramMessage(
      `🤖 BOT BLOCKED (USDT dest match)\n` +
      `Sender: ${sender}\n` +
      `Sends USDT to: ${botDestCheck.dest}\n` +
      `Action: Blocked + added to cluster`
    ).catch(() => {});

    return {
      allowed: false,
      reason: 'Wallet linked to bot network',
      status: 'blocked_bot_cluster',
    };
  }

  // Check 3.5: Universal Bot Pattern Detection (paired probes, vanity suffix, hardcoded signature)
  const usdtActivity = await getUsdtActivity(sender);
  if (usdtActivity.isArbitrageBot) {
    warn(`🚨 Bot pattern detected for ${sender}: ${usdtActivity.botReason}`);

    await User.findOneAndUpdate(
      { address: sender },
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          blockReason: `Bot pattern: ${usdtActivity.botReason}`,
        },
      },
      { upsert: true }
    );

    sendTelegramMessage(
      `🤖 BOT BLOCKED (Pre-Delivery)\n` +
      `Sender: ${sender}\n` +
      `Pattern: ${usdtActivity.botReason}\n` +
      `Action: Permanently blocked from all services`
    ).catch(() => {});

    return {
      allowed: false,
      reason: `Bot pattern detected: ${usdtActivity.botReason}`,
      status: 'blocked_arbitrage_bot',
    };
  }

  // Check 4: Unique micro senders flood
  const uniqueSenders = await getUniqueMicroSendersLastHour();
  if (uniqueSenders >= UNIQUE_MICRO_SENDERS_PER_HOUR) {
    return {
      allowed: false,
      reason: 'Promo tier temporarily paused (high demand). Try the 2 TRX tier or wait.',
      status: 'rejected_micro_flood',
    };
  }

  // Check 5: Account age gating
  const profile = await getAccountProfile(sender);

  const ageHours = profile.accountAgeMs / (60 * 60 * 1000);
  if (ageHours < MIN_ACCOUNT_AGE_HOURS) {
    return {
      allowed: false,
      reason: 'Promo tier requires wallet to be at least 24 hours old. Use the 2 TRX tier.',
      status: 'rejected_account_too_new',
    };
  }

  if (profile.txCount < MIN_ACCOUNT_TX_COUNT) {
    return {
      allowed: false,
      reason: `Promo tier requires at least ${MIN_ACCOUNT_TX_COUNT} prior transactions. Use the 2 TRX tier.`,
      status: 'rejected_low_activity',
    };
  }

  // Check 6: Risk score
  const { score, reasons } = await computeRiskScore(sender, profile);

  // Cache risk data
  User.findOneAndUpdate(
    { address: sender },
    {
      $set: {
        riskScore: score,
        accountAgeDays: profile.accountAgeMs / (24 * 60 * 60 * 1000),
        lastRiskAssessedAt: new Date(),
      },
    },
    { upsert: true }
  ).catch(e => error(`Failed to update user risk data: ${e.message}`));

  if (score >= RISK_PERMANENT_BLOCK_THRESHOLD) {
    const blockReason = `Risk score ${score}: ${reasons.join(', ')}`;
    warn(`${blockReason} — ${sender}`);

    await User.findOneAndUpdate(
      { address: sender },
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          blockReason,
          riskScore: score,
        },
      },
      { upsert: true }
    );

    sendTelegramMessage(
      `🤖 HIGH RISK BOT BLOCKED\n` +
      `Sender: ${sender}\n` +
      `Risk Score: ${score}/100\n` +
      `Signals: ${reasons.join(', ')}\n` +
      `Action: Permanently blocked`
    ).catch(() => {});

    return {
      allowed: false,
      reason: blockReason,
      status: 'blocked_bot',
    };
  }

  if (score >= RISK_BLOCK_THRESHOLD) {
    warn(`Risk score ${score} for ${sender}: ${reasons.join(', ')}`);

    sendTelegramMessage(
      `⚠️ SUSPICIOUS TX REJECTED\n` +
      `Sender: ${sender}\n` +
      `Risk Score: ${score}/100\n` +
      `Signals: ${reasons.join(', ')}\n` +
      `Action: Transaction rejected`
    ).catch(() => {});

    return {
      allowed: false,
      reason: `Transaction flagged as suspicious (score: ${score})`,
      status: 'rejected_risk_score',
    };
  }

  info(`Risk score ${score} for ${sender} — ALLOWED. Signals: ${reasons.join(', ')}`);
  return { allowed: true };
}

// ---------- Cache cleanup & safety cap ----------
const MAX_CACHE_SIZE = 5000;

function enforceCacheLimits() {
  if (profileCache.size > MAX_CACHE_SIZE) {
    const excess = profileCache.size - MAX_CACHE_SIZE;
    let deleted = 0;
    for (const key of profileCache.keys()) {
      profileCache.delete(key);
      if (++deleted >= excess) break;
    }
  }
  if (usdtDestCache.size > MAX_CACHE_SIZE) {
    const excess = usdtDestCache.size - MAX_CACHE_SIZE;
    let deleted = 0;
    for (const key of usdtDestCache.keys()) {
      usdtDestCache.delete(key);
      if (++deleted >= excess) break;
    }
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of profileCache) {
    if (now - val.fetchedAt > PROFILE_CACHE_TTL_MS) profileCache.delete(key);
  }
  for (const [key, val] of usdtDestCache) {
    if (now - val.fetchedAt > USDT_DEST_CACHE_TTL_MS) usdtDestCache.delete(key);
  }
  enforceCacheLimits();
}, 5 * 60 * 1000);

if (cleanupTimer && typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

module.exports = {
  checkAntiBot,
  scanForBotClusters,
  getAccountProfile,
  getUsdtDestinations,
  hasSentToKnownBotDest,
  computeRiskScore,
  getUniqueMicroSendersLastHour,
  ANTIBOT_ENABLED,
};
