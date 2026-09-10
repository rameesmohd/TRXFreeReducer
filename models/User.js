// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, unique: true },
    isBlocked: { type: Boolean, default: false },
    blockedAt: { type: Date, default: null },
    blockReason: { type: String, default: null },
  },
  { timestamps: true }
);



userSchema.index({ address: 1, isBlocked: 1 }); // covered query for isSenderBlocked

module.exports = mongoose.model('User', userSchema);
