// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, unique: true },
    isBlocked: { type: Boolean, default: false },
    blockedAt: { type: Date, default: null },
    blockReason: { type: String, default: null },
    // Anti-bot fields
    riskScore: { type: Number, default: null },
    accountAgeDays: { type: Number, default: null },
    clusterGroup: { type: String, default: null }, // USDT destination address if part of bot cluster
    lastRiskAssessedAt: { type: Date, default: null },
  },
  { timestamps: true }
);



userSchema.index({ address: 1, isBlocked: 1 }); // covered query for isSenderBlocked
userSchema.index({ createdAt: 1 });               // new-address-per-hour rate limit

module.exports = mongoose.model('User', userSchema);
