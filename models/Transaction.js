// models/Transaction.js
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    txid: { type: String, required: true, unique: true },
    sender: { type: String, required: true, index: true },
    amountTrx: { type: Number, required: true },
    status: { type: String, required: true, index: true },
    energyDelivered: { type: Number, default: null },
    wholesaleCostTrx: { type: Number, default: null },
    profitTrx: { type: Number, default: null },
    orderId: { type: String, default: null },
    txHash: { type: String, default: null },
    errorMessage: { type: String, default: null },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

transactionSchema.index({ sender: 1, processedAt: -1 });
transactionSchema.index({ sender: 1, status: 1, processedAt: -1 }); // getDailyPurchaseCount
transactionSchema.index({ sender: 1, receivedAt: -1 });             // getRecentTxCount
transactionSchema.index({ status: 1, processedAt: -1 });            // Stats 24h aggregation
transactionSchema.index({ receivedAt: -1 });                        // range scans on receivedAt

module.exports = mongoose.model('Transaction', transactionSchema);