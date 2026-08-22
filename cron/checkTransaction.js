const cron = require('node-cron');
const { checkTransactions } = require('../controllers/transactons');

const POLL_INTERVAL_MS = 1500; // 1.5 seconds between polling checks
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
  console.log(`Starting real-time transaction monitor (${POLL_INTERVAL_MS}ms interval)...`);
  pollLoop();

  // Watchdog heartbeat every 30 seconds to ensure loop resilience
  cron.schedule('*/30 * * * * *', async () => {
    if (!isLoopRunning) {
      pollLoop();
    }
  });
}

main();



