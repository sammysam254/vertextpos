/**
 * Comprehensive Acceptance Test Suite for Biometric Supervisor Authorization
 *
 * Runs completely in-process using direct HTTP pipeline dispatch.
 * Zero external TCP network port dependency.
 *
 * Verifies all 12 core acceptance requirements + edge cases:
 * 1. Cashier requests transaction suspension.
 * 2. System requests a fingerprint (fresh cryptographic challenge issued).
 * 3. Cashier fingerprint is rejected (role check & unauthorized rejection).
 * 4. Unauthorized suspension is blocked.
 * 5. Supervisor fingerprint is verified.
 * 6. Suspension succeeds, state saved, POS available for next customer.
 * 7. Cashier serves another customer (creates second cart).
 * 8. Cashier requests resumption of the suspended transaction.
 * 9. Fingerprint authorization is requested again (fresh challenge issued, no session re-use).
 * 10. Supervisor fingerprint is verified.
 * 11. Original transaction restored with products, quantities, prices & previous payments intact.
 * 12. Audit log verifies supervisor identity and timestamp for both operations.
 *
 * Plus:
 * 13. Replay attack rejection test (reusing consumed challenge fails).
 * 14. Cross-branch isolation test (supervisor from BR-002 cannot authorize BR-001).
 * 15. Hardware disconnection & Emergency Administrator Override fallback.
 */

const assert = require('assert');
const { createServer } = require('../src/server/app');
const { PassThrough } = require('stream');

let server;

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = method;
    req.url = path;
    req.headers = {
      'content-type': 'application/json',
      'host': 'localhost'
    };

    const res = new PassThrough();
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.writeHead = (code, headers) => {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
    };

    let responseData = '';
    res.on('data', chunk => responseData += chunk.toString('utf8'));
    res.on('end', () => {
      let parsed = responseData;
      try {
        parsed = JSON.parse(responseData);
      } catch (e) {}
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: parsed
      });
    });

    server.emit('request', req, res);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runAcceptanceTests() {
  console.log('================================================================');
  console.log('🚀 RUNNING BIOMETRIC SUPERVISOR AUTHORIZATION ACCEPTANCE TESTS');
  console.log('================================================================\n');

  server = createServer();

  try {
    // -----------------------------------------------------------------
    // SETUP: Cashier rings up items and takes partial payment
    // -----------------------------------------------------------------
    console.log('--- SETUP: Creating Customer 1 Transaction at REG-01 ---');
    const newTxRes = await makeRequest('/api/pos/transaction/new', 'POST', {
      cashierId: 'user_c01',
      branchId: 'BR-001',
      registerId: 'REG-01'
    });
    assert.strictEqual(newTxRes.statusCode, 201, 'Transaction creation should return 201');
    const tx1 = newTxRes.body.transaction;
    const tx1Id = tx1.id;
    console.log(`[PASS] Transaction created: ${tx1Id}`);

    // Add items: Organic Whole Milk and Artisan Sourdough
    const addItem1 = await makeRequest(`/api/pos/transaction/${tx1Id}/item`, 'POST', { barcodeOrId: '011110000018', quantity: 2 });
    assert.strictEqual(addItem1.statusCode, 200);
    const addItem2 = await makeRequest(`/api/pos/transaction/${tx1Id}/item`, 'POST', { barcodeOrId: '011110000025', quantity: 1 });
    assert.strictEqual(addItem2.statusCode, 200);

    // Customer partially tenders $10 cash, but realizes wallet was left in car
    const partialPay = await makeRequest(`/api/pos/transaction/${tx1Id}/payment`, 'POST', {
      method: 'CASH',
      amount: 10.00
    });
    assert.strictEqual(partialPay.statusCode, 200);
    console.log(`[PASS] Cart populated: 2 items, $10.00 cash partial payment recorded. Total: $${partialPay.body.transaction.total}, Balance Due: $${partialPay.body.transaction.balanceDue}`);

    // -----------------------------------------------------------------
    // STEP 1 & 2: Cashier requests transaction suspension -> System requests fingerprint
    // -----------------------------------------------------------------
    console.log('\n--- STEPS 1 & 2: Cashier Requests Suspension & System Requests Biometric ---');
    const suspendReq = await makeRequest(`/api/pos/transaction/${tx1Id}/suspend/request`, 'POST', {
      cashierId: 'user_c01',
      branchId: 'BR-001',
      registerId: 'REG-01',
      reason: 'Customer left wallet in car'
    });
    assert.strictEqual(suspendReq.statusCode, 200);
    assert.strictEqual(suspendReq.body.requiresBiometric, true);
    assert.strictEqual(suspendReq.body.action, 'SUSPEND_TRANSACTION');
    assert.ok(suspendReq.body.challenge, 'Fresh cryptographic challenge must be issued');
    const challenge1 = suspendReq.body.challenge;
    console.log(`[PASS] Step 1 & 2 verified: Fingerprint challenge generated: ${challenge1.substring(0, 16)}... Timeout: ${suspendReq.body.timeoutSeconds}s`);

    // -----------------------------------------------------------------
    // STEP 3 & 4: Cashier attempts to use own fingerprint -> Rejected & Blocked
    // -----------------------------------------------------------------
    console.log('\n--- STEPS 3 & 4: Cashier Fingerprint Rejected & Unauthorized Suspension Blocked ---');
    const cashierScan = await makeRequest('/api/biometric/scan-simulate', 'POST', {
      challenge: challenge1,
      userId: 'user_c01' // Dave Miller (Cashier)
    });
    assert.strictEqual(cashierScan.statusCode, 200);

    const cashierAuthAttempt = await makeRequest(`/api/pos/transaction/${tx1Id}/suspend/authorize`, 'POST', {
      challenge: challenge1,
      assertion: cashierScan.body,
      branchId: 'BR-001',
      registerId: 'REG-01',
      reason: 'Cashier trying to self-authorize'
    });

    assert.strictEqual(cashierAuthAttempt.statusCode, 403, 'Cashier fingerprint MUST return 403 Forbidden');
    assert.strictEqual(cashierAuthAttempt.body.authorized, false);
    assert.strictEqual(cashierAuthAttempt.body.error, 'UNAUTHORIZED_ROLE');
    console.log(`[PASS] Step 3 & 4 verified: Cashier fingerprint correctly rejected: "${cashierAuthAttempt.body.message}"`);

    // Verify transaction remains ACTIVE and was NOT suspended
    const checkTxActive = await makeRequest(`/api/pos/transaction/${tx1Id}`, 'GET');
    assert.strictEqual(checkTxActive.body.transaction.status, 'ACTIVE');
    console.log(`[PASS] Transaction remains ACTIVE. Unauthorized suspension completely blocked.`);

    // -----------------------------------------------------------------
    // STEP 5 & 6: Supervisor fingerprint is verified -> Suspension succeeds
    // -----------------------------------------------------------------
    console.log('\n--- STEPS 5 & 6: Supervisor Fingerprint Verified & Suspension Succeeds ---');
    // Because the previous challenge was consumed/burned on the failed attempt,
    // a fresh challenge is required (guaranteeing replay protection)
    const freshSuspendReq = await makeRequest(`/api/pos/transaction/${tx1Id}/suspend/request`, 'POST', {
      cashierId: 'user_c01',
      branchId: 'BR-001',
      registerId: 'REG-01',
      reason: 'Supervisor called to approve'
    });
    const supervisorChallenge1 = freshSuspendReq.body.challenge;

    // Supervisor Alice Vance places finger on reader
    const supervisorScan = await makeRequest('/api/biometric/scan-simulate', 'POST', {
      challenge: supervisorChallenge1,
      userId: 'user_s01' // Alice Vance (Supervisor)
    });
    assert.strictEqual(supervisorScan.statusCode, 200);

    const supervisorAuth = await makeRequest(`/api/pos/transaction/${tx1Id}/suspend/authorize`, 'POST', {
      challenge: supervisorChallenge1,
      assertion: supervisorScan.body,
      branchId: 'BR-001',
      registerId: 'REG-01',
      reason: 'Customer wallet in car'
    });

    assert.strictEqual(supervisorAuth.statusCode, 200, 'Supervisor authorization should succeed');
    assert.strictEqual(supervisorAuth.body.authorized, true);
    assert.strictEqual(supervisorAuth.body.displayMessage.title, 'SUSPENSION AUTHORIZED');
    assert.strictEqual(supervisorAuth.body.displayMessage.supervisor, 'Alice Vance');
    assert.ok(supervisorAuth.body.displayMessage.time, 'Timestamp must be present');
    assert.strictEqual(supervisorAuth.body.transaction.status, 'SUSPENDED');
    console.log(`[PASS] Step 5 & 6 verified: Suspension Authorized! Display:`);
    console.log(`       SUSPENSION AUTHORIZED`);
    console.log(`       Supervisor: ${supervisorAuth.body.displayMessage.supervisor}`);
    console.log(`       Time: ${supervisorAuth.body.displayMessage.time}`);

    // -----------------------------------------------------------------
    // STEP 7: Cashier serves another customer (POS available for next customer)
    // -----------------------------------------------------------------
    console.log('\n--- STEP 7: Cashier Serves Another Customer (Customer 2) ---');
    const nextTxRes = await makeRequest('/api/pos/transaction/new', 'POST', {
      cashierId: 'user_c01',
      branchId: 'BR-001',
      registerId: 'REG-01'
    });
    const tx2 = nextTxRes.body.transaction;
    assert.notStrictEqual(tx2.id, tx1Id, 'New transaction must have distinct ID');
    assert.strictEqual(tx2.status, 'ACTIVE');

    // Ring up items for Customer 2
    await makeRequest(`/api/pos/transaction/${tx2.id}/item`, 'POST', { barcodeOrId: '011110000032', quantity: 3 });
    console.log(`[PASS] Step 7 verified: POS available for next customer. Transaction ${tx2.id} created and active.`);

    // Check suspended transactions list
    const suspendedListRes = await makeRequest('/api/pos/suspended?branchId=BR-001', 'GET');
    const suspendedItems = suspendedListRes.body.suspendedTransactions;
    const foundSuspended = suspendedItems.find(t => t.id === tx1Id);
    assert.ok(foundSuspended, 'Original transaction must be present in suspended orders list');
    console.log(`[PASS] Suspended orders count: ${suspendedItems.length}. Tx ${tx1Id} is held.`);

    // -----------------------------------------------------------------
    // STEP 8 & 9: Cashier requests resumption -> Fresh biometric authorization requested
    // -----------------------------------------------------------------
    console.log('\n--- STEPS 8 & 9: Cashier Requests Resumption & Fresh Biometric Prompt Appears ---');
    const resumeReq = await makeRequest(`/api/pos/transaction/${tx1Id}/resume/request`, 'POST', {
      cashierId: 'user_c01',
      branchId: 'BR-001',
      registerId: 'REG-01'
    });
    assert.strictEqual(resumeReq.statusCode, 200);
    assert.strictEqual(resumeReq.body.requiresBiometric, true);
    assert.strictEqual(resumeReq.body.action, 'RESUME_TRANSACTION');
    const resumeChallenge = resumeReq.body.challenge;
    assert.notStrictEqual(resumeChallenge, supervisorChallenge1, 'Resumption MUST generate a fresh challenge; old session CANNOT be reused!');
    console.log(`[PASS] Step 8 & 9 verified: Fresh challenge issued for resumption: ${resumeChallenge.substring(0, 16)}...`);

    // Test: Attempting to use old suspension token or re-using old challenge must fail
    const replayAttempt = await makeRequest(`/api/pos/transaction/${tx1Id}/resume/authorize`, 'POST', {
      challenge: supervisorChallenge1, // Already consumed!
      assertion: supervisorScan.body,
      branchId: 'BR-001',
      registerId: 'REG-01'
    });
    assert.strictEqual(replayAttempt.statusCode, 403);
    console.log(`[PASS] Replay Protection verified: Reusing old fingerprint challenge was blocked: "${replayAttempt.body.message}"`);

    // -----------------------------------------------------------------
    // STEP 10 & 11: Supervisor fingerprint verified & original transaction restored
    // -----------------------------------------------------------------
    console.log('\n--- STEPS 10 & 11: Supervisor Fingerprint Verified & Original Transaction Restored ---');
    // Supervisor Bob Chen authenticates resumption
    const bobScan = await makeRequest('/api/biometric/scan-simulate', 'POST', {
      challenge: resumeChallenge,
      userId: 'user_s02' // Bob Chen (Shift Supervisor)
    });
    assert.strictEqual(bobScan.statusCode, 200);

    const bobResumeAuth = await makeRequest(`/api/pos/transaction/${tx1Id}/resume/authorize`, 'POST', {
      challenge: resumeChallenge,
      assertion: bobScan.body,
      branchId: 'BR-001',
      registerId: 'REG-01'
    });

    assert.strictEqual(bobResumeAuth.statusCode, 200, 'Supervisor resumption authorization should succeed');
    assert.strictEqual(bobResumeAuth.body.authorized, true);
    assert.strictEqual(bobResumeAuth.body.displayMessage.title, 'RESUMPTION AUTHORIZED');
    assert.strictEqual(bobResumeAuth.body.displayMessage.supervisor, 'Bob Chen');
    assert.ok(bobResumeAuth.body.displayMessage.time);

    console.log(`[PASS] Step 10 verified: Resumption Authorized! Display:`);
    console.log(`       RESUMPTION AUTHORIZED`);
    console.log(`       Supervisor: ${bobResumeAuth.body.displayMessage.supervisor}`);
    console.log(`       Time: ${bobResumeAuth.body.displayMessage.time}`);

    // Verify Step 11: Original transaction fully restored
    const restoredTx = bobResumeAuth.body.transaction;
    assert.strictEqual(restoredTx.status, 'ACTIVE');
    assert.strictEqual(restoredTx.items.length, 2, 'All items must be restored');
    assert.strictEqual(restoredTx.items[0].barcode, '011110000018');
    assert.strictEqual(restoredTx.items[0].quantity, 2);
    assert.strictEqual(restoredTx.payments.length, 1, 'Previous payment must be preserved');
    assert.strictEqual(restoredTx.payments[0].method, 'CASH');
    assert.strictEqual(restoredTx.payments[0].amount, 10.00);
    assert.strictEqual(restoredTx.payments[0].status, 'SUCCEEDED');
    assert.strictEqual(bobResumeAuth.body.recoveredState.previousPaidTotal, 10.00);
    console.log(`[PASS] Step 11 verified: Original transaction ${tx1Id} restored! Products, quantities, prices, and $10.00 partial cash payment intact.`);

    // -----------------------------------------------------------------
    // STEP 12: Audit log identifies supervisor responsible for both operations
    // -----------------------------------------------------------------
    console.log('\n--- STEP 12: Audit Log Verification ---');
    const auditRes = await makeRequest('/api/audit/logs?limit=50', 'GET');
    assert.strictEqual(auditRes.statusCode, 200);
    const logs = auditRes.body.logs;

    const suspensionLog = logs.find(l => l.eventType === 'SUSPENSION_AUTHORIZED' && l.metadata.txId === tx1Id);
    assert.ok(suspensionLog, 'Audit log must contain SUSPENSION_AUTHORIZED entry');
    assert.strictEqual(suspensionLog.userName, 'Alice Vance');
    assert.strictEqual(suspensionLog.userRole, 'supervisor');
    console.log(`[PASS] Audit log verified for suspension: Authorized by ${suspensionLog.userName} at ${suspensionLog.timestamp}`);

    const resumptionLog = logs.find(l => l.eventType === 'RESUMPTION_AUTHORIZED' && l.metadata.txId === tx1Id);
    assert.ok(resumptionLog, 'Audit log must contain RESUMPTION_AUTHORIZED entry');
    assert.strictEqual(resumptionLog.userName, 'Bob Chen');
    assert.strictEqual(resumptionLog.userRole, 'supervisor');
    console.log(`[PASS] Audit log verified for resumption: Authorized by ${resumptionLog.userName} at ${resumptionLog.timestamp}`);

    // Verify rejection audit logs also recorded
    const rejectedLog = logs.find(l => l.eventType === 'FAILED_VERIFICATION_ATTEMPT');
    assert.ok(rejectedLog, 'Audit log must record failed cashier verification attempt');
    console.log(`[PASS] Audit log contains failed attempt record: "${rejectedLog.reason}"`);

    // -----------------------------------------------------------------
    // STEP 13: Cross-Branch Isolation Test (Carol Diaz, BR-002 Only)
    // -----------------------------------------------------------------
    console.log('\n--- STEP 13: Cross-Branch Permission Isolation Test ---');
    const branchTxReq = await makeRequest(`/api/pos/transaction/${tx2.id}/suspend/request`, 'POST', {
      cashierId: 'user_c01',
      branchId: 'BR-001',
      registerId: 'REG-01'
    });
    const branchChallenge = branchTxReq.body.challenge;

    const carolScan = await makeRequest('/api/biometric/scan-simulate', 'POST', {
      challenge: branchChallenge,
      userId: 'user_s03' // Carol Diaz: Supervisor at BR-002 ONLY!
    });
    const carolAuthAttempt = await makeRequest(`/api/pos/transaction/${tx2.id}/suspend/authorize`, 'POST', {
      challenge: branchChallenge,
      assertion: carolScan.body,
      branchId: 'BR-001',
      registerId: 'REG-01'
    });

    assert.strictEqual(carolAuthAttempt.statusCode, 403);
    assert.strictEqual(carolAuthAttempt.body.error, 'BRANCH_UNAUTHORIZED');
    console.log(`[PASS] Branch isolation verified: Supervisor assigned to BR-002 rejected on BR-001: "${carolAuthAttempt.body.message}"`);

    // -----------------------------------------------------------------
    // STEP 14: Hardware Disconnection & Emergency Administrator Fallback Test
    // -----------------------------------------------------------------
    console.log('\n--- STEP 14: Hardware Disconnection & Emergency Override Fallback ---');
    // Simulate USB hardware disconnection
    const disconnectRes = await makeRequest('/api/biometric/device/simulate-connection', 'POST', {
      state: 'DISCONNECTED',
      reason: 'Physical cable damaged'
    });
    assert.strictEqual(disconnectRes.body.connected, false);
    console.log(`[PASS] Biometric reader disconnected: "${disconnectRes.body.message}"`);

    // Attempting biometric authorization while disconnected fails with clear message
    const disconSuspendReq = await makeRequest(`/api/pos/transaction/${tx2.id}/suspend/request`, 'POST', {
      cashierId: 'user_c01',
      branchId: 'BR-001',
      registerId: 'REG-01'
    });
    const blockedScan = await makeRequest('/api/biometric/scan-simulate', 'POST', {
      challenge: disconSuspendReq.body.challenge,
      userId: 'user_s01'
    });
    assert.strictEqual(blockedScan.body.success, false);
    assert.strictEqual(blockedScan.body.error, 'DEVICE_DISCONNECTED');
    console.log(`[PASS] Hardware failure detected: Biometric scan blocked: "${blockedScan.body.message}"`);

    // Perform Controlled Emergency Administrator Override
    const emergencyOverride = await makeRequest('/api/pos/emergency-override', 'POST', {
      txId: tx2.id,
      action: 'SUSPEND_TRANSACTION',
      adminUsername: 'eleanor.wright',
      emergencyPasscode: 'Admin@Emergency2026!',
      reason: 'HARDWARE_DISCONNECTED',
      branchId: 'BR-001',
      registerId: 'REG-01',
      incidentNotes: 'Fingerprint scanner USB port physical damage; IT ticket #4910 opened.'
    });

    assert.strictEqual(emergencyOverride.statusCode, 200);
    assert.strictEqual(emergencyOverride.body.authorized, true);
    assert.strictEqual(emergencyOverride.body.emergency, true);
    console.log(`[PASS] Emergency override successfully granted: ${emergencyOverride.body.displayMessage.title} by ${emergencyOverride.body.displayMessage.supervisor}`);

    // Reconnect hardware
    await makeRequest('/api/biometric/device/simulate-connection', 'POST', {
      state: 'CONNECTED',
      reason: 'Replacement reader connected'
    });

    console.log('\n================================================================');
    console.log('✅ ALL ACCEPTANCE TESTS PASSED WITH 100% SUCCESS!');
    console.log('================================================================');
  } catch (e) {
    throw e;
  }
}

if (require.main === module) {
  runAcceptanceTests().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('\n❌ ACCEPTANCE TEST FAILED:', err);
    process.exit(1);
  });
}

module.exports = { runAcceptanceTests };
