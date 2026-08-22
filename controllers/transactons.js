const { TronWeb } = require('tronweb');
const axios =require('axios');
const fs =require ('fs');
const Transaction =require('../models/Transaction.js');
const { notifyFundReceived, notifyPurchase, notifySuccess, notifyFailure } = require('./notifications.js');
require('dotenv/config');

// ---------- Configuration ----------
const RECEIVE_ADDRESS = process.env.RECEIVE_ADDRESS;
const RECEIVE_PRIVATE_KEY = process.env.RECEIVE_PRIVATE_KEY;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;
const NETTS_API_KEY = process.env.NETTS_API_KEY;
const NETTS_WHITELISTED_IP = process.env.NETTS_WHITELISTED_IP; // must match the IP whitelisted in your Netts dashboard
const NETTS_API_URL = 'https://netts.io';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// Pricing table: TRX received → energy delivered (1 hour rental)
// Netts order 1h minimum is 61,000 energy, so all tiers below clear that floor.
const PRICING = {
  0.1: { energy:  65_000, label: '1 tx (0.1 TRX promo / 65k)' },
  2:   { energy:  65_000, label: '1 tx (existing wallet)' },
  4:   { energy: 131_000, label: '2 txs (new/exchange wallet)' },
  10:  { energy: 325_000, label: '5 txs' },
  20:  { energy: 650_000, label: '10 txs' },
};
const PRICE_TOLERANCE = 0.05

// In-memory set of txids currently being processed to prevent concurrent duplicate runs
const activeProcessingTxids = new Set();

// ---------- Logging ----------
fs.mkdirSync('logs', { recursive: true });
const LOG_FILE = 'logs/bot.log';

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}
const info  = (m) => log('INFO', m);
const warn  = (m) => log('WARN', m);
const error = (m) => log('ERROR', m);

// ---------- TronWeb client ----------
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  headers: TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {},
  privateKey: RECEIVE_PRIVATE_KEY,
});

async function recordTransaction(data) {
  try {
    await Transaction.findOneAndUpdate(
      { txid: data.txid },
      {
        $set: {
          txid: data.txid,
          sender: data.sender,
          amountTrx: data.amount,
          status: data.status,
          energyDelivered: data.energy ?? null,
          wholesaleCostTrx: data.cost ?? null,
          profitTrx: data.profit ?? null,
          orderId: data.orderId ?? null,
          txHash: data.hash ?? null,
          errorMessage: data.error ?? null,
          processedAt: new Date(),
        },
        $setOnInsert: { receivedAt: new Date() },
      },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (e) {
    error(`Failed to record transaction ${data.txid}: ${e.message}`);
  }
}

async function isAlreadyProcessed(txid) {
  if (activeProcessingTxids.has(txid)) return true;
  const doc = await Transaction.findOne({ txid }, { projection: { _id: 1 } });
  return !!doc;
}

/**
 * Atomically reserves/claims a transaction to prevent duplicate concurrent processing.
 * Returns true if this process successfully claimed the transaction.
 */
async function claimTransaction(tx) {
  const { txid, sender, amount } = tx;

  if (activeProcessingTxids.has(txid)) {
    return false;
  }

  activeProcessingTxids.add(txid);

  try {
    // Atomic insert/lock using unique index on txid
    const existing = await Transaction.findOneAndUpdate(
      { txid },
      {
        $setOnInsert: {
          txid,
          sender,
          amountTrx: amount,
          status: 'processing',
          receivedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'before' }
    );

    if (existing) {
      activeProcessingTxids.delete(txid);
      return false; // Already existed in DB
    }

    return true;
  } catch (e) {
    activeProcessingTxids.delete(txid);
    return false;
  }
}

// Parse one or more TronGrid API keys (comma-separated for key rotation if provided)
const TRONGRID_API_KEYS = (process.env.TRONGRID_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);
let currentKeyIndex = 0;
let rateLimitBackoffUntil = 0;

function getNextTronGridApiKey() {
  if (TRONGRID_API_KEYS.length === 0) return null;
  const key = TRONGRID_API_KEYS[currentKeyIndex % TRONGRID_API_KEYS.length];
  currentKeyIndex++;
  return key;
}

// ---------- Helpers ----------
async function getIncomingTransactions(address, minTimestampMs) {
  // If we recently hit a 429, respect backoff
  if (Date.now() < rateLimitBackoffUntil) {
    return [];
  }

  const url = `https://api.trongrid.io/v1/accounts/${address}/transactions`;
  const apiKey = getNextTronGridApiKey();
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
  const params = {
    only_to: true,
    only_confirmed: false, // Instant detection (1-3s) without waiting for block finality
    limit: 50,
    min_timestamp: minTimestampMs,
    order_by: 'block_timestamp,desc',
  };

  let data;
  try {
    const res = await axios.get(url, { headers, params, timeout: 8000 });
    data = res.data.data || [];
  } catch (e) {
    if (e.response && e.response.status === 429) {
      rateLimitBackoffUntil = Date.now() + 5000; // back off for 5s
      warn(
        `TronGrid 429 (Rate Limit Exceeded). ` +
        (TRONGRID_API_KEYS.length === 0
          ? `Add a free TRONGRID_API_KEY in .env from https://www.trongrid.io to increase rate limits to 100,000 req/day.`
          : `Backing off for 5s.`)
      );
    } else {
      warn(`TronGrid fetch failed: ${e.message}`);
    }
    return [];
  }
  
  const txs = [];
  for (const tx of data) {
    const contracts = tx.raw_data?.contract || [];
    if (!contracts.length) continue;
    const c = contracts[0];
    if (c.type !== 'TransferContract') continue;

    const val = c.parameter?.value || {};
    const senderHex = val.owner_address;
    const recipientHex = val.to_address;
    const amountSun = val.amount || 0;
    if (!senderHex || !recipientHex) continue;

    let senderB58, recipientB58;
    try {
      senderB58 = tronWeb.address.fromHex(senderHex);
      recipientB58 = tronWeb.address.fromHex(recipientHex);
    } catch {
      continue;
    }
    if (recipientB58 !== address) continue;

    txs.push({
      txid: tx.txID,
      sender: senderB58,
      amount: amountSun / 1_000_000,
      timestampMs: tx.block_timestamp,
    });
  }
  return txs;
}

// function matchPricing(amount) {
//   for (const [price, tier] of Object.entries(PRICING)) {
//     if (Math.abs(amount - Number(price)) <= PRICE_TOLERANCE) {
//       return { priceTrx: Number(price), ...tier };
//     }
//   }
//   return null;
// }

function matchPricing(amount) {
  const prices = Object.keys(PRICING)
    .map(Number)
    .sort((a, b) => b - a);

  let fallback = null;

  for (const price of prices) {
    // Exact match within tolerance
    if (Math.abs(amount - price) <= PRICE_TOLERANCE) {
      return { priceTrx: price, ...PRICING[price] };
    }

    // Save the nearest lower package
    if (!fallback && amount >= price) {
      fallback = { priceTrx: price, ...PRICING[price] };
    }
  }

  return fallback;
}

async function isNewUsdtWallet(address) {
  const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20`;
  const headers = TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {};
  try {
    const res = await axios.get(url, {
      headers,
      params: { contract_address: USDT_CONTRACT, limit: 1 },
      timeout: 10000,
    });
    return (res.data.data || []).length === 0;
  } catch (e) {
    warn(`Could not check USDT history for ${address}: ${e.message}`);
    return false;
  }
}

/**
 * Buy energy from Netts (POST /apiv2/order1h) and delegate it to `receiver`.
 * Netts' order1h endpoint is a fixed 1-hour rental with automatic provider
 * failover across their aggregated pool (JustLend, Trongas, Catfee, etc).
 * Docs: https://doc.netts.io/api/v2/endpoints/order1h.html
 */
async function buyEnergyFromNetts(receiver, energyAmount) {
  const url = `${NETTS_API_URL}/apiv2/order1h`;
  const payload = {
    amount: energyAmount,
    receiveAddress: receiver,
  };
  try {
    const res = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': NETTS_API_KEY,
        'X-Real-IP': NETTS_WHITELISTED_IP,
      },
      timeout: 15000, // Netts responds in ~2s typically, up to 10s max per docs
    });

    const detail = res.data?.detail;
    if (detail && detail.code === 10000) {
      const order = detail.data || {};
      return {
        success: true,
        costTrx: order.paidTRX || 0,
        orderId: order.orderId || '',
        hash: order.hash || '', // may be empty; use /apiv2/order_check after 1 min if needed
        errorMsg: null,
      };
    }
    return { success: false, costTrx: 0, orderId: '', hash: '', errorMsg: JSON.stringify(res.data) };
  } catch (e) {
    const errorMsg = e.response
      ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
      : e.message;

    return {
      success: false,
      costTrx: 0,
      orderId: '',
      hash: '',
      errorMsg,
    };
  }
}

// ---------- Main processing ----------
async function processTransaction(tx) {
  const { txid, sender, amount } = tx;
  info(`Processing ${txid}: ${amount} TRX from ${sender}`);

  // 1. Match pricing tier
  const tier = matchPricing(amount);
  if (!tier) {
    const reason = `No tier for ${amount} TRX`;
    warn(`No matching tier for ${amount} TRX from ${sender}`);
    // await refund(sender, amount, 'Invalid amount');
    await notifyFailure(sender, amount, reason, txid);
    await recordTransaction({
      txid, sender, amount,
      status: 'refunded_invalid_amount',
      error: reason,
    });
    return;
  }

  // 2. New wallet check
  if (tier.priceTrx === 3) {
    const isNew = await isNewUsdtWallet(sender);
    console.log("is new:", isNew);
    
    if (isNew) {
      warn(`${sender} is new USDT wallet, needs 6 TRX. Refunding.`);
      // await refund(sender, amount, 'New wallet needs 6 TRX package');
      await notifyFailure(sender, amount, 'New/exchange wallet — needs 6 TRX package', txid);
      await recordTransaction({
        txid, sender, amount,
        status: 'refunded_new_wallet',
      });
      return;
    }
  }

  // 3. Buy energy from Netts
  info(`Buying ${tier.energy} energy for ${sender} via Netts`);
  const result = await buyEnergyFromNetts(sender, tier.energy);

  if (!result.success) {
    error(`Energy purchase failed: ${result.errorMsg}`);
    // await refund(sender, amount, 'Provider error');
    await notifyFailure(sender, amount, result.errorMsg, txid);
    await recordTransaction({
      txid, sender, amount,
      status: 'refunded_provider_error',
      error: result.errorMsg,
    });
    return;
  }

  // 4. Record success
  const profit = amount - result.costTrx;
  info(`✓ Delivered ${tier.energy} energy to ${sender} (order ${result.orderId}). ` +
       `Revenue: ${amount} TRX, Cost: ${result.costTrx} TRX, Profit: ${profit.toFixed(3)} TRX`);
  await notifyPurchase(sender, tier.energy, result.costTrx, result.orderId);
  await notifySuccess(sender, amount, tier.energy, result.costTrx, profit, result.orderId, txid);
  await recordTransaction({
    txid, sender, amount,
    status: 'delivered',
    energy: tier.energy,
    cost: result.costTrx,
    profit,
    orderId: result.orderId,
    hash: result.hash,
  });
}

let lastCheckMs = Date.now() - 5 * 60 * 1000;
let isCheckRunning = false;

async function checkTransactions() {
  if (isCheckRunning) return;
  isCheckRunning = true;

  try {
    const queryMinTimestamp = Math.max(lastCheckMs - 60 * 1000, Date.now() - 5 * 60 * 1000);
    const txs = await getIncomingTransactions(RECEIVE_ADDRESS, queryMinTimestamp);

    for (const tx of txs) {
      if (tx.timestampMs && tx.timestampMs > lastCheckMs) {
        lastCheckMs = tx.timestampMs;
      }

      const claimed = await claimTransaction(tx);
      if (!claimed) continue;

      try {
        await notifyFundReceived(tx.sender, tx.amount, tx.txid);
        await processTransaction(tx);
      } catch (err) {
        error(`Unexpected error processing ${tx.txid}: ${err.message}`);
        await recordTransaction({
          txid: tx.txid,
          sender: tx.sender,
          amount: tx.amount,
          status: 'error_unhandled',
          error: err.message,
        });
      } finally {
        activeProcessingTxids.delete(tx.txid);
      }
    }
  } catch (e) {
    error(`Cron job error in checkTransactions: ${e.message}`);
  } finally {
    isCheckRunning = false;
  }
}


// // Backend only
// const purchaseEnergy = async (req, res) => {
//   const { receiver, energyAmount } = req.body;

//   const result = await buyEnergyFromNetts(receiver, energyAmount);
//   res.json(result);
// };

// In-memory lock — prevents a retried/duplicate request for the same
// receiver from firing a second real Netts order while the first is
// still being processed.
const inFlightPurchases = new Map(); // receiver -> Promise

/**
 * Poll Netts' order_check endpoint until the on-chain delegation hash
 * is confirmed, or give up after `retries` attempts.
 * Docs: https://doc.netts.io/api/v2/endpoints/order_check.html
 *
 * NOTE: I'm inferring the response shape (`detail.data.hash`) from the
 * comment already in your buyEnergyFromNetts code — verify the actual
 * field names against Netts' order_check docs before relying on this.
 */
async function waitForOrderConfirmation(orderId, { retries = 6, delayMs = 5000 } = {}) {
  for (let i = 0; i < retries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await axios.get(`${NETTS_API_URL}/apiv2/order_check`, {
        params: { orderId },
        headers: {
          'X-API-KEY': NETTS_API_KEY,
          'X-Real-IP': NETTS_WHITELISTED_IP,
        },
        timeout: 10000,
      });
      const data = res.data?.detail?.data;
      if (data?.hash) {
        return { confirmed: true, hash: data.hash };
      }
    } catch (e) {
      warn(`order_check failed for order ${orderId} (attempt ${i + 1}): ${e.message}`);
    }
  }
  return { confirmed: false, hash: '' };
}

const purchaseEnergy = async (req, res) => {
  const { receiver, energyAmount } = req.body;

  if (!receiver || !energyAmount) {
    return res.status(400).json({ error: 'receiver and energyAmount are required' });
  }

  // Reject a second call for the same receiver while one is already running
  if (inFlightPurchases.has(receiver)) {
    return res.status(409).json({ error: 'A purchase for this receiver is already in progress' });
  }

  const purchasePromise = (async () => {
    const result = await buyEnergyFromNetts(receiver, energyAmount);

    if (!result.success) {
      return result; // order was never placed, nothing to confirm
    }
    if (result.hash) {
      return result; // Netts already returned a confirmed hash immediately
    }

    // Order accepted but not yet confirmed on-chain — hold here instead
    // of responding "success" prematurely.
    const confirmation = await waitForOrderConfirmation(result.orderId);

    return {
      ...result,
      hash: confirmation.hash,
      success: confirmation.confirmed, // downgrade to false if it never confirmed
      errorMsg: confirmation.confirmed
        ? null
        : 'Order accepted by Netts but not confirmed on-chain within timeout',
    };
  })();

  inFlightPurchases.set(receiver, purchasePromise);

  try {
    const result = await purchasePromise;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    inFlightPurchases.delete(receiver);
  }
};

module.exports = {
  checkTransactions,
  purchaseEnergy,
};