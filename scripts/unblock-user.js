require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const addressToUnblock = process.argv[2] || 'TWXbNpzdFjiN45dU8kwH2FRJi2y7uhz1Xz';

async function main() {
  const mongoUrl = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/FreeTx';
  await mongoose.connect(mongoUrl);
  console.log(`Connected to MongoDB`);

  const res = await User.findOneAndUpdate(
    { address: addressToUnblock },
    { $set: { isBlocked: false, unblockedAt: new Date() }, $unset: { blockReason: '' } },
    { returnDocument: 'after' }
  );

  if (res) {
    console.log(`✅ Successfully unblocked ${addressToUnblock}:`, {
      address: res.address,
      isBlocked: res.isBlocked,
      unblockedAt: res.unblockedAt,
    });
  } else {
    console.log(`ℹ Address ${addressToUnblock} was not found in the local database (it may have been blocked in your production Atlas database).`);
  }
  await mongoose.disconnect();
}

main().catch(console.error);
