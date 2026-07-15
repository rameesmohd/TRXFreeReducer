// models/Transaction.js
import mongoose from 'mongoose';

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

transactionSchema.index({ processedAt: -1 });

export default mongoose.model('Transaction', transactionSchema);