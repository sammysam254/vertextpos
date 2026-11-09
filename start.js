/**
 * Entry point for Supermarket POS Biometric Hub
 */
const { startServer } = require('./src/server/app');
const config = require('./src/config');

console.log('======================================================================');
console.log('   METROPOLIS SUPERMARKET POS — BIOMETRIC SUPERVISOR HUB              ');
console.log('======================================================================');
console.log(`Branch: ${config.terminal.defaultBranchName} (${config.terminal.defaultBranchId})`);
console.log(`Register Terminal: ${config.terminal.defaultRegisterId}`);
console.log(`Hardware Integration: Windows Biometric Framework (WinBio) & WebAuthn`);
console.log(`Challenge Validity: ${config.security.challengeTimeoutMs / 1000}s`);
console.log('----------------------------------------------------------------------');

startServer().then(() => {
  console.log(`POS Touchscreen UI accessible at: http://${config.server.host}:${config.server.port}`);
  console.log('Press Ctrl+C to stop the terminal server.');
});

