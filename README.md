# TRON Energy Reseller Bot (Node.js + MongoDB)

A reseller bot for TRON energy. You don't stake TRX yourself — you buy energy from a wholesale provider (TronSave) and resell it to your audience at a small markup.

## How it works

1. Customer sends **3 TRX** to your address
2. Bot detects the payment within ~5 seconds
3. Bot calls TronSave API to buy ~65,000 energy for the customer's address
4. TronSave delegates energy directly to the customer for 1 hour
5. Customer does their USDT transfer using the rented energy
6. You keep the spread (~0.3–0.8 TRX per transaction depending on market rates)

## Setup

### 1. Install
Requires **Node.js 18+**.
```bash
cd eezytron-mongo
npm install
```

### 2. Set up MongoDB

**Option A — MongoDB Atlas (free tier, recommended for starting):**
1. Go to https://www.mongodb.com/cloud/atlas/register
2. Create a free M0 cluster (512MB, free forever)
3. Add your VPS IP to network access whitelist (or `0.0.0.0/0` for testing)
4. Create a database user
5. Copy the connection string into `MONGO_URI` in `.env`

**Option B — Local MongoDB on your VPS:**
```bash
# Ubuntu
sudo apt install -y mongodb
sudo systemctl start mongodb
sudo systemctl enable mongodb
# Then use mongodb://localhost:27017 in .env
```

**Option C — Docker:**
```bash
docker run -d -p 27017:27017 --name eezytron-mongo \
  -v eezytron-data:/data/db \
  mongo:7
```

### 3. Generate a fresh wallet
```bash
npm run wallet
```
Save both the address and private key. The address is public; the private key goes in `.env`.

### 4. Sign up for accounts

- **TronGrid** (free): https://www.trongrid.io — create project, copy API key
- **TronSave** (reseller): https://tronsave.io — sign up, deposit a small amount of TRX (~50 TRX is enough to start), get API key from dashboard

### 5. Configure
```bash
cp .env.example .env
# Edit .env with your address, private key, API keys, and Mongo URI
```

### 6. Seed your hot wallet
Send ~10 TRX to your bot address. This covers bandwidth for refund transactions.

Send the rest of your starting capital (~40 TRX) to your **TronSave balance** — that's where it actually buys energy.

### 7. Run
```bash
npm start
```

### 8. Check stats
```bash
npm run stats
```

## Why MongoDB over SQLite here?

- **No native compilation.** `better-sqlite3` builds C++ on install; can fail on minimal VPS images. The mongo driver is pure JS.
- **Hosted free tier.** Atlas M0 is free forever, no VPS storage to manage.
- **Easier to add a dashboard later.** Want a web admin panel? Mongo is trivial to query from a separate Express server.
- **Scales horizontally.** If you ever run multiple bot instances (different addresses, different regions), they can share one database.

For a single bot, SQLite is technically faster (no network round-trip per query), but for this workload the difference is irrelevant — you process a few transactions per minute at most.

## Schema

The `transactions` collection stores one document per incoming TRX transaction:

```js
{
  txid: "abc123...",                  // unique
  sender: "TXyz...",
  amountTrx: 3.0,
  status: "delivered",                // or refunded_invalid_amount, refunded_new_wallet, refunded_provider_error
  energyDelivered: 65000,
  wholesaleCostTrx: 2.3,
  profitTrx: 0.7,
  errorMessage: null,
  receivedAt: ISODate("..."),
  processedAt: ISODate("...")
}
```

Indexes: `txid` (unique), `status`, `processedAt` (desc), `sender`.

## Useful MongoDB queries

Drop into `mongosh` for ad-hoc analysis:

```js
// Today's profit
db.transactions.aggregate([
  { $match: { status: 'delivered', processedAt: { $gte: new Date(Date.now() - 86400000) } } },
  { $group: { _id: null, profit: { $sum: '$profitTrx' }, count: { $sum: 1 } } }
])

// Top 10 customers by transaction count
db.transactions.aggregate([
  { $match: { status: 'delivered' } },
  { $group: { _id: '$sender', txs: { $sum: 1 }, totalRevenue: { $sum: '$amountTrx' } } },
  { $sort: { txs: -1 } },
  { $limit: 10 }
])

// Failed transactions in last hour (debugging)
db.transactions.find({
  status: { $regex: /^refunded/ },
  processedAt: { $gte: new Date(Date.now() - 3600000) }
}).sort({ processedAt: -1 })
```

## Running in production

```bash
npm install -g pm2
pm2 start src/bot.js --name eezytron
pm2 logs eezytron
pm2 save
pm2 startup
```

## Pricing

Default tiers (customer pays → energy delivered):
- 3 TRX → 65k energy (1 USDT tx to existing wallet)
- 6 TRX → 131k energy (1 USDT tx to new/exchange wallet)
- 10 TRX → 200k energy (~3 USDT txs)
- 25 TRX → 550k energy (~8 USDT txs)

Adjust `PRICING` object in `src/bot.js` based on TronSave wholesale rates. Keep at least 15% margin.

## What customers see

Post in your community:
```
⚡ ENERGY RENTAL ⚡
Send 3 TRX to: TYourAddressHere
→ Get energy for 1 USDT transfer (1 hour validity)
→ 6 TRX if your wallet has never received USDT before
→ Energy delivered automatically within 10 seconds
```

## Security

- Hot wallet needs only ~10 TRX. Don't store more there.
- TronSave balance is the actual capital. Their security is your security on that side.
- Never share `.env` or commit it to git.
- For Atlas, restrict IP access to your VPS only — don't leave `0.0.0.0/0` after testing.
- Run on a VPS you control.

## Disclaimer

You are responsible for:
- Tax obligations in your jurisdiction
- Compliance with any money-services regulations
- Customer service
- Securing your keys

**Test on TRON testnet (Nile) before mainnet.** Verify TronSave's current API spec at their docs — endpoint paths and parameter names may have shifted.
