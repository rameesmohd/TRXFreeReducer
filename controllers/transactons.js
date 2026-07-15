const { TronWeb } = require('tronweb');
const axios =require('axios');
const fs =require ('fs');
const Transaction =require('../models/Transaction.js');
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
  3:  { energy:  65_000, label: '1 USDT tx (existing wallet)' },
  6:  { energy: 131_000, label: '1 USDT tx (new/exchange wallet)' },
  10: { energy: 200_000, label: '~3 USDT txs' },
  25: { energy: 550_000, label: '~8 USDT txs' },
};
const PRICE_TOLERANCE = 0.05

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
  const doc = await Transaction.findOne({ txid }, { projection: { _id: 1 } });
  return !!doc;
}

// ---------- Helpers ----------
async function getIncomingTransactions(address, minTimestampMs) {
  const url = `https://api.trongrid.io/v1/accounts/${address}/transactions`;
  const headers = TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': TRONGRID_API_KEY } : {};
  const params = {
    only_to: true,
    only_confirmed: true,
    limit: 50,
    min_timestamp: minTimestampMs,
  };

  let data;
  try {
    const res = await axios.get(url, { headers, params, timeout: 15000 });
    data = res.data.data || [];
  } catch (e) {
    error(`TronGrid fetch failed: ${e.message}`);
    return [];
  }
  console.log(data);
  
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
    warn(`No matching tier for ${amount} TRX from ${sender}`);
    // await refund(sender, amount, 'Invalid amount');
    await recordTransaction({
      txid, sender, amount,
      status: 'refunded_invalid_amount',
      error: `No tier for ${amount} TRX`,
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
// const date = new Date();
// date.setMonth(date.getMonth() - 1);
// let lastCheckMs = date.getTime();

async function checkTransactions() {
  try {
    info('='.repeat(60));
    info(`Watching address: ${RECEIVE_ADDRESS}`);
    info('='.repeat(60));

    const txs = await getIncomingTransactions(RECEIVE_ADDRESS, lastCheckMs);

    for (const tx of txs) {
      if (await isAlreadyProcessed(tx.txid)) continue;

      await processTransaction(tx);

      lastCheckMs = Math.max(lastCheckMs, tx.timestampMs + 1);
    }
  } catch (e) {
    error(`Cron job error in checkTransactions: ${e.message}`);
  }
}

module.exports = {
  checkTransactions,
};