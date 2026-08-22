const cron = require('node-cron');
const { checkTransactions } = require('../controllers/transactons');

const hasApiKey = Boolean(process.env.TRONGRID_API_KEY && process.env.TRONGRID_API_KEY.trim());
const POLL_INTERVAL_MS = hasApiKey ? 1500 : 4000;
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
    console.log('⚠️ [TronGrid Notice] No TRONGRID_API_KEY set in .env. Running in unauthenticated mode (4s interval).');
    console.log('👉 Get a free API key at https://www.trongrid.io/ and add TRONGRID_API_KEY=your_key to .env for full 1-2s instant speed (100k req/day free).');
  } else {
    console.log(`🚀 Real-time transaction monitor active (${POLL_INTERVAL_MS}ms interval with TronGrid API Key)`);
  }

  pollLoop();

  // Watchdog heartbeat every 30 seconds to ensure loop resilience
  cron.schedule('*/30 * * * * *', async () => {
    if (!isLoopRunning) {
      pollLoop();
    }
  });
}

main();



