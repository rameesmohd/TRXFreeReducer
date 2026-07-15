const cron = require('node-cron');
const { checkTransactions } = require('../controllers/transactons');

async function main() {

  // Run immediately on startup
  await checkTransactions();

  // Schedule to run every 10 seconds
  cron.schedule('*/10 * * * * *', async () => {
    await checkTransactions();
  });

  console.log('Cron job scheduled (every 10 seconds)');
}

main();