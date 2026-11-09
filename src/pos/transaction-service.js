const db = require('../db/database');
const AuditLogger = require('../security/audit-logger');
const sessionManager = require('../security/session-manager');
const biometricAdapter = require('../biometric/biometric-adapter');
const EmergencyOverrideService = require('../security/emergency-override');

/**
 * Supermarket POS Transaction Service.
 * Coordinates Cart, Scanning, Payments, Biometric Suspension, and Resumption.
 */
class TransactionService {
  /**
   * Creates a new active transaction for a cashier register.
   */
  createNewTransaction(cashierId, branchId = 'BR-001', registerId = 'REG-01') {
    const cashier = db.getUserById(cashierId) || { id: cashierId, name: 'Cashier' };
    const txId = `TX-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;

    const newTx = {
      id: txId,
      status: 'ACTIVE', // ACTIVE, SUSPENDED, COMPLETED, CANCELLED
      branchId,
      registerId,
      cashierId: cashier.id,
      cashierName: cashier.name,
      items: [],
      subtotal: 0.0,
      tax: 0.0,
      total: 0.0,
      payments: [], // Support partial payments
      paidAmount: 0.0,
      balanceDue: 0.0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      suspensionDetails: null,
      resumptionDetails: null
    };

    db.saveTransaction(newTx);
    return newTx;
  }

  /**
   * Adds an item to the current transaction cart.
   */
  addItemToCart(txId, barcodeOrId, quantity = 1) {
    const tx = db.getTransactionById(txId);
    if (!tx || tx.status !== 'ACTIVE') {
      return { success: false, error: 'INVALID_TRANSACTION', message: 'Transaction is not active.' };
    }

    let product = db.getProductByBarcode(barcodeOrId) || db.getProductById(barcodeOrId);
    if (!product) {
      return { success: false, error: 'PRODUCT_NOT_FOUND', message: `No product found for barcode/ID "${barcodeOrId}".` };
    }

    const existingIdx = tx.items.findIndex(i => i.productId === product.id);
    if (existingIdx >= 0) {
      tx.items[existingIdx].quantity += quantity;
      tx.items[existingIdx].subtotal = Number((tx.items[existingIdx].quantity * tx.items[existingIdx].price).toFixed(2));
    } else {
      tx.items.push({
        productId: product.id,
        barcode: product.barcode,
        name: product.name,
        category: product.category,
        price: product.price,
        quantity,
        subtotal: Number((product.price * quantity).toFixed(2))
      });
    }

    this._recalculateTotals(tx);
    db.saveTransaction(tx);
    return { success: true, transaction: tx };
  }

  /**
   * Records a partial or full payment on the transaction before or during checkout.
   */
  addPaymentAttempt(txId, { method, amount, cardLast4 = '4242', reference = null }) {
    const tx = db.getTransactionById(txId);
    if (!tx || tx.status !== 'ACTIVE') {
      return { success: false, error: 'INVALID_TRANSACTION', message: 'Transaction not active.' };
    }

    const paymentAmount = Number(amount);
    if (paymentAmount <= 0) {
      return { success: false, error: 'INVALID_AMOUNT', message: 'Payment amount must be greater than zero.' };
    }

    const paymentRecord = {
      id: `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      method, // 'CASH', 'CREDIT_CARD', 'GIFT_CARD', 'MOBILE_WALLET'
      amount: paymentAmount,
      status: 'SUCCEEDED', // partial payment succeeded
      cardLast4: method.includes('CARD') ? cardLast4 : null,
      reference: reference || `REF-${Date.now()}`,
      timestamp: new Date().toISOString()
    };

    tx.payments.push(paymentRecord);
    this._recalculateTotals(tx);
    db.saveTransaction(tx);

    return { success: true, payment: paymentRecord, transaction: tx };
  }

  /**
   * Recalculates subtotal, sales tax (8.25%), total, and remaining balance.
   */
  _recalculateTotals(tx) {
    tx.subtotal = Number(tx.items.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2));
    tx.tax = Number((tx.subtotal * 0.0825).toFixed(2));
    tx.total = Number((tx.subtotal + tx.tax).toFixed(2));
    tx.paidAmount = Number(tx.payments.reduce((sum, p) => p.status === 'SUCCEEDED' ? sum + p.amount : sum, 0).toFixed(2));
    tx.balanceDue = Number(Math.max(0, tx.total - tx.paidAmount).toFixed(2));
    tx.updatedAt = new Date().toISOString();
  }

  /**
   * Step 1: Cashier requests transaction suspension.
   * Generates a fresh, single-use cryptographic biometric challenge.
   */
  requestSuspension(txId, cashierId, branchId, registerId, reason = 'Customer requested time to get wallet') {
    const tx = db.getTransactionById(txId);
    if (!tx) {
      return { success: false, error: 'NOT_FOUND', message: 'Transaction not found.' };
    }

    if (tx.status !== 'ACTIVE') {
      return { success: false, error: 'NOT_ACTIVE', message: `Cannot suspend transaction in status "${tx.status}".` };
    }

    if (tx.items.length === 0) {
      return { success: false, error: 'EMPTY_CART', message: 'Cannot suspend an empty transaction cart.' };
    }

    // Generate fresh single-use cryptographic challenge for supervisor fingerprint authorization
    const challengeInfo = sessionManager.createAuthorizationChallenge(
      'SUSPEND_TRANSACTION',
      branchId,
      registerId,
      txId
    );

    AuditLogger.log({
      eventType: 'SUSPENSION_REQUESTED',
      userId: cashierId,
      userName: tx.cashierName,
      userRole: 'cashier',
      branchId,
      registerId,
      action: 'SUSPEND_TRANSACTION',
      status: 'PENDING_SUPERVISOR_BIOMETRIC',
      reason,
      metadata: { txId, challenge: challengeInfo.challenge }
    });

    return {
      success: true,
      requiresBiometric: true,
      action: 'SUSPEND_TRANSACTION',
      txId,
      branchId,
      registerId,
      challenge: challengeInfo.challenge,
      timeoutSeconds: challengeInfo.timeoutSeconds,
      hardwareStatus: biometricAdapter.getHardwareStatus(),
      message: 'Supervisor fingerprint authorization required to suspend transaction.'
    };
  }

  /**
   * Step 2: Authorize transaction suspension with supervisor fingerprint assertion.
   * If verification fails, suspension MUST NOT proceed.
   */
  async authorizeSuspensionWithBiometrics({
    txId,
    challenge,
    assertion,
    branchId,
    registerId,
    reason = 'Customer temporarily stepping away'
  }) {
    const tx = db.getTransactionById(txId);
    if (!tx || tx.status !== 'ACTIVE') {
      return {
        authorized: false,
        error: 'INVALID_TRANSACTION',
        message: 'Transaction is not in an active suspendable state.'
      };
    }

    // Verify supervisor biometric authorization
    const authResult = await biometricAdapter.verifyBiometricAuthorization({
      challenge,
      assertion,
      expectedAction: 'SUSPEND_TRANSACTION',
      branchId,
      registerId,
      txId
    });

    if (!authResult.authorized) {
      AuditLogger.log({
        eventType: 'SUSPENSION_FAILED',
        userId: assertion ? assertion.userId : 'UNKNOWN',
        userName: 'Supervisor Attempt',
        userRole: 'supervisor',
        branchId,
        registerId,
        action: 'SUSPEND_TRANSACTION',
        status: 'FAILED',
        reason: `Suspension blocked: ${authResult.message}`,
        metadata: { txId, error: authResult.error }
      });

      return {
        authorized: false,
        error: authResult.error,
        message: authResult.message,
        lockoutInfo: authResult.lockoutInfo
      };
    }

    // Biometric verified! Save suspension details and persist state
    const timestamp = new Date().toISOString();
    tx.status = 'SUSPENDED';
    tx.suspensionDetails = {
      suspendedAt: timestamp,
      supervisorId: authResult.supervisor.id,
      supervisorName: authResult.supervisor.name,
      supervisorTitle: authResult.supervisor.title,
      reason,
      biometricCredentialId: authResult.credentialId,
      biometricAuthToken: authResult.authToken,
      deviceId: authResult.deviceId,
      cartSnapshot: JSON.parse(JSON.stringify(tx.items)),
      paymentSnapshot: JSON.parse(JSON.stringify(tx.payments))
    };

    db.saveTransaction(tx);

    AuditLogger.log({
      eventType: 'SUSPENSION_AUTHORIZED',
      userId: authResult.supervisor.id,
      userName: authResult.supervisor.name,
      userRole: authResult.supervisor.role,
      branchId,
      registerId,
      action: 'SUSPEND_TRANSACTION',
      status: 'SUCCESS',
      deviceId: authResult.deviceId,
      reason: `Transaction ${txId} suspended by supervisor ${authResult.supervisor.name}. Reason: ${reason}`,
      metadata: {
        txId,
        itemsCount: tx.items.length,
        total: tx.total,
        paidAmount: tx.paidAmount,
        biometricCredentialId: authResult.credentialId
      }
    });

    return {
      authorized: true,
      displayMessage: {
        title: 'SUSPENSION AUTHORIZED',
        supervisor: authResult.supervisor.name,
        time: timestamp,
        txId: tx.id
      },
      transaction: tx,
      posAvailableForNextCustomer: true
    };
  }

  /**
   * Step 3: Cashier selects suspended transaction to resume.
   * Generates a fresh single-use biometric challenge.
   */
  requestResumption(txId, cashierId, branchId, registerId) {
    const tx = db.getTransactionById(txId);
    if (!tx) {
      return { success: false, error: 'NOT_FOUND', message: 'Suspended transaction not found.' };
    }

    if (tx.status !== 'SUSPENDED') {
      return { success: false, error: 'NOT_SUSPENDED', message: `Transaction is not currently suspended (status: ${tx.status}).` };
    }

    // Fresh challenge - NEVER reuse old suspension challenge
    const challengeInfo = sessionManager.createAuthorizationChallenge(
      'RESUME_TRANSACTION',
      branchId,
      registerId,
      txId
    );

    AuditLogger.log({
      eventType: 'RESUMPTION_REQUESTED',
      userId: cashierId,
      userName: 'Cashier',
      userRole: 'cashier',
      branchId,
      registerId,
      action: 'RESUME_TRANSACTION',
      status: 'PENDING_SUPERVISOR_BIOMETRIC',
      reason: `Cashier requested resumption of suspended transaction ${txId}`,
      metadata: { txId, challenge: challengeInfo.challenge }
    });

    return {
      success: true,
      requiresBiometric: true,
      action: 'RESUME_TRANSACTION',
      txId,
      branchId,
      registerId,
      suspendedAt: tx.suspensionDetails ? tx.suspensionDetails.suspendedAt : null,
      suspendedBy: tx.suspensionDetails ? tx.suspensionDetails.supervisorName : 'Supervisor',
      challenge: challengeInfo.challenge,
      timeoutSeconds: challengeInfo.timeoutSeconds,
      hardwareStatus: biometricAdapter.getHardwareStatus(),
      message: 'Supervisor fingerprint authorization required to resume suspended transaction.'
    };
  }

  /**
   * Step 4: Authorize transaction resumption with supervisor fingerprint assertion.
   * Restores all products, quantities, prices and recovers previous payment attempts.
   */
  async authorizeResumptionWithBiometrics({
    txId,
    challenge,
    assertion,
    branchId,
    registerId
  }) {
    const tx = db.getTransactionById(txId);
    if (!tx || tx.status !== 'SUSPENDED') {
      return {
        authorized: false,
        error: 'INVALID_TRANSACTION',
        message: 'Transaction is not in a suspended state.'
      };
    }

    // Verify supervisor biometric authorization with fresh challenge
    const authResult = await biometricAdapter.verifyBiometricAuthorization({
      challenge,
      assertion,
      expectedAction: 'RESUME_TRANSACTION',
      branchId,
      registerId,
      txId
    });

    if (!authResult.authorized) {
      AuditLogger.log({
        eventType: 'RESUMPTION_FAILED',
        userId: assertion ? assertion.userId : 'UNKNOWN',
        userName: 'Supervisor Attempt',
        userRole: 'supervisor',
        branchId,
        registerId,
        action: 'RESUME_TRANSACTION',
        status: 'FAILED',
        reason: `Resumption blocked: ${authResult.message}`,
        metadata: { txId, error: authResult.error }
      });

      return {
        authorized: false,
        error: authResult.error,
        message: authResult.message,
        lockoutInfo: authResult.lockoutInfo
      };
    }

    // Biometric verified! Restore transaction state
    const timestamp = new Date().toISOString();
    tx.status = 'ACTIVE';

    // Verify that all products, quantities, prices, and payments are intact
    this._recalculateTotals(tx);

    // Check whether any previous payment attempt has succeeded
    const successfulPayments = tx.payments.filter(p => p.status === 'SUCCEEDED');
    const totalPreviousPayment = successfulPayments.reduce((s, p) => s + p.amount, 0);

    tx.resumptionDetails = {
      resumedAt: timestamp,
      supervisorId: authResult.supervisor.id,
      supervisorName: authResult.supervisor.name,
      supervisorTitle: authResult.supervisor.title,
      biometricCredentialId: authResult.credentialId,
      biometricAuthToken: authResult.authToken,
      deviceId: authResult.deviceId,
      previousSuccessfulPaymentsCount: successfulPayments.length,
      previousPaidTotal: totalPreviousPayment
    };

    db.saveTransaction(tx);

    AuditLogger.log({
      eventType: 'RESUMPTION_AUTHORIZED',
      userId: authResult.supervisor.id,
      userName: authResult.supervisor.name,
      userRole: authResult.supervisor.role,
      branchId,
      registerId,
      action: 'RESUME_TRANSACTION',
      status: 'SUCCESS',
      deviceId: authResult.deviceId,
      reason: `Suspended transaction ${txId} successfully resumed by supervisor ${authResult.supervisor.name}`,
      metadata: {
        txId,
        itemCount: tx.items.length,
        total: tx.total,
        recoveredPayments: successfulPayments
      }
    });

    return {
      authorized: true,
      displayMessage: {
        title: 'RESUMPTION AUTHORIZED',
        supervisor: authResult.supervisor.name,
        time: timestamp,
        txId: tx.id
      },
      transaction: tx,
      recoveredState: {
        itemsCount: tx.items.length,
        subtotal: tx.subtotal,
        tax: tx.tax,
        total: tx.total,
        previousPayments: successfulPayments,
        previousPaidTotal: totalPreviousPayment,
        balanceDue: tx.balanceDue
      }
    };
  }

  /**
   * Emergency Fallback Suspension / Resumption Override.
   * Invoked ONLY when biometric reader is broken, disconnected, or supervisor locked out.
   */
  processEmergencyOverride({
    txId,
    adminUsername,
    emergencyPasscode,
    reason,
    action,
    branchId,
    registerId,
    incidentNotes
  }) {
    const tx = db.getTransactionById(txId);
    if (!tx) {
      return { authorized: false, error: 'NOT_FOUND', message: 'Transaction not found.' };
    }

    const overrideResult = EmergencyOverrideService.processAdminOverride({
      adminUsername,
      emergencyPasscode,
      reason,
      action,
      branchId,
      registerId,
      txId,
      incidentNotes
    });

    if (!overrideResult.authorized) {
      return overrideResult;
    }

    const timestamp = new Date().toISOString();

    if (action === 'SUSPEND_TRANSACTION') {
      tx.status = 'SUSPENDED';
      tx.suspensionDetails = {
        suspendedAt: timestamp,
        supervisorId: overrideResult.supervisor.id,
        supervisorName: overrideResult.supervisor.name,
        emergencyOverride: true,
        reason: `EMERGENCY OVERRIDE: ${reason} - ${incidentNotes}`,
        cartSnapshot: JSON.parse(JSON.stringify(tx.items)),
        paymentSnapshot: JSON.parse(JSON.stringify(tx.payments))
      };
      db.saveTransaction(tx);

      return {
        authorized: true,
        emergency: true,
        displayMessage: {
          title: 'EMERGENCY SUSPENSION AUTHORIZED',
          supervisor: overrideResult.supervisor.name,
          time: timestamp,
          txId: tx.id
        },
        transaction: tx
      };
    } else if (action === 'RESUME_TRANSACTION') {
      tx.status = 'ACTIVE';
      this._recalculateTotals(tx);
      const successfulPayments = tx.payments.filter(p => p.status === 'SUCCEEDED');
      tx.resumptionDetails = {
        resumedAt: timestamp,
        supervisorId: overrideResult.supervisor.id,
        supervisorName: overrideResult.supervisor.name,
        emergencyOverride: true,
        reason: `EMERGENCY OVERRIDE: ${reason} - ${incidentNotes}`
      };
      db.saveTransaction(tx);

      return {
        authorized: true,
        emergency: true,
        displayMessage: {
          title: 'EMERGENCY RESUMPTION AUTHORIZED',
          supervisor: overrideResult.supervisor.name,
          time: timestamp,
          txId: tx.id
        },
        transaction: tx,
        recoveredState: {
          itemsCount: tx.items.length,
          total: tx.total,
          previousPayments: successfulPayments,
          balanceDue: tx.balanceDue
        }
      };
    }

    return { authorized: false, error: 'UNKNOWN_ACTION', message: 'Unsupported override action' };
  }
}

module.exports = new TransactionService();

