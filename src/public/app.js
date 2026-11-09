/**
 * Supermarket POS Frontend Client Logic
 * Biometric Supervisor Authorization System
 */

const STATE = {
  activeTab: 'pos',
  currentUser: {
    id: 'user_c01',
    name: 'Dave Miller',
    role: 'cashier',
    branchId: 'BR-001',
    registerId: 'REG-01'
  },
  currentTransaction: null,
  suspendedTransactions: [],
  products: [],
  hardwareStatus: { connected: true },
  activeModalAuth: null, // { action, txId, challenge, expiresAt, countdownInterval }
  countdownTimer: null
};

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  await loadHardwareStatus();
  await loadProducts();
  await loadUsers();
  await startNewTransaction();
  await loadSuspendedTransactions();

  // Periodic hardware health poll every 5 seconds
  setInterval(loadHardwareStatus, 5000);
});

// Tab Navigation
window.switchTab = function(tabName) {
  STATE.activeTab = tabName;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));

  const tabBtn = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.innerText.toLowerCase().includes(tabName));
  if (tabBtn) tabBtn.classList.add('active');

  const panel = document.getElementById(`view${capitalize(tabName)}`);
  if (panel) panel.classList.add('active');

  if (tabName === 'suspended') loadSuspendedTransactions();
  if (tabName === 'settings') { loadUsers(); loadCredentials(); }
  if (tabName === 'audit') loadAuditLogs();
};

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// User Profile Switcher
window.switchUser = async function(userId) {
  const res = await fetch('/api/users');
  const data = await res.json();
  const found = data.users.find(u => u.id === userId);
  if (found) {
    STATE.currentUser = found;
    document.getElementById('currentUserName').innerText = found.name;
    document.getElementById('currentUserRole').innerText = `${found.role.toUpperCase()} (${found.branchId})`;
    const avatar = document.getElementById('userRoleAvatar');
    avatar.innerText = found.role.charAt(0).toUpperCase();
    avatar.className = `user-role-avatar ${found.role}-avatar`;
    showToast(`Switched active terminal user to: ${found.name} (${found.role})`);
  }
};

// Hardware Status Check
async function loadHardwareStatus() {
  try {
    const res = await fetch('/api/biometric/device');
    const data = await res.json();
    STATE.hardwareStatus = data;

    const statusBar = document.getElementById('hwStatusBar');
    const statusText = document.getElementById('hwStatusText');
    const diagBadge = document.getElementById('diagStatusBadge');

    if (data.connected) {
      statusBar.className = 'hw-status-badge hw-connected';
      statusText.innerText = `${data.device.name} (CONNECTED)`;
      if (diagBadge) {
        diagBadge.className = 'badge-success';
        diagBadge.innerText = 'CONNECTED';
      }
    } else {
      statusBar.className = 'hw-status-badge hw-disconnected';
      statusText.innerText = 'BIOMETRIC READER DISCONNECTED';
      if (diagBadge) {
        diagBadge.className = 'badge-danger';
        diagBadge.innerText = 'DISCONNECTED';
      }
    }
  } catch (err) {
    console.error('Failed to load hardware status:', err);
  }
}

// Load Products Catalog
async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    const data = await res.json();
    STATE.products = data.products;

    const container = document.getElementById('quickProductsContainer');
    container.innerHTML = '';
    STATE.products.forEach(p => {
      const tile = document.createElement('div');
      tile.className = 'product-tile';
      tile.onclick = () => window.addItemToCurrentCart(p.barcode);
      tile.innerHTML = `
        <div class="item-name">${p.name}</div>
        <div class="item-meta">
          <span class="item-price">$${p.price.toFixed(2)}</span>
          <span class="item-category">${p.category}</span>
        </div>
      `;
      container.appendChild(tile);
    });
  } catch (err) {
    console.error('Failed to load products:', err);
  }
}

// Start New Active Transaction
async function startNewTransaction() {
  try {
    const res = await fetch('/api/pos/transaction/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cashierId: STATE.currentUser.id,
        branchId: 'BR-001',
        registerId: 'REG-01'
      })
    });
    const data = await res.json();
    STATE.currentTransaction = data.transaction;
    renderCart();
  } catch (err) {
    console.error('Failed to create transaction:', err);
  }
}

// Barcode Scanning / Manual Input
window.handleBarcodeSubmit = function() {
  const input = document.getElementById('barcodeInput');
  const code = input.value.trim();
  if (!code) return;
  window.addItemToCurrentCart(code);
  input.value = '';
};

window.addItemToCurrentCart = async function(barcodeOrId) {
  if (!STATE.currentTransaction) await startNewTransaction();
  const txId = STATE.currentTransaction.id;

  try {
    const res = await fetch(`/api/pos/transaction/${txId}/item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcodeOrId, quantity: 1 })
    });
    const data = await res.json();
    if (data.success) {
      STATE.currentTransaction = data.transaction;
      renderCart();
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast('Failed to add item', 'error');
  }
};

// Render Cart Table & Totals
function renderCart() {
  const tx = STATE.currentTransaction;
  if (!tx) return;

  document.getElementById('cartTxId').innerText = tx.id;
  document.getElementById('cartTxStatusBadge').innerText = tx.status;

  const tbody = document.getElementById('cartTableBody');
  tbody.innerHTML = '';

  if (!tx.items || tx.items.length === 0) {
    tbody.innerHTML = `<tr class="empty-cart-row"><td colspan="5">Cart is empty. Scan products to begin checkout.</td></tr>`;
  } else {
    tx.items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${item.name}</strong><br><small style="color:#64748b">${item.barcode}</small></td>
        <td>$${item.price.toFixed(2)}</td>
        <td>${item.quantity}</td>
        <td><strong>$${item.subtotal.toFixed(2)}</strong></td>
        <td></td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Totals
  document.getElementById('txtSubtotal').innerText = `$${(tx.subtotal || 0).toFixed(2)}`;
  document.getElementById('txtTax').innerText = `$${(tx.tax || 0).toFixed(2)}`;
  document.getElementById('txtGrandTotal').innerText = `$${(tx.total || 0).toFixed(2)}`;

  // Payments summary
  const paySummaryBlock = document.getElementById('paymentsSummaryBlock');
  const payListContainer = document.getElementById('paymentsListContainer');
  const rowPaidTotal = document.getElementById('rowPaidTotal');
  const rowBalanceDue = document.getElementById('rowBalanceDue');

  if (tx.payments && tx.payments.length > 0) {
    paySummaryBlock.style.display = 'block';
    rowPaidTotal.style.display = 'flex';
    rowBalanceDue.style.display = 'flex';
    payListContainer.innerHTML = '';
    tx.payments.forEach(p => {
      const d = document.createElement('div');
      d.innerHTML = `<span>${p.method} ${p.cardLast4 ? `(**** ${p.cardLast4})` : ''}:</span> <strong>$${p.amount.toFixed(2)}</strong>`;
      payListContainer.appendChild(d);
    });
    document.getElementById('txtPaidAmount').innerText = `$${(tx.paidAmount || 0).toFixed(2)}`;
    document.getElementById('txtBalanceDue').innerText = `$${(tx.balanceDue || 0).toFixed(2)}`;
  } else {
    paySummaryBlock.style.display = 'none';
    rowPaidTotal.style.display = 'none';
    rowBalanceDue.style.display = 'none';
  }
}

// Tender Partial or Full Payment
window.tenderPayment = async function(method, amount) {
  if (!STATE.currentTransaction || STATE.currentTransaction.items.length === 0) {
    showToast('Add items to cart before tendering payment', 'warning');
    return;
  }
  const txId = STATE.currentTransaction.id;

  try {
    const res = await fetch(`/api/pos/transaction/${txId}/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, amount, cardLast4: '4242' })
    });
    const data = await res.json();
    if (data.success) {
      STATE.currentTransaction = data.transaction;
      renderCart();
      showToast(`Tendered $${amount.toFixed(2)} via ${method}`);
    } else {
      showToast(data.message, 'error');
    }
  } catch (err) {
    showToast('Payment attempt failed', 'error');
  }
};

// =======================================================================
// WORKFLOW 1: SUSPENDING A TRANSACTION (Requires Supervisor Fingerprint)
// =======================================================================
window.handleRequestSuspension = async function() {
  const tx = STATE.currentTransaction;
  if (!tx || tx.items.length === 0) {
    showToast('Cannot suspend an empty transaction cart', 'warning');
    return;
  }

  try {
    const res = await fetch(`/api/pos/transaction/${tx.id}/suspend/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cashierId: STATE.currentUser.id,
        branchId: 'BR-001',
        registerId: 'REG-01',
        reason: 'Customer requested suspension'
      })
    });

    const data = await res.json();
    if (!data.success) {
      showToast(data.message, 'error');
      return;
    }

    // Open Biometric Authorization Modal
    openBiometricModal({
      action: 'SUSPEND_TRANSACTION',
      txId: tx.id,
      challenge: data.challenge,
      timeoutSeconds: data.timeoutSeconds,
      heading: 'SUSPEND TRANSACTION AUTHORIZATION',
      desc: 'Cashier Dave Miller requested suspension. An authorized supervisor must scan their fingerprint to approve.'
    });
  } catch (err) {
    showToast('Failed to request transaction suspension', 'error');
  }
};

// =======================================================================
// WORKFLOW 2: RESUMING A TRANSACTION (Requires Supervisor Fingerprint)
// =======================================================================
window.handleResumeSuspendedTransaction = async function(txId) {
  try {
    const res = await fetch(`/api/pos/transaction/${txId}/resume/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cashierId: STATE.currentUser.id,
        branchId: 'BR-001',
        registerId: 'REG-01'
      })
    });

    const data = await res.json();
    if (!data.success) {
      showToast(data.message, 'error');
      return;
    }

    // Open Biometric Authorization Modal
    openBiometricModal({
      action: 'RESUME_TRANSACTION',
      txId: txId,
      challenge: data.challenge,
      timeoutSeconds: data.timeoutSeconds,
      heading: 'RESUME TRANSACTION AUTHORIZATION',
      desc: `Resuming held order ${txId}. An authorized supervisor must authenticate with their fingerprint to restore.`
    });
  } catch (err) {
    showToast('Failed to request resumption', 'error');
  }
};

// Biometric Modal Window Management
function openBiometricModal({ action, txId, challenge, timeoutSeconds, heading, desc }) {
  STATE.activeModalAuth = {
    action,
    txId,
    challenge,
    expiresAt: Date.now() + (timeoutSeconds * 1000)
  };

  document.getElementById('bioModalTitle').innerText = action === 'SUSPEND_TRANSACTION' ? 'Supervisor Authorization — Suspend Order' : 'Supervisor Authorization — Resume Order';
  document.getElementById('bioActionHeading').innerText = heading;
  document.getElementById('bioActionDesc').innerText = desc;
  document.getElementById('bioModalTxId').innerText = txId;
  document.getElementById('bioModalChallengePreview').innerText = challenge.substring(0, 16) + '...';
  
  const resultBanner = document.getElementById('bioResultBanner');
  resultBanner.style.display = 'none';
  resultBanner.className = 'bio-result-banner';

  document.getElementById('scannerInstructionText').innerText = 'Place supervisor finger firmly on the reader sensor';
  document.getElementById('biometricModal').style.display = 'flex';

  // Start countdown timer
  clearInterval(STATE.countdownTimer);
  updateCountdown();
  STATE.countdownTimer = setInterval(updateCountdown, 1000);
}

function updateCountdown() {
  if (!STATE.activeModalAuth) return;
  const remaining = Math.max(0, Math.floor((STATE.activeModalAuth.expiresAt - Date.now()) / 1000));
  document.getElementById('bioModalCountdown').innerText = `${remaining}s`;

  if (remaining <= 0) {
    clearInterval(STATE.countdownTimer);
    showModalResult(false, 'Biometric authorization timed out. Please generate a fresh request.');
  }
}

window.closeBiometricModal = function() {
  clearInterval(STATE.countdownTimer);
  STATE.activeModalAuth = null;
  document.getElementById('biometricModal').style.display = 'none';
};

// Fingerprint Capture & Verification Trigger
window.submitSimulatedFingerprint = async function(userId, errorSimulation = null) {
  if (!STATE.activeModalAuth) return;
  const { action, txId, challenge } = STATE.activeModalAuth;

  document.getElementById('scannerInstructionText').innerText = 'Scanning & cryptographically signing challenge...';

  try {
    // 1. Hardware Reader captures finger scan & signs challenge
    const scanRes = await fetch('/api/biometric/scan-simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge,
        userId,
        errorSimulation
      })
    });

    const scanData = await scanRes.json();
    if (!scanData.success) {
      showModalResult(false, `Biometric Scan Rejected: ${scanData.message}`);
      return;
    }

    // 2. Submit cryptographic assertion to backend for supervisor authorization
    const endpoint = action === 'SUSPEND_TRANSACTION'
      ? `/api/pos/transaction/${txId}/suspend/authorize`
      : `/api/pos/transaction/${txId}/resume/authorize`;

    const authRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge,
        assertion: scanData,
        branchId: 'BR-001',
        registerId: 'REG-01',
        reason: action === 'SUSPEND_TRANSACTION' ? 'Customer stepping away' : 'Customer returned to checkout'
      })
    });

    const authData = await authRes.json();

    if (authData.authorized) {
      // SUCCESS!
      const disp = authData.displayMessage;
      showModalResult(true, `
        <strong>${disp.title}</strong><br>
        Supervisor: <strong>${disp.supervisor}</strong><br>
        Time: ${new Date(disp.time).toLocaleTimeString()} (${disp.time})
      `);

      setTimeout(async () => {
        window.closeBiometricModal();
        if (action === 'SUSPEND_TRANSACTION') {
          showToast(`Transaction ${txId} successfully suspended! POS ready for next customer.`, 'success');
          // Clear current register and start fresh transaction for next customer
          await startNewTransaction();
          await loadSuspendedTransactions();
        } else if (action === 'RESUME_TRANSACTION') {
          showToast(`Transaction ${txId} restored! Checkout resumed.`, 'success');
          STATE.currentTransaction = authData.transaction;
          renderCart();
          window.switchTab('pos');
          await loadSuspendedTransactions();
        }
      }, 2500);

    } else {
      // REJECTED!
      showModalResult(false, `
        <strong>AUTHORIZATION DENIED</strong><br>
        ${authData.message}
        ${authData.lockoutInfo && authData.lockoutInfo.locked ? '<br><span style="color:red">Account has been locked! Use Emergency Fallback Override.</span>' : ''}
      `);
    }
  } catch (err) {
    showModalResult(false, `System communication error: ${err.message}`);
  }
};

function showModalResult(isSuccess, htmlContent) {
  const banner = document.getElementById('bioResultBanner');
  banner.style.display = 'block';
  banner.className = isSuccess ? 'bio-result-banner bio-result-success' : 'bio-result-banner bio-result-danger';
  banner.innerHTML = htmlContent;
}

// Load Suspended Orders List
window.loadSuspendedTransactions = async function() {
  try {
    const res = await fetch('/api/pos/suspended?branchId=BR-001');
    const data = await res.json();
    STATE.suspendedTransactions = data.suspendedTransactions;

    const count = STATE.suspendedTransactions.length;
    document.getElementById('suspendedCountBadge').innerText = count;
    document.getElementById('btnSuspendedCount').innerText = count;

    const tbody = document.getElementById('suspendedTableBody');
    tbody.innerHTML = '';

    if (count === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center">No suspended orders pending resumption.</td></tr>`;
      return;
    }

    STATE.suspendedTransactions.forEach(tx => {
      const tr = document.createElement('tr');
      const suspendedAt = tx.suspensionDetails ? new Date(tx.suspensionDetails.suspendedAt).toLocaleTimeString() : 'N/A';
      const supervisor = tx.suspensionDetails ? tx.suspensionDetails.supervisorName : 'Supervisor';
      tr.innerHTML = `
        <td><strong>${tx.id}</strong></td>
        <td>${suspendedAt}</td>
        <td><span class="badge-supervisor">${supervisor}</span></td>
        <td>${tx.items.length} items</td>
        <td><strong>$${tx.total.toFixed(2)}</strong></td>
        <td>$${tx.paidAmount.toFixed(2)}</td>
        <td><strong style="color:red">$${tx.balanceDue.toFixed(2)}</strong></td>
        <td>
          <button class="btn btn-sm btn-primary" onclick="window.handleResumeSuspendedTransaction('${tx.id}')">
            👆 Resume Order
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Failed to load suspended transactions:', err);
  }
};

window.handleOpenSuspendedModal = function() {
  window.switchTab('suspended');
};

// Emergency Override Modal
window.openEmergencyOverrideModal = function() {
  document.getElementById('emergencyModal').style.display = 'flex';
};

window.closeEmergencyModal = function() {
  document.getElementById('emergencyModal').style.display = 'none';
};

window.handleEmergencySubmit = async function(e) {
  e.preventDefault();
  if (!STATE.activeModalAuth) {
    showToast('No active authorization request', 'error');
    return;
  }

  const { action, txId } = STATE.activeModalAuth;
  const adminUsername = document.getElementById('emergencyAdminUsername').value.trim();
  const emergencyPasscode = document.getElementById('emergencyPasscode').value;
  const reason = document.getElementById('emergencyReasonSelect').value;
  const incidentNotes = document.getElementById('emergencyNotes').value.trim();

  try {
    const res = await fetch('/api/pos/emergency-override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        txId,
        action,
        adminUsername,
        emergencyPasscode,
        reason,
        branchId: 'BR-001',
        registerId: 'REG-01',
        incidentNotes
      })
    });

    const data = await res.json();
    if (data.authorized) {
      window.closeEmergencyModal();
      window.closeBiometricModal();
      showToast(`Emergency Override Authorized by ${data.displayMessage.supervisor}`, 'warning');

      if (action === 'SUSPEND_TRANSACTION') {
        await startNewTransaction();
      } else {
        STATE.currentTransaction = data.transaction;
        renderCart();
        window.switchTab('pos');
      }
      await loadSuspendedTransactions();
    } else {
      const errBox = document.getElementById('emergencyErrorAlert');
      errBox.style.display = 'block';
      errBox.innerText = `Emergency Override Denied: ${data.message}`;
    }
  } catch (err) {
    showToast('Emergency override request failed', 'error');
  }
};

// Supervisor Biometric Enrollment & Revocation
async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    const select = document.getElementById('enrollSupervisorSelect');
    if (select) {
      select.innerHTML = '';
      const supervisors = data.users.filter(u => u.role === 'supervisor' || u.role === 'administrator');
      supervisors.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.innerText = `${s.name} (${s.title} - ${s.branchId})`;
        select.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

async function loadCredentials() {
  try {
    const res = await fetch('/api/biometric/credentials');
    const data = await res.json();
    const tbody = document.getElementById('credentialsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    data.credentials.forEach(c => {
      const tr = document.createElement('tr');
      const isRevoked = c.status === 'REVOKED';
      tr.innerHTML = `
        <td><code>${c.id}</code></td>
        <td><strong>${c.userName}</strong></td>
        <td>${c.deviceType} (${c.deviceSerial})</td>
        <td>${new Date(c.enrolledAt).toLocaleDateString()}</td>
        <td><span class="${isRevoked ? 'badge-danger' : 'badge-success'}">${c.status}</span></td>
        <td>
          ${!isRevoked ? `<button class="btn btn-sm btn-danger" onclick="window.revokeCredential('${c.id}')">Revoke</button>` : '<span style="color:#94a3b8">Revoked</span>'}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Failed to load credentials:', err);
  }
}

window.handleEnrollment = async function(e) {
  e.preventDefault();
  const supervisorId = document.getElementById('enrollSupervisorSelect').value;
  const deviceType = document.getElementById('enrollDeviceTypeSelect').value;
  const branchId = document.getElementById('enrollBranchId').value;

  try {
    const res = await fetch('/api/biometric/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supervisorId, branchId, deviceType })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Biometric credential ${data.credential.id} successfully enrolled for ${data.credential.userName}!`, 'success');
      loadCredentials();
    } else {
      showToast(`Enrollment Failed: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast('Enrollment request failed', 'error');
  }
};

window.revokeCredential = async function(credentialId) {
  if (!confirm(`Are you sure you want to revoke biometric credential ${credentialId}?`)) return;

  try {
    const res = await fetch('/api/biometric/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credentialId,
        revokedBy: STATE.currentUser.name,
        reason: 'Administrative revocation'
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Credential ${credentialId} revoked!`, 'warning');
      loadCredentials();
    } else {
      showToast(data.message, 'error');
    }
  } catch (err) {
    showToast('Revocation failed', 'error');
  }
};

// Audit Trail Explorer
window.loadAuditLogs = async function() {
  const filter = document.getElementById('auditEventFilter').value;
  let url = '/api/audit/logs?limit=50';
  if (filter) url += `&eventType=${filter}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const tbody = document.getElementById('auditTableBody');
    tbody.innerHTML = '';

    data.logs.forEach(l => {
      const tr = document.createElement('tr');
      const isSuccess = l.status === 'SUCCESS';
      tr.innerHTML = `
        <td><small>${new Date(l.timestamp).toLocaleTimeString()}</small></td>
        <td><code>${l.eventType}</code></td>
        <td><strong>${l.userName}</strong> (${l.userRole})</td>
        <td>${l.branchId} / ${l.registerId}</td>
        <td><span class="${isSuccess ? 'badge-success' : 'badge-danger'}">${l.status}</span></td>
        <td><small>${l.deviceId}</small></td>
        <td>${l.reason}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Failed to load audit logs:', err);
  }
};

// Diagnostics & Hardware Simulation
window.simulateHardwareState = async function(state) {
  try {
    const res = await fetch('/api/biometric/device/simulate-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, reason: 'Operator diagnostic testing' })
    });
    const data = await res.json();
    await loadHardwareStatus();
    document.getElementById('diagFeedback').innerText = data.message;
    showToast(data.message, state === 'CONNECTED' ? 'success' : 'warning');
  } catch (err) {
    showToast('Failed to change hardware state', 'error');
  }
};

// Complete Transaction
window.handleCompleteTransaction = async function() {
  const tx = STATE.currentTransaction;
  if (!tx || tx.items.length === 0) {
    showToast('Cart is empty', 'warning');
    return;
  }
  showToast(`Transaction ${tx.id} completed! Receipt printed.`, 'success');
  await startNewTransaction();
};

window.handleCancelTransaction = async function() {
  if (confirm('Cancel and clear current cart?')) {
    await startNewTransaction();
  }
};

// Toast Notifications
function showToast(message, type = 'info') {
  const t = document.getElementById('toastNotification');
  t.innerText = message;
  t.style.display = 'block';
  t.style.backgroundColor = type === 'error' ? '#dc2626' : (type === 'success' ? '#16a34a' : (type === 'warning' ? '#d97706' : '#1e293b'));
  setTimeout(() => {
    t.style.display = 'none';
  }, 4000);
}

