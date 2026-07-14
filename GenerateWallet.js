/**
 * Generate a fresh TRON wallet.
 * Run once: npm run wallet
 */
import { TronWeb } from 'tronweb';

const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' });
const account = await tronWeb.createAccount();

console.log('\n' + '='.repeat(60));
console.log('  NEW TRON WALLET');
console.log('='.repeat(60));
console.log('\nAddress (give to customers):');
console.log(`  ${account.address.base58}`);
console.log('\nPrivate key (KEEP SECRET, put in .env):');
console.log(`  ${account.privateKey}`);
console.log('\n⚠  Save the private key NOW. It will not be shown again.');
console.log('⚠  Anyone with this key controls the wallet.\n');