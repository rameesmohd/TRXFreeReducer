const axios = require('axios');
require('dotenv/config');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

/**
 * Low-level sender. Fixes the bugs in the original snippet:
 * - axios responses don't have `.ok` (that's the fetch API) — axios
 *   throws on non-2xx by default, so a try/catch is enough.
 * - axios needs `data`, not a JSON-stringified `body`.
 * - the catch param must not be named `error`, or calling error(...)
 *   inside the catch recurses into itself instead of logging.
 */
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Telegram notification skipped: missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID');
    return;
  }
  try {
    await axios.post(
      TELEGRAM_API_URL,
      { chat_id: TELEGRAM_CHAT_ID, text },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error(`Telegram notification failed: ${detail}`);
  }
}

// 1. New fund detected on the receive address
async function notifyFundReceived(sender, amountTrx, txid) {
  const text =
    `🟢 New Fund Detected\n` +
    `From: ${sender}\n` +
    `Amount: ${amountTrx} TRX\n` +
    `Tx: ${txid}`;
  await sendTelegramMessage(text);
}

// 2. Energy purchased from Netts
async function notifyPurchase(sender, energyAmount, costTrx, orderId) {
  const text =
    `🛒 Energy Purchase\n` +
    `Receiver: ${sender}\n` +
    `Energy: ${energyAmount.toLocaleString()}\n` +
    `Cost: ${costTrx} TRX\n` +
    `Order: ${orderId || 'N/A'}`;
  await sendTelegramMessage(text);
}

// 3a. Full delivery succeeded
async function notifySuccess(sender, amountTrx, energyAmount, costTrx, profitTrx, orderId, txid, nettsBalance) {
  const balanceText = nettsBalance != null
    ? `Netts Balance: ${typeof nettsBalance === 'number' ? nettsBalance.toFixed(2) : nettsBalance} TRX\n`
    : '';

  const text =
    `✅ Delivery Success\n` +
    `Receiver: ${sender}\n` +
    `Energy: ${energyAmount.toLocaleString()}\n` +
    `Revenue: ${amountTrx} TRX\n` +
    `Cost: ${costTrx} TRX\n` +
    `Profit: ${profitTrx.toFixed(3)} TRX\n` +
    balanceText +
    `Order: ${orderId || 'N/A'}\n` +
    `Tx: ${txid}`;
  await sendTelegramMessage(text);
}

// 3b. Delivery failed (bad amount, new wallet, provider error, etc.)
async function notifyFailure(sender, amountTrx, reason, txid, nettsBalance) {
  const balanceText = nettsBalance != null
    ? `Netts Balance: ${typeof nettsBalance === 'number' ? nettsBalance.toFixed(2) : nettsBalance} TRX\n`
    : '';

  const text =
    `🔴 Delivery Failed\n` +
    `Sender: ${sender}\n` +
    `Amount: ${amountTrx} TRX\n` +
    `Reason: ${reason}\n` +
    balanceText +
    `Tx: ${txid}`;
  await sendTelegramMessage(text);
}

module.exports = {
  sendTelegramMessage,
  notifyFundReceived,
  notifyPurchase,
  notifySuccess,
  notifyFailure,
};