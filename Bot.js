/**
 * TRON Energy Reseller Bot (Node.js + MongoDB)
 * ============================================
 * Watches an address for incoming TRX, buys energy from a wholesale provider,
 * delegates it to the sender. Keeps the spread as profit.
 */

import 'dotenv/config';
import { TronWeb } from 'tronweb';
import { MongoClient } from 'mongodb';
import axios from 'axios';
import fs from 'fs';

// ---------- Configuration ----------
const RECEIVE_ADDRESS = process.env.RECEIVE_ADDRESS;
const RECEIVE_PRIVATE_KEY = process.env.RECEIVE_PRIVATE_KEY;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;
const TRONSAVE_API_KEY = process.env.TRONSAVE_API_KEY;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGO_DB || 'eezytron';
const TRONSAVE_API_URL = 'https://api.tronsave.io';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// Pricing table: TRX received → energy delivered (1 hour rental)
const PRICING = {
  3:  { energy:  65_000, label: '1 USDT tx (existing wallet)' },
  6:  { energy: 131_000, label: '1 USDT tx (new/exchange wallet)' },
  10: { energy: 200_000, label: '~3 USDT txs' },
  25: { energy: 550_000, label: '~8 USDT txs' },
};
const PRICE_TOLERANCE = 0.05;
const RENTAL_DURATION_HOURS = 1;
const POLL_INTERVAL_MS = 5000;

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

// ---------- MongoDB ----------
let mongoClient;
let txCollection;

async function initMongo() {
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(MONGO_DB);
  txCollection = db.collection('transactions');

  // Indexes
  await txCollection.createIndex({ txid: 1 }, { unique: true });
  await txCollection.createIndex({ status: 1 });
  await txCollection.createIndex({ processedAt: -1 });
  await txCollection.createIndex({ sender: 1 });

  info(`MongoDB connected: ${MONGO_DB}`);
}

async function recordTransaction(data) {
  try {
    await txCollection.updateOne(
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
          errorMessage: data.error ?? null,
          processedAt: new Date(),
        },
        $setOnInsert: { receivedAt: new Date() },
      },
      { upsert: true }
    );
  } catch (e) {
    error(`Failed to record transaction ${data.txid}: ${e.message}`);
  }
}

async function isAlreadyProcessed(txid) {
  const doc = await txCollection.findOne({ txid }, { projection: { _id: 1 } });
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

function matchPricing(amount) {
  for (const [price, tier] of Object.entries(PRICING)) {
    if (Math.abs(amount - Number(price)) <= PRICE_TOLERANCE) {
      return { priceTrx: Number(price), ...tier };
    }
  }
  return null;
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

async function buyEnergyFromTronSave(receiver, energyAmount, durationHours) {
  const url = `${TRONSAVE_API_URL}/v2/internal-buy-energy`;
  const payload = {
    receiver,
    resource_value: energyAmount,
    resource_type: 'ENERGY',
    unit_price: 'auto',
    duration_minute: durationHours * 60,
  };
  try {
    const res = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        apikey: TRONSAVE_API_KEY,
      },
      timeout: 20000,
    });
    const data = res.data;
    if (data.status === 'SUCCESS' || data.id) {
      return {
        success: true,
        costTrx: (data.total_cost || 0) / 1_000_000,
        orderId: data.id || '',
        errorMsg: null,
      };
    }
    return { success: false, costTrx: 0, orderId: '', errorMsg: JSON.stringify(data) };
  } catch (e) {
    const errMsg = e.response
      ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
      : e.message;
    return { success: false, costTrx: 0, orderId: '', errorMsg: errMsg };
  }
}

async function refund(sender, amount, reason) {
  const refundAmount = amount - 0.1;
  if (refundAmount <= 0) {
    warn(`Refund amount too small after fee: ${sender}`);
    return null;
  }
  try {
    const amountSun = Math.floor(refundAmount * 1_000_000);
    const tx = await tronWeb.transactionBuilder.sendTrx(sender, amountSun, RECEIVE_ADDRESS);
    const txWithMemo = await tronWeb.transactionBuilder.addUpdateData(
      tx, `Refund: ${reason}`, 'utf8'
    );
    const signed = await tronWeb.trx.sign(txWithMemo, RECEIVE_PRIVATE_KEY);
    const result = await tronWeb.trx.sendRawTransaction(signed);
    const txid = result.txid || result.transaction?.txID;
    info(`Refunded ${refundAmount} TRX to ${sender}: ${txid}`);
    return txid;
  } catch (e) {
    error(`Refund failed for ${sender}: ${e.message}`);
    return null;
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
    await refund(sender, amount, 'Invalid amount');
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
    if (isNew) {
      warn(`${sender} is new USDT wallet, needs 6 TRX. Refunding.`);
      await refund(sender, amount, 'New wallet needs 6 TRX package');
      await recordTransaction({
        txid, sender, amount,
        status: 'refunded_new_wallet',
      });
      return;
    }
  }

  // 3. Buy energy
  info(`Buying ${tier.energy} energy for ${sender} via TronSave`);
  const result = await buyEnergyFromTronSave(sender, tier.energy, RENTAL_DURATION_HOURS);

  if (!result.success) {
    error(`Energy purchase failed: ${result.errorMsg}`);
    await refund(sender, amount, 'Provider error');
    await recordTransaction({
      txid, sender, amount,
      status: 'refunded_provider_error',
      error: result.errorMsg,
    });
    return;
  }

  // 4. Record success
  const profit = amount - result.costTrx;
  info(`✓ Delivered ${tier.energy} energy to ${sender}. ` +
       `Revenue: ${amount} TRX, Cost: ${result.costTrx} TRX, Profit: ${profit.toFixed(3)} TRX`);
  await recordTransaction({
    txid, sender, amount,
    status: 'delivered',
    energy: tier.energy,
    cost: result.costTrx,
    profit,
  });
}

// ---------- Main loop ----------
async function main() {
  await initMongo();

  info('='.repeat(60));
  info('TRON Energy Reseller Bot starting');
  info(`Watching address: ${RECEIVE_ADDRESS}`);
  info(`Pricing tiers: ${Object.keys(PRICING).join(', ')} TRX`);
  info('='.repeat(60));

  let lastCheckMs = Date.now() - 5 * 60 * 1000;

  while (true) {
    try {
      const txs = await getIncomingTransactions(RECEIVE_ADDRESS, lastCheckMs);
      for (const tx of txs) {
        if (await isAlreadyProcessed(tx.txid)) continue;
        await processTransaction(tx);
        lastCheckMs = Math.max(lastCheckMs, tx.timestampMs + 1);
      }
    } catch (e) {
      error(`Main loop error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  info('Shutting down');
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});

main().catch(async (e) => {
  error(`Fatal error: ${e.stack || e.message}`);
  if (mongoClient) await mongoClient.close();
  process.exit(1);
});