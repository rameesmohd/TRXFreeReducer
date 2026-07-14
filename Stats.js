/**
 * Quick stats viewer. Run: npm run stats
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGO_DB || 'eezytron';

const client = new MongoClient(MONGO_URI);
await client.connect();
const txCol = client.db(MONGO_DB).collection('transactions');

console.log('\n' + '='.repeat(60));
console.log('  EEZYTRON-CLONE STATS (MongoDB)');
console.log('='.repeat(60));

// Totals via aggregation
const totalsAgg = await txCol.aggregate([
  {
    $group: {
      _id: null,
      total: { $sum: 1 },
      delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
      refunded: {
        $sum: {
          $cond: [
            { $regexMatch: { input: '$status', regex: /^refunded/ } },
            1, 0
          ]
        }
      },
      revenue: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$amountTrx', 0] } },
      cost: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$wholesaleCostTrx', 0] } },
      profit: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$profitTrx', 0] } },
    }
  }
]).toArray();

const t = totalsAgg[0] || { total: 0, delivered: 0, refunded: 0, revenue: 0, cost: 0, profit: 0 };
console.log(`\nTotal transactions:  ${t.total}`);
console.log(`  Delivered:         ${t.delivered}`);
console.log(`  Refunded:          ${t.refunded}`);
console.log(`\nRevenue:             ${(t.revenue || 0).toFixed(2)} TRX`);
console.log(`Wholesale cost:      ${(t.cost || 0).toFixed(2)} TRX`);
console.log(`Net profit:          ${(t.profit || 0).toFixed(2)} TRX`);

// Last 24h
const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
const last24hAgg = await txCol.aggregate([
  { $match: { processedAt: { $gt: since }, status: 'delivered' } },
  { $group: { _id: null, count: { $sum: 1 }, profit: { $sum: '$profitTrx' } } }
]).toArray();
const h = last24hAgg[0] || { count: 0, profit: 0 };
console.log(`\nLast 24h:            ${h.count} txs, ${(h.profit || 0).toFixed(2)} TRX profit`);

// Recent
console.log('\nRecent transactions:');
console.log('-'.repeat(60));
const recent = await txCol
  .find({})
  .sort({ processedAt: -1 })
  .limit(10)
  .toArray();

for (const row of recent) {
  const ts = row.processedAt ? row.processedAt.toISOString().slice(0, 19) : '?';
  const sender = (row.sender || '????????').slice(0, 8);
  const amt = (row.amountTrx || 0).toFixed(2).padStart(6);
  const status = (row.status || '').padEnd(25);
  const prof = row.profitTrx != null
    ? (row.profitTrx >= 0 ? '+' : '') + row.profitTrx.toFixed(2)
    : '  -  ';
  console.log(`  ${ts}  ${sender}...  ${amt}  ${status}  ${prof}`);
}
console.log();
await client.close();