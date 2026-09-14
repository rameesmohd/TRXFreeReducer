require('dotenv/config');
const cron = require('node-cron');
const { checkTransactions } = require('../controllers/transactons');
const { scanForBotClusters, ANTIBOT_ENABLED } = require('../controllers/antibot');

const hasApiKey = Boolean(process.env.TRONGRID_API_KEY && process.env.TRONGRID_API_KEY.trim());
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || (hasApiKey ? 2000 : 4000);
let isLoopRunning = false;

async function pollLoop() {
  if (isLoopRunning) return;
  isLoopRunning = true;

  try {
    await checkTransactions();
  } catch (err) {
    console.error('Error during transaction check loop:', err);
  } finally {
    isLoopRunning = false;
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

async function main() {
  if (!hasApiKey) {
    console.log('⚠️ [TronGrid Notice] No TRONGRID_API_KEY set in .env. Running in unauthenticated mode (5s interval).');
    console.log('👉 Get a free API key at https://www.trongrid.io/ and add TRONGRID_API_KEY=your_key to .env for fast 2-5s speed (100k req/day free).');
  } else {
    console.log(`🚀 Real-time transaction monitor active (${POLL_INTERVAL_MS}ms interval with TronGrid API Key, 2-5s credit time)`);
  }

  if (ANTIBOT_ENABLED) {
    console.log('🛡️ Anti-bot v2 active (USDT destination clustering + account age gating + risk scoring)');
  } else {
    console.log('⚠️ Anti-bot v2 DISABLED (set ANTIBOT_V2_ENABLED=true in .env to enable)');
  }

  pollLoop();

  // Watchdog heartbeat every 30 seconds to ensure loop resilience
  cron.schedule('*/30 * * * * *', async () => {
    if (!isLoopRunning) {
      pollLoop();
    }
  });

  // Bot cluster scanner: runs on startup + every 5 minutes
  // Checks where recent energy recipients sent their USDT
  // If multiple recipients → same USDT destination → bot farm → block all
  if (ANTIBOT_ENABLED) {
    // Run once 5 seconds after startup to catch bots immediately
    setTimeout(async () => {
      try {
        await scanForBotClusters();
      } catch (err) {
        console.error('Error during initial bot cluster scan:', err);
      }
    }, 5000);

    cron.schedule('*/5 * * * *', async () => {
      try {
        await scanForBotClusters();
      } catch (err) {
        console.error('Error during bot cluster scan:', err);
      }
    });
    console.log('🔍 Bot cluster scanner scheduled (runs on startup + every 5 minutes)');
  }
}

main();
