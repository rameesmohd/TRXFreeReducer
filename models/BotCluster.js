// models/BotCluster.js
const mongoose = require('mongoose');

const botClusterSchema = new mongoose.Schema(
  {
    // The USDT destination address that all bot wallets send to (the bot operator)
    usdtDestination: { type: String, required: true, unique: true },
    // All bot sender addresses that sent USDT to this destination
    linkedAddresses: { type: [String], default: [] },
    // When the cluster was first detected
    detectedAt: { type: Date, default: Date.now },
    // Whether to auto-block new wallets linked to this destination
    isBlocked: { type: Boolean, default: true },
    // Damage tracking
    totalEnergyStolen: { type: Number, default: 0 },
    totalDeliveries: { type: Number, default: 0 },
  },
  { timestamps: true }
);

botClusterSchema.index({ usdtDestination: 1 });
botClusterSchema.index({ linkedAddresses: 1 });
botClusterSchema.index({ isBlocked: 1 });

module.exports = mongoose.model('BotCluster', botClusterSchema);
