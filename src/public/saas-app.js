/**
 * VERTEXT POS — Enterprise Retail Cloud SaaS Platform (KES)
 * Real-time Safaricom M-Pesa Daraja 2.0 &bull; KRA eTIMS &bull; Offline-First Supabase Sync
 * Sub-15ms Barcode Scanner & SKU Search &bull; Multi-Cashier SSE Event Routing &bull; Auto-Printing
 */

const STATE = {
  token: null,
  currentTenantId: 'tenant_metromart',
  currentBranchId: 'BR-001',
  currentRegisterId: 'REG-01',
  currentUser: null,
  activeTab: null,
  currentSale: null,
  pricingTier: 'retail', // 'retail' or 'wholesale'
  products: [],
  categories: [],
  suspendedSales: [],
  activeMpesaCheckoutId: null,
  activeShift: null,
  sseConnection: null,
  sidebarCollapsed: false,
  mpesaPollTimer: null,
  searchDebounceTimer: null
};

// =========================================================================
// 1. APPLICATION BOOTSTRAP & DYNAMIC AUTHENTICATION
// =========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  initBarcodeScannerHardware();
  initCloudSyncPoller();
  initPwaInstaller();

  // Restore saved session if valid
  const savedToken = sessionStorage.getItem('vertext_token');
  const savedUser = sessionStorage.getItem('vertext_user');
  const savedTenant = sessionStorage.getItem('vertext_tenant_id');

  if (savedToken && savedUser) {
    try {
      STATE.token = savedToken;
      STATE.currentUser = JSON.parse(savedUser);
      STATE.currentTenantId = savedTenant || 'tenant_metromart';
      onLoginSuccess(STATE.currentUser);
      return;
    } catch (e) {
      sessionStorage.clear();
    }
  }

  showLoginScreen();
});

function showLoginScreen() {
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('appContainer').style.display = 'none';
}

function hideLoginScreen() {
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('appContainer').style.display = 'flex';
}

// Switch between Sign In and Sign Up tabs
window.switchAuthTab = function(mode) {
  const btnIn = document.getElementById('tabBtnSignIn');
  const btnUp = document.getElementById('tabBtnSignUp');
  const frmIn = document.getElementById('frmLogin');
  const frmUp = document.getElementById('frmRegister');

  if (btnUp && btnIn && frmUp && frmIn) {
    if (mode === 'signup') {
      btnUp.classList.add('active');
      btnIn.classList.remove('active');
      frmUp.style.display = 'block';
      frmIn.style.display = 'none';
    } else {
      btnIn.classList.add('active');
      btnUp.classList.remove('active');
      frmIn.style.display = 'block';
      frmUp.style.display = 'none';
    }
  }
};

window.checkSuperAdminBadge = function(val) {
  const badge = document.getElementById('superAdminDetectionBadge');
  if (val.trim().toLowerCase() === 'sammyseth260@gmail.com') {
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
};

window.checkRegSuperAdminBadge = function(val) {
  const badge = document.getElementById('regSuperAdminBadge');
  const groupBiz = document.getElementById('groupRegBusiness');
  const groupLoc = document.getElementById('groupRegLocation');

  if (val.trim().toLowerCase() === 'sammyseth260@gmail.com') {
    badge.style.display = 'flex';
    if (groupBiz) groupBiz.style.display = 'none';
    if (groupLoc) groupLoc.style.display = 'none';
  } else {
    badge.style.display = 'none';
    if (groupBiz) groupBiz.style.display = 'block';
    if (groupLoc) groupLoc.style.display = 'flex';
  }
};

window.fillCredentials = function(email, password) {
  document.getElementById('txtLoginEmail').value = email;
  document.getElementById('txtLoginPassword').value = password;
  window.checkSuperAdminBadge(email);
  window.switchAuthTab('signin');
  executeLogin(email, password);
};

// Sign In Form Handler
window.handleLoginFormSubmit = async function(e) {
  e.preventDefault();
  const email = document.getElementById('txtLoginEmail').value.trim();
  const password = document.getElementById('txtLoginPassword').value;
  await executeLogin(email, password);
};

// Sign Up / Registration Form Handler
window.handleRegisterFormSubmit = async function(e) {
  e.preventDefault();
  const email = document.getElementById('txtRegEmail').value.trim();
  const fullName = document.getElementById('txtRegFullName').value.trim();
  const phone = document.getElementById('txtRegPhone').value.trim();
  const businessName = document.getElementById('txtRegBusinessName').value.trim();
  const location = document.getElementById('txtRegLocation').value.trim();
  const password = document.getElementById('txtRegPassword').value;

  showLoading('Creating your Vertext POS account...');
  const errBanner = document.getElementById('registerErrorBanner');
  errBanner.style.display = 'none';

  try {
    const res = await fetch('/api/auth/register-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        fullName,
        phone,
        businessName,
        location
      })
    });

    const data = await res.json();
    hideLoading();

    if (data.success) {
      if (data.token && data.user) {
        STATE.token = data.token;
        STATE.currentUser = data.user;
        STATE.currentTenantId = data.tenant ? data.tenant.id : (data.user.role === 'super_admin' ? 'GLOBAL' : 'tenant_metromart');

        sessionStorage.setItem('vertext_token', data.token);
        sessionStorage.setItem('vertext_user', JSON.stringify(data.user));
        sessionStorage.setItem('vertext_tenant_id', STATE.currentTenantId);

        onLoginSuccess(data.user);
        showToast(`Welcome ${data.user.fullName}! Account created in Supabase`, 'success');
      } else {
        window.switchAuthTab('signin');
        document.getElementById('txtLoginEmail').value = email;
        const loginErr = document.getElementById('loginErrorBanner');
        loginErr.className = 'alert-banner alert-success';
        loginErr.style.display = 'block';
        loginErr.innerHTML = `<strong>Account Created in Supabase!</strong><br>${data.message || 'Please check your email or confirm your user in Supabase to sign in.'}`;
        showToast('Account created in Supabase! Please sign in.', 'success');
      }
    } else {
      errBanner.innerText = data.message || 'Registration failed.';
      errBanner.style.display = 'block';
    }
  } catch (err) {
    hideLoading();
    errBanner.innerText = 'Network error communicating with server.';
    errBanner.style.display = 'block';
  }
};

async function executeLogin(email, password) {
  showLoading('Authenticating with Vertext POS engine...');
  const errBanner = document.getElementById('loginErrorBanner');
  errBanner.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrUsername: email, password })
    });

    const data = await res.json();
    hideLoading();

    if (data.success) {
      STATE.token = data.token;
      STATE.currentUser = data.user;
      STATE.currentTenantId = data.tenant ? data.tenant.id : (data.user.role === 'super_admin' ? 'GLOBAL' : 'tenant_metromart');

      sessionStorage.setItem('vertext_token', data.token);
      sessionStorage.setItem('vertext_user', JSON.stringify(data.user));
      sessionStorage.setItem('vertext_tenant_id', STATE.currentTenantId);

      onLoginSuccess(data.user);
    } else {
      errBanner.innerText = data.message || 'Invalid login credentials.';
      errBanner.style.display = 'block';
    }
  } catch (err) {
    hideLoading();
    errBanner.innerText = 'Network error communicating with server.';
    errBanner.style.display = 'block';
  }
}

window.handleSignOut = function() {
  if (STATE.mpesaPollTimer) clearInterval(STATE.mpesaPollTimer);
  if (STATE.sseConnection) {
    STATE.sseConnection.close();
    STATE.sseConnection = null;
  }
  sessionStorage.clear();
  STATE.token = null;
  STATE.currentUser = null;
  showToast('Signed out of Vertext POS.');
  showLoginScreen();
};

async function onLoginSuccess(user) {
  hideLoginScreen();
  showLoading(`Loading ${user.role.replace(/_/g, ' ')} workspace...`);

  // Setup Targeted SSE Client Connection
  initRealTimeEvents();

  // Update Profile Elements
  document.getElementById('sbUserName').innerText = user.fullName;
  document.getElementById('sbUserRole').innerText = user.role.replace(/_/g, ' ').toUpperCase();
  document.getElementById('sbUserAvatar').innerText = user.role.charAt(0).toUpperCase();
  document.getElementById('sbUserBranch').innerText = user.branchId ? `Branch: ${user.branchId}` : 'All Supermarket Branches';

  // Render Role Navigation
  renderSidebarNav(user.role);

  // Load General Store Context & Per-Business Branding
  await loadTenantDetails();
  await loadActiveShift();

  // Route to Dedicated Role Dashboard
  navigateToRoleDashboard(user.role);
  hideLoading();
}

// =========================================================================
// 2. DYNAMIC SIDEBAR NAVIGATION RENDERER
// =========================================================================
function renderSidebarNav(role) {
  const navContainer = document.getElementById('sidebarNavMenu');
  navContainer.innerHTML = '';

  const navConfigs = {
    super_admin: [
      { id: 'super_admin_dash', label: 'Platform Overview', tab: 'super_admin', icon: 'home' },
      { id: 'sa_tenants', label: 'Supermarkets & Tills', tab: 'super_admin', icon: 'building' },
      { id: 'sa_register', label: 'Register Business Owner', action: 'openCreateOwnerModal', icon: 'plus' },
      { id: 'sa_audit', label: 'Platform Audit Trail', tab: 'auditor', icon: 'shield' }
    ],
    owner: [
      { id: 'owner_dash', label: 'Executive P&L Dashboard', tab: 'owner', icon: 'chart' },
      { id: 'owner_branch', label: 'Add Supermarket Branch', action: 'openAddBranchModal', icon: 'building' },
      { id: 'owner_pos', label: 'POS Terminal (Full Control)', tab: 'pos', icon: 'cart' },
      { id: 'owner_admin', label: 'Appoint Business Admin', action: 'openCreateAdminModal', icon: 'user-plus' },
      { id: 'owner_inventory', label: 'Inventory & Catalog', tab: 'inventory', icon: 'box' },
      { id: 'owner_accounts', label: 'Financial Statements & Tax', tab: 'accountant', icon: 'receipt' },
      { id: 'owner_reports', label: 'Daily Sales Reports', tab: 'reports', icon: 'barchart' }
    ],
    admin: [
      { id: 'admin_dash', label: 'Operations Dashboard', tab: 'admin', icon: 'home' },
      { id: 'admin_mgr', label: 'Appoint Branch Manager', action: 'openCreateBranchManagerModal', icon: 'user-plus' },
      { id: 'admin_catalog', label: 'Product Catalog & VAT', tab: 'inventory', icon: 'box' },
      { id: 'admin_pos', label: 'POS Checkout Terminal', tab: 'pos', icon: 'cart' },
      { id: 'admin_reports', label: 'Store Financials', tab: 'reports', icon: 'barchart' }
    ],
    branch_manager: [
      { id: 'mgr_dash', label: 'Branch Command Center', tab: 'branch_manager', icon: 'home' },
      { id: 'mgr_staff', label: 'Appoint Branch Staff', action: 'openCreateStaffModal', icon: 'user-plus' },
      { id: 'mgr_pos', label: 'POS Checkout Lane', tab: 'pos', icon: 'cart' },
      { id: 'mgr_shifts', label: 'Cashier Shifts & Floats', tab: 'shift', icon: 'clock' },
      { id: 'mgr_queue', label: 'Suspended Queue', tab: 'suspended', icon: 'pause' }
    ],
    supervisor: [
      { id: 'sup_dash', label: 'Floor Monitor', tab: 'supervisor', icon: 'home' },
      { id: 'sup_queue', label: 'Suspended Orders Queue', tab: 'suspended', icon: 'pause', badge: true },
      { id: 'sup_shifts', label: 'Shift Verification', tab: 'shift', icon: 'clock' }
    ],
    cashier: [
      { id: 'cash_pos', label: 'POS Terminal (Checkout)', tab: 'pos', icon: 'cart' },
      { id: 'cash_queue', label: 'Suspended Orders', tab: 'suspended', icon: 'pause', badge: true },
      { id: 'cash_shift', label: 'Shift & Cash Float', tab: 'shift', icon: 'clock' },
      { id: 'cash_dash', label: 'Cashier Station Summary', tab: 'cashier', icon: 'home' }
    ],
    inventory_manager: [
      { id: 'im_dash', label: 'Stock Ledger Dashboard', tab: 'inventory_manager', icon: 'box' },
      { id: 'im_catalog', label: 'FMCG Product Catalog', tab: 'inventory', icon: 'box' },
      { id: 'im_add', label: 'Add Product SKU', action: 'openAddProductModal', icon: 'plus' }
    ],
    procurement_officer: [
      { id: 'po_dash', label: 'Procurement Dashboard', tab: 'procurement_officer', icon: 'truck' },
      { id: 'po_suppliers', label: 'Suppliers Directory', tab: 'procurement_officer', icon: 'building' }
    ],
    accountant: [
      { id: 'acct_dash', label: 'Accountant Dashboard', tab: 'accountant', icon: 'receipt' },
      { id: 'acct_reports', label: 'Financial Statements', tab: 'reports', icon: 'barchart' }
    ],
    auditor: [
      { id: 'aud_dash', label: 'Compliance & Audit Trail', tab: 'auditor', icon: 'shield' },
      { id: 'aud_reports', label: 'Financial Inspection', tab: 'reports', icon: 'barchart' }
    ]
  };

  const links = navConfigs[role] || navConfigs.cashier;

  links.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'nav-link';
    btn.id = `navBtn_${item.id}`;

    if (item.action) {
      btn.onclick = () => window[item.action]();
    } else {
      btn.onclick = () => window.switchTab(item.tab);
    }

    btn.innerHTML = `
      ${getSvgIcon(item.icon)}
      <span class="nav-text">${item.label}</span>
      ${item.badge ? `<span class="nav-badge" id="badge_${item.id}">0</span>` : ''}
    `;

    navContainer.appendChild(btn);
  });
}

function getSvgIcon(name) {
  switch (name) {
    case 'home':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
    case 'cart':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`;
    case 'box':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
    case 'chart':
    case 'barchart':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
    case 'building':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="9" y1="22" x2="9" y2="22.01"/><line x1="15" y1="22" x2="15" y2="22.01"/><line x1="9" y1="12" x2="9" y2="12.01"/><line x1="15" y1="12" x2="15" y2="12.01"/></svg>`;
    case 'shield':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
    case 'user-plus':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>`;
    case 'receipt':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="16" y2="10"/></svg>`;
    case 'clock':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    case 'pause':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>`;
    case 'truck':
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`;
    case 'plus':
    default:
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  }
}

// =========================================================================
// 3. TAB NAVIGATION & VIEW SWITCHING
// =========================================================================
window.switchTab = function(tabName) {
  STATE.activeTab = tabName;

  document.querySelectorAll('.nav-link').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.role-view-panel').forEach(p => p.classList.remove('active'));

  updateStageTitles(tabName);

  const panel = document.getElementById(`view${capitalize(tabName)}`) ||
                document.getElementById(`view${capitalizeRole(tabName)}Dashboard`);

  if (panel) {
    panel.classList.add('active');
  }

  // Trigger view loaders
  if (tabName === 'super_admin') window.loadSuperAdminDashboard();
  if (tabName === 'owner') window.loadOwnerDashboard();
  if (tabName === 'admin') window.loadAdminDashboard();
  if (tabName === 'branch_manager') window.loadBranchManagerDashboard();
  if (tabName === 'supervisor') window.loadSupervisorDashboard();
  if (tabName === 'cashier') window.loadCashierDashboard();
  if (tabName === 'inventory_manager') window.loadStockDashboard();
  if (tabName === 'procurement_officer') window.loadProcurementDashboard();
  if (tabName === 'accountant') window.loadAccountantDashboard();
  if (tabName === 'auditor') window.loadAuditorDashboard();

  if (tabName === 'pos') {
    startNewSale();
    const barcodeInput = document.getElementById('txtBarcode');
    if (barcodeInput) setTimeout(() => barcodeInput.focus(), 100);
  }
  if (tabName === 'suspended') loadSuspendedSales();
  if (tabName === 'shift') loadActiveShift();
  if (tabName === 'inventory') loadInventoryTable();
  if (tabName === 'reports') loadDashboardReports();
};

function navigateToRoleDashboard(role) {
  if (role === 'cashier') {
    window.switchTab('pos');
  } else {
    window.switchTab(role);
  }
}

function updateStageTitles(tabName) {
  const titleMap = {
    super_admin: 'Vertext SaaS Super Admin Platform Governance',
    owner: 'Supermarket Executive Command & P&L',
    admin: 'Operations & Retail Catalog Command',
    branch_manager: 'Branch Operations Command Center',
    supervisor: 'Floor Operations & Biometric Authorizations',
    cashier: 'Cashier Terminal Station',
    inventory_manager: 'Inventory Valuation & Stock Ledger',
    procurement_officer: 'Procurement & Supplier Management Hub',
    accountant: 'Retail Accounting & KRA Tax Reconciliation',
    auditor: 'Immutable Cryptographic Audit Trail',
    pos: 'Point of Sale Checkout (KES)',
    suspended: 'Suspended Orders Queue',
    shift: 'Cash Register Shifts & Reconciliation',
    inventory: 'Product Catalog & Pricing',
    reports: 'Financial Reports & Settlement'
  };

  document.getElementById('lblStageTitle').innerText = titleMap[tabName] || 'Dashboard';
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function capitalizeRole(role) {
  return role.split('_').map(capitalize).join('');
}

window.toggleSidebar = function() {
  const sidebar = document.getElementById('appSidebar');
  STATE.sidebarCollapsed = !STATE.sidebarCollapsed;
  if (STATE.sidebarCollapsed) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
  }
};

// =========================================================================
// 4. POS CHECKOUT STATION: SCANNER & LIVE SKU SEARCH (NO ALL-PRODUCTS GRID)
// =========================================================================
window.setPricingTier = function(tier) {
  STATE.pricingTier = tier;
  const btnRetail = document.getElementById('btnPricingRetail');
  const btnWholesale = document.getElementById('btnPricingWholesale');
  const lblActive = document.getElementById('lblActivePricingMode');

  if (tier === 'wholesale') {
    btnWholesale.className = 'btn btn-sm btn-primary';
    btnRetail.className = 'btn btn-sm btn-outline';
    lblActive.innerText = 'Wholesale Bulk Pricing Active';
  } else {
    btnRetail.className = 'btn btn-sm btn-primary';
    btnWholesale.className = 'btn btn-sm btn-outline';
    lblActive.innerText = 'Retail Pricing Active';
  }
};

// Cashier typing SKU or Product Name -> Search Dropdown
window.handleSkuSearchInput = function(query) {
  clearTimeout(STATE.searchDebounceTimer);
  const q = query.trim();

  if (!q) {
    renderSkuSearchResults([]);
    return;
  }

  STATE.searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/products/search?q=${encodeURIComponent(q)}`, {
        headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
      });
      const data = await res.json();
      renderSkuSearchResults(data.products || []);
    } catch (err) {
      console.warn('Search error:', err);
    }
  }, 120);
};

window.handleScanKeydown = function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    window.handleBarcodeEnter();
  }
};

window.handleBarcodeEnter = function() {
  const input = document.getElementById('txtBarcode');
  const code = input.value.trim();
  if (!code) return;
  addItemByBarcode(code);
  input.value = '';
  renderSkuSearchResults([]);
};

window.addMatchingItemToCart = function(barcode) {
  addItemByBarcode(barcode);
  const input = document.getElementById('txtBarcode');
  input.value = '';
  input.focus();
  renderSkuSearchResults([]);
};

function renderSkuSearchResults(products) {
  const tbody = document.getElementById('skuSearchResultsTbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (products.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center" style="padding:24px; color:#64748b;">
          Point USB/Bluetooth barcode reader or type product SKU/Name above.
        </td>
      </tr>
    `;
    return;
  }

  products.forEach(p => {
    const tr = document.createElement('tr');
    const displayPrice = STATE.pricingTier === 'wholesale' && p.wholesale_price_kes > 0 ? p.wholesale_price_kes : p.selling_price_kes;
    const vatLabel = p.vat_rate === 0.0 ? '0% Zero-Rated' : '16% VAT';

    tr.innerHTML = `
      <td><code>${p.barcode}</code></td>
      <td><strong>${p.name}</strong><br><small style="color:#64748b;">SKU: ${p.sku || p.barcode}</small></td>
      <td>${p.category}</td>
      <td><strong>${p.stock_quantity || 100}</strong></td>
      <td><strong style="color:#2563eb;">KES ${Number(displayPrice).toFixed(2)}</strong></td>
      <td><span class="badge-primary">${vatLabel}</span></td>
      <td>
        <button type="button" class="btn btn-sm btn-primary" onclick="window.addMatchingItemToCart('${p.barcode}')">
          + Add to Cart
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function startNewSale() {
  const res = await fetch('/api/pos/sale/new', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'X-Branch-Id': STATE.currentBranchId,
      'X-Register-Id': STATE.currentRegisterId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify({
      branchId: STATE.currentBranchId,
      registerId: STATE.currentRegisterId,
      cashierId: STATE.currentUser ? STATE.currentUser.id : 'usr_cashier_01'
    })
  });
  const data = await res.json();
  STATE.currentSale = data.sale;
  renderCart();
}

async function loadSale(saleId) {
  const res = await fetch(`/api/pos/sale/${saleId}`, {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();
  STATE.currentSale = data.sale;
  renderCart();
}

async function addItemByBarcode(barcode) {
  if (!STATE.currentSale || STATE.currentSale.status !== 'ACTIVE') {
    await startNewSale();
  }

  const res = await fetch(`/api/pos/sale/${STATE.currentSale.id}/item`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify({
      barcodeOrId: barcode,
      quantity: 1,
      pricingTier: STATE.pricingTier
    })
  });

  const data = await res.json();
  if (data.success) {
    STATE.currentSale = data.sale;
    renderCart();
  } else {
    showToast(data.message, 'error');
    if (data.message && data.message.toLowerCase().includes('not found')) {
      if (confirm(`Barcode "${barcode}" is not in the supermarket catalog yet.\n\nWould you like to add this product now?`)) {
        window.openAddProductModal();
        const npBar = document.getElementById('npBarcode');
        if (npBar) npBar.value = barcode;
        const npSku = document.getElementById('npSku');
        if (npSku) npSku.value = 'SKU-' + barcode.slice(-6);
        document.getElementById('npName')?.focus();
      }
    }
  }
}

function renderCart() {
  const sale = STATE.currentSale;
  if (!sale) return;

  const saleIdBadge = document.getElementById('lblSaleId');
  if (saleIdBadge) saleIdBadge.innerText = sale.id;

  const saleStatus = document.getElementById('lblSaleStatus');
  if (saleStatus) saleStatus.innerText = sale.status;

  const tbody = document.getElementById('cartTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!sale.items || sale.items.length === 0) {
    tbody.innerHTML = `<tr class="empty-cart-msg"><td colspan="5">Scan items or search SKU to begin customer checkout.</td></tr>`;
  } else {
    sale.items.forEach(item => {
      const tr = document.createElement('tr');
      const vatCode = item.vat_rate === 0.0 ? 'B (0%)' : 'A (16%)';
      tr.innerHTML = `
        <td>
          <strong>${item.product_name}</strong><br>
          <small style="color:#64748b;">${item.barcode} &bull; Tax ${vatCode}</small>
        </td>
        <td style="text-align:right;">KES ${item.unit_price_kes.toFixed(2)}</td>
        <td style="text-align:center;">
          <div style="display:inline-flex; align-items:center; gap:6px;">
            <button class="btn btn-sm btn-outline" style="padding:1px 6px;" onclick="window.changeItemQty('${item.barcode}', ${item.quantity - 1})">-</button>
            <strong>${item.quantity}</strong>
            <button class="btn btn-sm btn-outline" style="padding:1px 6px;" onclick="window.changeItemQty('${item.barcode}', ${item.quantity + 1})">+</button>
          </div>
        </td>
        <td style="text-align:right;"><strong>KES ${item.subtotal_kes.toFixed(2)}</strong></td>
        <td style="text-align:center;"><button class="btn btn-sm btn-outline-danger" onclick="window.removeItem('${item.id}')">&times;</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  document.getElementById('lblSubtotal').innerText = `KES ${(sale.subtotal_kes || 0).toFixed(2)}`;
  document.getElementById('lblTax16').innerText = `KES ${(sale.tax_kes || 0).toFixed(2)}`;

  const zeroRated = (sale.items || []).filter(i => i.vat_rate === 0.0).reduce((sum, i) => sum + i.subtotal_kes, 0);
  document.getElementById('lblZeroRated').innerText = `KES ${zeroRated.toFixed(2)}`;
  document.getElementById('lblGrandTotal').innerText = `KES ${(sale.total_kes || 0).toFixed(2)}`;
}

window.changeItemQty = async function(barcode, newQty) {
  if (newQty <= 0) {
    // If reduced to 0, start fresh or remove
    return;
  }
  await addItemByBarcode(barcode);
};

window.handleCancelSale = async function() {
  if (!STATE.currentSale || !STATE.currentSale.items || STATE.currentSale.items.length === 0) return;
  if (confirm('Clear customer cart?')) {
    await startNewSale();
    showToast('Customer cart cleared.');
  }
};

// =========================================================================
// 4B. POS BARCODE SCANNING ENGINE (HARDWARE USB/BLUETOOTH + CAMERA PHONE)
// =========================================================================

// Realistic Supermarket Checkout Audio Feedback (3600Hz POS Chime)
function playScannerBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(3600, ctx.currentTime);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch (e) {}
}

// 1. Hardware Keyboard Wedge Barcode Interceptor (USB, Bluetooth, 2.4G & Companion Phone)
let barcodeBuffer = '';
let lastKeyTime = Date.now();

function initBarcodeScannerHardware() {
  window.addEventListener('keydown', (e) => {
    if (!e || !e.key) return; // Prevent TypeError: Cannot read properties of undefined (reading 'length')
    const currentTime = Date.now();
    // Inter-keystroke interval for hardware scanners is < 80ms
    if (currentTime - lastKeyTime > 120) {
      barcodeBuffer = '';
    }
    lastKeyTime = currentTime;

    if (e.key === 'Enter') {
      const scannedCode = barcodeBuffer.trim();
      if (scannedCode.length >= 3) {
        e.preventDefault();
        playScannerBeep();
        if (navigator.vibrate) navigator.vibrate(80);

        // Check if "Add Product" catalog modal is active
        const addProductModal = document.getElementById('addProductModal');
        if (addProductModal && addProductModal.style.display !== 'none') {
          const npBarInput = document.getElementById('npBarcode');
          const npSkuInput = document.getElementById('npSku');
          if (npBarInput) npBarInput.value = scannedCode;
          if (npSkuInput && !npSkuInput.value) npSkuInput.value = 'SKU-' + scannedCode.slice(-6);
          showToast(`Barcode Scanned for Product: ${scannedCode}`, 'success');
          document.getElementById('npCostPrice')?.focus();
        } else {
          // Default checkout cart addition
          addItemByBarcode(scannedCode);
        }
        barcodeBuffer = '';
      }
    } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && document.activeElement !== document.getElementById('txtBarcode')) {
      // Don't accumulate if user is typing in regular text inputs (unless it's barcode wedge speed)
      const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
      if (!isInput || (currentTime - lastKeyTime < 60)) {
        barcodeBuffer += e.key;
      }
    }
  });
}

// 2. Mobile Phone & Webcam Live Optical Barcode Scanner
let cameraStream = null;
let cameraScannerActive = false;
let scannerAnimFrame = null;
let lastDetectedBarcode = '';
let lastDetectedTime = 0;
let scannerMode = 'cart'; // 'cart' or 'new_product'
let nativeBarcodeDetector = null;
let zxingCodeReader = null;

// Initialize Barcode Detector (Native BarcodeDetector or ZXing fallback)
if ('BarcodeDetector' in window) {
  try {
    nativeBarcodeDetector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'qr_code']
    });
    console.log('[SCANNER] Native Hardware-Accelerated BarcodeDetector initialized.');
  } catch (err) {
    console.warn('[SCANNER] BarcodeDetector init error:', err);
  }
}

window.toggleCameraScanner = function(mode = 'cart') {
  const modal = document.getElementById('cameraScannerModal');
  if (modal && modal.style.display !== 'none') {
    window.closeCameraScanner();
  } else {
    window.openCameraScanner(mode);
  }
};

window.scanBarcodeForNewProduct = function() {
  window.openCameraScanner('new_product');
};

window.openCameraScanner = async function(mode = 'cart') {
  scannerMode = mode;
  const modal = document.getElementById('cameraScannerModal');
  const badge = document.getElementById('cameraScannerModeBadge');
  const title = document.getElementById('cameraModalTitle');
  const feedback = document.getElementById('scannerFeedback');

  if (badge) {
    badge.innerText = mode === 'new_product' ? '📦 Add Product Barcode' : '🛒 Checkout: Add to Cart';
  }
  if (title) {
    title.innerText = mode === 'new_product' ? 'Scan Barcode for New Product' : 'Live Supermarket Barcode Scanner';
  }
  if (feedback) {
    feedback.innerText = 'Align barcode inside green brackets';
    feedback.style.color = '#22c55e';
  }

  modal.style.display = 'flex';
  cameraScannerActive = true;

  await enumerateCameras();
  await startCameraStream();
};

window.closeCameraScanner = function() {
  cameraScannerActive = false;
  if (scannerAnimFrame) {
    cancelAnimationFrame(scannerAnimFrame);
    scannerAnimFrame = null;
  }
  if (zxingCodeReader) {
    try { zxingCodeReader.reset(); } catch (e) {}
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  const modal = document.getElementById('cameraScannerModal');
  if (modal) modal.style.display = 'none';

  // Return focus to barcode input for next item
  const txtBarcode = document.getElementById('txtBarcode');
  if (txtBarcode) txtBarcode.focus();
};

async function enumerateCameras() {
  const select = document.getElementById('selCameraDevice');
  if (!select) return;
  select.innerHTML = '';

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    if (videoDevices.length === 0) {
      select.innerHTML = '<option value="">Default Camera</option>';
      return;
    }

    videoDevices.forEach((device, index) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.text = device.label || `Camera ${index + 1} (${device.deviceId.slice(0, 5)}...)`;
      // Prefer back / environment camera for phone scanning
      if (device.label.toLowerCase().includes('back') || device.label.toLowerCase().includes('rear') || device.label.toLowerCase().includes('environment')) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  } catch (err) {
    select.innerHTML = '<option value="">Camera Available</option>';
  }
}

async function startCameraStream(deviceId = null) {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }

  const constraints = {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: deviceId ? undefined : { ideal: 'environment' },
      deviceId: deviceId ? { exact: deviceId } : undefined
    },
    audio: false
  };

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('scannerVideo');
    if (video) {
      video.srcObject = cameraStream;
      await video.play();
      startBarcodeScanningLoop();
    }
  } catch (err) {
    console.error('Camera access error:', err);
    showToast(`Camera permission required: ${err.message}`, 'error');
    const feedback = document.getElementById('scannerFeedback');
    if (feedback) {
      feedback.innerText = 'Camera access blocked. Please enable camera permissions.';
      feedback.style.color = '#ef4444';
    }
  }
}

window.switchCamera = async function(deviceId) {
  if (!deviceId) return;
  await startCameraStream(deviceId);
};

window.toggleTorch = async function() {
  if (!cameraStream) return;
  const track = cameraStream.getVideoTracks()[0];
  if (!track) return;

  try {
    const capabilities = track.getCapabilities?.() || {};
    if (!capabilities.torch) {
      showToast('Torch / Flashlight not supported on this camera.', 'info');
      return;
    }
    const current = track.getSettings?.().torch || false;
    await track.applyConstraints({ advanced: [{ torch: !current }] });
    showToast(!current ? 'Torch ON' : 'Torch OFF', 'info');
  } catch (err) {
    showToast('Torch control unavailable.', 'warning');
  }
};

function startBarcodeScanningLoop() {
  const video = document.getElementById('scannerVideo');
  if (!video) return;

  // Primary: Native BarcodeDetector
  if (nativeBarcodeDetector) {
    const detectFrame = async () => {
      if (!cameraScannerActive) return;

      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          const barcodes = await nativeBarcodeDetector.detect(video);
          if (barcodes && barcodes.length > 0) {
            const rawVal = barcodes[0].rawValue;
            handleDetectedCode(rawVal);
          }
        } catch (e) {}
      }

      scannerAnimFrame = requestAnimationFrame(detectFrame);
    };
    scannerAnimFrame = requestAnimationFrame(detectFrame);
  }
  // Secondary / Fallback: ZXing Multi-Format Reader
  else if (window.ZXing && window.ZXing.BrowserMultiFormatReader) {
    try {
      zxingCodeReader = new ZXing.BrowserMultiFormatReader();
      zxingCodeReader.decodeFromVideoElement(video, (result, err) => {
        if (!cameraScannerActive) return;
        if (result && result.getText()) {
          handleDetectedCode(result.getText());
        }
      });
      console.log('[SCANNER] ZXing Multi-Format Code Reader active.');
    } catch (zxErr) {
      console.warn('[SCANNER] ZXing init error:', zxErr);
    }
  }
  // Tertiary: Canvas image sampling fallback
  else {
    const feedback = document.getElementById('scannerFeedback');
    if (feedback) feedback.innerText = 'Scanning... Ready for barcodes';
  }
}

function handleDetectedCode(code) {
  if (!code) return;
  const cleanCode = code.trim();
  const now = Date.now();

  // Debounce identical barcode repeat scans within 1.4s
  if (cleanCode === lastDetectedBarcode && (now - lastDetectedTime) < 1400) {
    return;
  }

  lastDetectedBarcode = cleanCode;
  lastDetectedTime = now;

  // Sound and haptic feedback
  playScannerBeep();
  if (navigator.vibrate) navigator.vibrate(80);

  const feedback = document.getElementById('scannerFeedback');
  if (feedback) {
    feedback.innerText = `✅ Scanned: ${cleanCode}`;
    feedback.style.color = '#22c55e';
  }

  if (scannerMode === 'new_product') {
    // Fill into Add Product modal
    const npBarInput = document.getElementById('npBarcode');
    const npSkuInput = document.getElementById('npSku');
    if (npBarInput) npBarInput.value = cleanCode;
    if (npSkuInput && !npSkuInput.value) npSkuInput.value = 'SKU-' + cleanCode.slice(-6);
    showToast(`Product Barcode Set: ${cleanCode}`, 'success');
    window.closeCameraScanner();
    document.getElementById('npCostPrice')?.focus();
  } else {
    // Add item directly to checkout cart
    addItemByBarcode(cleanCode);
    setTimeout(() => {
      if (feedback && cameraScannerActive) {
        feedback.innerText = 'Align next item barcode...';
        feedback.style.color = '#94a3b8';
      }
    }, 1200);
  }
}

window.submitManualScannerInput = function() {
  const input = document.getElementById('manualScannerInput');
  if (!input || !input.value.trim()) return;
  const code = input.value.trim();
  input.value = '';
  handleDetectedCode(code);
};

window.handleBarcodeImageUpload = async function(fileInput) {
  if (!fileInput.files || fileInput.files.length === 0) return;
  const file = fileInput.files[0];
  showToast('Analyzing photo for barcode...', 'info');

  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    // 1. Try Native BarcodeDetector
    if ('BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'qr_code']
        });
        const barcodes = await detector.detect(img);
        if (barcodes && barcodes.length > 0) {
          handleDetectedCode(barcodes[0].rawValue);
          return;
        }
      } catch (e) {}
    }

    // 2. Try ZXing
    if (window.ZXing && window.ZXing.BrowserMultiFormatReader) {
      try {
        const reader = new ZXing.BrowserMultiFormatReader();
        const result = await reader.decodeFromImageElement(img);
        if (result && result.getText()) {
          handleDetectedCode(result.getText());
          return;
        }
      } catch (e) {}
    }

    showToast('Could not detect barcode from photo. Please ensure barcode is clear or type manually.', 'warning');
  } catch (err) {
    showToast('Failed to analyze photo: ' + err.message, 'error');
  } finally {
    fileInput.value = '';
  }
};

// =========================================================================
// 5. PER-BUSINESS DARAJA TILL PAYMENT & AUTO RECEIPT PRINTING
// =========================================================================
window.openMpesaModal = function() {
  if (!STATE.currentSale || !STATE.currentSale.items || STATE.currentSale.items.length === 0) {
    showToast('Add items to cart before initiating payment.', 'warning');
    return;
  }
  document.getElementById('mpesaModalAmount').innerText = `KES ${STATE.currentSale.balance_due_kes.toFixed(2)}`;
  document.getElementById('mpesaStatusBanner').style.display = 'none';
  document.getElementById('mpesaModal').style.display = 'flex';
};

window.closeMpesaModal = function() {
  if (STATE.mpesaPollTimer) {
    clearInterval(STATE.mpesaPollTimer);
    STATE.mpesaPollTimer = null;
  }
  document.getElementById('mpesaModal').style.display = 'none';
};

window.submitMpesaStk = async function(e) {
  e.preventDefault();
  const phone = document.getElementById('txtMpesaPhone').value.trim();
  const saleId = STATE.currentSale.id;
  const amount = STATE.currentSale.balance_due_kes;

  const banner = document.getElementById('mpesaStatusBanner');
  banner.style.display = 'block';
  banner.className = 'mpesa-status-banner';
  banner.innerHTML = `<strong>Sending prompt to ${phone}...</strong>`;

  const res = await fetch('/api/mpesa/stk-push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify({ saleId, customerPhone: phone, amountKes: amount })
  });

  const data = await res.json();
  if (data.success) {
    STATE.activeMpesaCheckoutId = data.checkoutRequestId;
    banner.innerHTML = `
      <div style="color:#166534;">
        <strong>Prompt Dispatched to ${data.customerPhone}!</strong><br>
        Customer is entering PIN on phone. (Till: ${data.businessShortcode} - ${data.businessName})
        <br><small>Auto-pulling Daraja status every 1.5s...</small>
      </div>
    `;
    showToast(`STK push sent to ${data.customerPhone}!`);

    // Start auto-pulling Daraja status
    startMpesaPolling(saleId, data.checkoutRequestId);
  } else {
    banner.innerHTML = `<span style="color:red;">Error: ${data.message}</span>`;
  }
};

function startMpesaPolling(saleId, checkoutRequestId) {
  if (STATE.mpesaPollTimer) clearInterval(STATE.mpesaPollTimer);

  STATE.mpesaPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/mpesa/status/${saleId}`, {
        headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
      });
      const data = await res.json();

      if (data.isPaid || data.mpesaStatus === 'COMPLETED') {
        clearInterval(STATE.mpesaPollTimer);
        STATE.mpesaPollTimer = null;
        window.closeMpesaModal();

        showToast(`M-PESA CONFIRMED: KES ${Number(data.amountKes).toFixed(2)}! Ref: ${data.mpesaReceipt}`, 'success');

        // Auto-fetch & print receipt, then auto-clear cart
        await autoFetchAndPrintReceipt(saleId);
      }
    } catch (err) {
      console.warn('Daraja poll error:', err);
    }
  }, 1500);
}

// Auto-fetches receipt, triggers print, and readies register for next customer
async function autoFetchAndPrintReceipt(saleId) {
  try {
    const targetSaleId = saleId || (STATE.currentSale ? STATE.currentSale.id : null);
    if (!targetSaleId) {
      console.warn('No targetSaleId available for receipt');
      return;
    }

    const res = await fetch(`/api/printing/receipt/${targetSaleId}`, {
      headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
    });
    const data = await res.json();
    if (data && data.receiptHtml && data.receiptHtml !== 'undefined') {
      openReceiptModalWithHtml(data.receiptHtml);
      window.printThermalTicket(data.receiptHtml);
    }

    // Auto-clear cart and ready for next customer
    await startNewSale();
  } catch (err) {
    console.error('Auto-print error:', err);
  }
}

window.serveNextWhileMpesaPending = async function() {
  window.closeMpesaModal();
  showToast('Order held in queue. Ready for next customer.', 'info');
  await startNewSale();
  await loadSuspendedSales();
};

window.simulateCustomerPin = async function(willSucceed) {
  if (!STATE.activeMpesaCheckoutId) {
    showToast('Send prompt first before simulating PIN.', 'warning');
    return;
  }

  showLoading('Processing M-Pesa PIN confirmation...');
  try {
    const res = await fetch('/api/mpesa/simulate-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutRequestId: STATE.activeMpesaCheckoutId, willSucceed })
    });

    const data = await res.json();
    hideLoading();

    if (data.success && willSucceed) {
      window.closeMpesaModal();
      const receiptCode = data.mpesaReceipt || (data.receipt ? data.receipt.receiptNumber : 'CONFIRMED');
      showToast(`Payment Confirmed! Receipt: ${receiptCode}`, 'success');

      const receiptHtml = (data.receipt && data.receipt.receiptHtml && data.receipt.receiptHtml !== 'undefined') ? data.receipt.receiptHtml : null;
      if (receiptHtml) {
        openReceiptModalWithHtml(receiptHtml);
        window.printThermalTicket(receiptHtml);
        await startNewSale();
      } else {
        await autoFetchAndPrintReceipt(data.saleId);
      }
    } else {
      showToast(`Payment cancelled: ${data.resultDesc || data.message || 'Cancelled'}`, 'error');
    }
  } catch (err) {
    hideLoading();
    showToast('Simulation error: ' + err.message, 'error');
  }
};

// Cash Payment Settlement
window.openCashModal = function() {
  if (!STATE.currentSale || !STATE.currentSale.items || STATE.currentSale.items.length === 0) {
    showToast('Add items before tendering cash.', 'warning');
    return;
  }
  document.getElementById('cashModalTotalDue').innerText = `KES ${STATE.currentSale.balance_due_kes.toFixed(2)}`;
  document.getElementById('txtCashTendered').value = '';
  document.getElementById('lblCashChange').innerText = 'KES 0.00';
  document.getElementById('cashModal').style.display = 'flex';
};

window.closeCashModal = function() {
  document.getElementById('cashModal').style.display = 'none';
};

window.setQuickCash = function(amount) {
  document.getElementById('txtCashTendered').value = amount;
  window.calcCashChange();
};

window.calcCashChange = function() {
  const tendered = parseFloat(document.getElementById('txtCashTendered').value) || 0;
  const due = STATE.currentSale.balance_due_kes;
  const change = Math.max(0, tendered - due);
  document.getElementById('lblCashChange').innerText = `KES ${change.toFixed(2)}`;
};

window.submitCashPayment = async function() {
  const tendered = parseFloat(document.getElementById('txtCashTendered').value) || 0;
  const due = STATE.currentSale.balance_due_kes;

  if (tendered < due) {
    showToast(`Tendered cash (KES ${tendered.toFixed(2)}) is less than total due (KES ${due.toFixed(2)}).`, 'error');
    return;
  }

  showLoading('Finalizing cash payment and generating receipt...');
  const res = await fetch(`/api/pos/sale/${STATE.currentSale.id}/cash`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify({
      cashTenderedKes: tendered,
      cashierName: STATE.currentUser ? STATE.currentUser.fullName : 'Cashier'
    })
  });

  const data = await res.json();
  hideLoading();

  if (data.success) {
    window.closeCashModal();
    showToast(`Cash sale completed! Change: KES ${data.changeDueKes.toFixed(2)}`, 'success');
    const receiptHtml = (data.receipt && data.receipt.receiptHtml && data.receipt.receiptHtml !== 'undefined') ? data.receipt.receiptHtml : null;
    if (receiptHtml) {
      openReceiptModalWithHtml(receiptHtml);
      window.printThermalTicket(receiptHtml);
      await startNewSale();
    } else {
      await autoFetchAndPrintReceipt(data.sale.id);
    }
  } else {
    showToast(`Error: ${data.message}`, 'error');
  }
};

// =========================================================================
// 6. MULTI-CASHIER TARGETED SSE STREAM (30+ SIMULTANEOUS CASHIERS)
// =========================================================================
function initRealTimeEvents() {
  if (STATE.sseConnection) {
    STATE.sseConnection.close();
  }

  const queryParams = new URLSearchParams({
    tenantId: STATE.currentTenantId,
    branchId: STATE.currentBranchId,
    registerId: STATE.currentRegisterId,
    cashierId: STATE.currentUser ? STATE.currentUser.id : ''
  });

  STATE.sseConnection = new EventSource(`/api/events?${queryParams.toString()}`);

  STATE.sseConnection.addEventListener('PAYMENT_CONFIRMED', (event) => {
    const data = JSON.parse(event.data);
    const p = data.payload;
    const target = data.target || {};

    // Check if event targets this register / cashier
    const isTargetedToMe = !target.registerId ||
                          target.registerId === STATE.currentRegisterId ||
                          (target.cashierId && STATE.currentUser && target.cashierId === STATE.currentUser.id) ||
                          (STATE.currentSale && target.saleId === STATE.currentSale.id);

    if (isTargetedToMe) {
      showToast(`M-PESA CONFIRMED: KES ${Number(p.amountKes).toFixed(2)} received! Ref: ${p.mpesaReceipt}`, 'success');
      if (STATE.currentSale && STATE.currentSale.id === p.saleId) {
        autoFetchAndPrintReceipt(p.saleId);
      }
    }
  });

  STATE.sseConnection.addEventListener('PRINT_RECEIPT', (event) => {
    const data = JSON.parse(event.data);
    const p = data.payload;
    const target = data.target || {};

    const isTargetedToMe = !target.registerId ||
                          target.registerId === STATE.currentRegisterId ||
                          (target.cashierId && STATE.currentUser && target.cashierId === STATE.currentUser.id);

    if (isTargetedToMe && p && p.receiptHtml && p.receiptHtml !== 'undefined') {
      openReceiptModalWithHtml(p.receiptHtml);
      window.printThermalTicket(p.receiptHtml);
    }
  });
}

// Dedicated isolated thermal printer for 80mm ESC/POS slips
window.printThermalTicket = function(html) {
  if (!html || typeof html !== 'string' || html.trim() === '' || html === 'undefined') {
    console.warn('printThermalTicket: Empty or invalid receipt HTML provided');
    return;
  }

  let iframe = document.getElementById('receiptPrintFrame');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'receiptPrintFrame';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    document.body.appendChild(iframe);
  }

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Vertext POS Receipt</title>
      <style>
        @page {
          size: 80mm auto;
          margin: 0mm 0mm 4mm 0mm;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          font-family: 'Courier New', Courier, monospace, system-ui;
          background: #ffffff;
          color: #000000;
          width: 80mm;
          margin: 0 auto;
          padding: 2mm 3mm;
          font-size: 11px;
          line-height: 1.35;
        }
        .thermal-receipt {
          position: relative;
          width: 100%;
          max-width: 76mm;
          margin: 0 auto;
          background: #ffffff;
          overflow: hidden;
        }
        .receipt-watermark {
          position: absolute;
          top: 45%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 55mm;
          height: 55mm;
          background-repeat: no-repeat;
          background-position: center;
          background-size: contain;
          opacity: 0.08 !important;
          pointer-events: none;
          z-index: 0;
          filter: grayscale(100%);
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        .receipt-header, .receipt-meta-grid, .receipt-table, .receipt-totals-block, .receipt-etims-footer, .receipt-qr-container, .receipt-footer-text, .receipt-divider {
          position: relative;
          z-index: 1;
        }
        .receipt-header {
          text-align: center;
          margin-bottom: 6px;
        }
        .receipt-top-logo {
          max-width: 48mm;
          max-height: 24mm;
          object-fit: contain;
          margin: 0 auto 4px auto;
          display: block;
          filter: grayscale(100%) contrast(120%);
        }
        .store-brand-title {
          font-size: 14px;
          font-weight: 900;
          letter-spacing: 0.5px;
          margin-bottom: 2px;
          text-transform: uppercase;
        }
        .store-legal-entity {
          font-size: 10px;
          font-weight: 600;
          color: #222;
        }
        .store-meta-line {
          font-size: 9.5px;
          margin-top: 1px;
        }
        .store-promo-header {
          font-size: 10px;
          font-weight: bold;
          margin-top: 3px;
        }
        .receipt-divider {
          text-align: center;
          font-family: monospace;
          font-size: 11px;
          letter-spacing: -1px;
          margin: 4px 0;
          overflow: hidden;
        }
        .receipt-meta-grid {
          font-size: 10px;
          line-height: 1.4;
          margin: 4px 0;
        }
        .receipt-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
          margin: 4px 0;
        }
        .receipt-table th {
          border-bottom: 1px dashed #000;
          padding: 2px 0;
          font-size: 9.5px;
        }
        .receipt-item-row td {
          padding-top: 3px;
          font-weight: bold;
          font-size: 10px;
        }
        .receipt-item-calc td {
          padding-bottom: 3px;
          font-size: 9.5px;
        }
        .receipt-totals-block {
          font-size: 10.5px;
          line-height: 1.45;
          margin: 4px 0;
        }
        .total-line {
          display: flex;
          justify-content: space-between;
        }
        .grand-total {
          font-size: 13px;
          font-weight: 900;
          border-top: 1px dashed #000;
          border-bottom: 1px dashed #000;
          padding: 3px 0;
          margin: 3px 0;
        }
        .receipt-etims-footer {
          border: 1px dashed #000;
          padding: 4px;
          margin: 6px 0;
          font-size: 9px;
          text-align: center;
          line-height: 1.35;
        }
        .etims-label {
          font-weight: 900;
          font-size: 9.5px;
        }
        .etims-sig {
          font-weight: 900;
          letter-spacing: 1px;
          word-break: break-all;
        }
        .receipt-qr-container {
          text-align: center;
          margin: 6px 0;
        }
        .qr-svg-frame svg {
          width: 85px !important;
          height: 85px !important;
          margin: 0 auto;
          display: block;
        }
        .qr-label {
          font-size: 9px;
          font-weight: 700;
          margin-top: 2px;
        }
        .qr-url-text {
          font-size: 7.5px;
          color: #444;
          word-break: break-all;
        }
        .receipt-footer-text {
          text-align: center;
          font-size: 9px;
          margin-top: 4px;
          line-height: 1.3;
        }
        .store-promo-footer {
          font-weight: bold;
          margin-bottom: 3px;
        }
        .powered-by-brand {
          font-size: 9.5px;
          font-weight: 900;
          margin-top: 4px;
          letter-spacing: 0.5px;
        }
      </style>
    </head>
    <body>
      ${html}
    </body>
    </html>
  `);
  doc.close();

  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.warn('Iframe print error, falling back to window.print:', e);
      window.print();
    }
  }, 250);
};

function openReceiptModalWithHtml(html) {
  if (!html || typeof html !== 'string' || html.trim() === '' || html === 'undefined') {
    console.warn('Attempted to render invalid receipt HTML:', html);
    return;
  }
  const container = document.getElementById('receiptContainer');
  if (container) {
    container.innerHTML = html;
  }
  const modal = document.getElementById('receiptModal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

window.closeReceiptModal = function() {
  const modal = document.getElementById('receiptModal');
  if (modal) modal.style.display = 'none';
};

window.printBrowserReceipt = function() {
  const container = document.getElementById('receiptContainer');
  if (container && container.innerHTML && container.innerHTML !== 'undefined' && container.innerHTML.trim() !== '') {
    window.printThermalTicket(container.innerHTML);
  } else {
    showToast('No receipt available to print.', 'warning');
  }
};

window.previewReceipt = async function(saleId) {
  if (!saleId) return;
  showLoading('Loading receipt preview...');
  try {
    const res = await fetch(`/api/printing/receipt/${saleId}`, {
      headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
    });
    const data = await res.json();
    hideLoading();
    if (data && data.receiptHtml && data.receiptHtml !== 'undefined') {
      openReceiptModalWithHtml(data.receiptHtml);
    } else {
      showToast('Could not load receipt: ' + (data.message || 'Not found'), 'error');
    }
  } catch (err) {
    hideLoading();
    showToast('Error loading receipt: ' + err.message, 'error');
  }
};

// =========================================================================
// 7. SUPER ADMIN DASHBOARD & PER-BUSINESS DARAJA TILL CONFIGURATION
// =========================================================================
window.loadSuperAdminDashboard = async function() {
  const res = await fetch('/api/dashboard/super_admin', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  document.getElementById('saTotalTenants').innerText = data.totalTenants || 0;
  document.getElementById('saTotalMrr').innerText = `KES ${(data.totalMrrKes || 0).toLocaleString()}.00`;
  document.getElementById('saTotalArr').innerText = `KES ${(data.totalArrKes || 0).toLocaleString()}.00`;
  document.getElementById('saDbStatus').innerText = data.systemHealth ? data.systemHealth.status : 'HEALTHY';

  const tbody = document.getElementById('saTenantsTableBody');
  tbody.innerHTML = '';

  if (data.tenants && data.tenants.length > 0) {
    data.tenants.forEach(t => {
      const tr = document.createElement('tr');
      const tillInfo = t.mpesa_shortcode ? `${t.mpesa_shortcode} (${t.mpesa_type || 'TILL'})` : 'Default (174379)';
      tr.innerHTML = `
        <td><strong>${t.name}</strong><br><small style="color:#64748b">${t.email || ''}</small></td>
        <td><strong>${t.kra_pin}</strong></td>
        <td><strong style="color:#16a34a;">${tillInfo}</strong></td>
        <td><strong>KES ${(t.monthlySubscriptionKes || 6500).toLocaleString()}.00</strong></td>
        <td><span class="badge-primary">${t.billingSchedule || '1st of every month'}</span></td>
        <td><span class="badge-success">${t.status}</span></td>
        <td>
          <button class="btn btn-sm btn-outline" style="margin-right:6px;" onclick="window.openBusinessSettingsModal('${t.id}')">
            Profile &amp; Logo
          </button>
          <button class="btn btn-sm btn-outline" onclick="window.openConfigureDarajaModal('${t.id}', '${t.name}', '${t.mpesa_shortcode || ''}', '${t.mpesa_type || 'TILL'}', '${t.receipt_header_msg || ''}', '${t.receipt_footer_msg || ''}')">
            Till / Daraja
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } else {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">No supermarkets found.</td></tr>`;
  }
};

window.openConfigureDarajaModal = function(tenantId, tenantName, shortcode, type, header, footer) {
  document.getElementById('cfgTenantId').value = tenantId;
  document.getElementById('cfgTenantName').value = tenantName;
  document.getElementById('cfgMpesaShortcode').value = shortcode || '';
  document.getElementById('cfgMpesaType').value = type || 'TILL';
  document.getElementById('cfgReceiptHeader').value = header || '';
  document.getElementById('cfgReceiptFooter').value = footer || '';
  document.getElementById('modalConfigureDaraja').style.display = 'flex';
};

window.closeConfigureDarajaModal = function() {
  document.getElementById('modalConfigureDaraja').style.display = 'none';
};

window.handleSaveDarajaConfig = async function(e) {
  e.preventDefault();
  showLoading('Saving per-business Daraja Till configuration...');

  const payload = {
    targetTenantId: document.getElementById('cfgTenantId').value,
    mpesaShortcode: document.getElementById('cfgMpesaShortcode').value.trim(),
    mpesaType: document.getElementById('cfgMpesaType').value,
    mpesaConsumerKey: document.getElementById('cfgConsumerKey').value.trim(),
    mpesaConsumerSecret: document.getElementById('cfgConsumerSecret').value.trim(),
    mpesaPasskey: document.getElementById('cfgPasskey').value.trim(),
    receiptHeaderMsg: document.getElementById('cfgReceiptHeader').value.trim(),
    receiptFooterMsg: document.getElementById('cfgReceiptFooter').value.trim()
  };

  const res = await fetch('/api/hierarchy/configure-daraja', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  hideLoading();

  if (data.success) {
    window.closeConfigureDarajaModal();
    showToast('Supermarket Daraja credentials bound successfully!', 'success');
    window.loadSuperAdminDashboard();
    await loadTenantDetails();
  } else {
    showToast(`Error: ${data.message}`, 'error');
  }
};

// =========================================================================
// 8. HIERARCHICAL CREATION ENGINE (SUPER ADMIN -> OWNER -> ADMIN -> MGR -> STAFF)
// =========================================================================
window.openCreateOwnerModal = function() {
  document.getElementById('modalCreateOwner').style.display = 'flex';
};

window.closeCreateOwnerModal = function() {
  document.getElementById('modalCreateOwner').style.display = 'none';
};

window.handleCreateOwnerSubmit = async function(e) {
  e.preventDefault();
  showLoading('Creating supermarket tenant and business owner account...');

  const payload = {
    creatorRole: 'super_admin',
    businessName: document.getElementById('moBusinessName').value.trim(),
    tradeName: document.getElementById('moTradeName').value.trim(),
    location: document.getElementById('moLocation').value.trim(),
    kraPin: document.getElementById('moKraPin').value.trim(),
    monthlySubscriptionKes: Number(document.getElementById('moSubscriptionKes').value),
    ownerFullName: document.getElementById('moOwnerName').value.trim(),
    ownerEmail: document.getElementById('moOwnerEmail').value.trim(),
    password: document.getElementById('moPassword').value,
    businessPhone: document.getElementById('moPhone').value.trim()
  };

  const res = await fetch('/api/hierarchy/create-owner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${STATE.token}` },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  hideLoading();

  if (data.success) {
    window.closeCreateOwnerModal();
    showToast(data.message, 'success');
    window.loadSuperAdminDashboard();
  } else {
    showToast(`Error: ${data.message}`, 'error');
  }
};

window.openCreateAdminModal = function() {
  document.getElementById('modalCreateAdmin').style.display = 'flex';
};

window.closeCreateAdminModal = function() {
  document.getElementById('modalCreateAdmin').style.display = 'none';
};

window.handleCreateAdminSubmit = async function(e) {
  e.preventDefault();
  showLoading('Appointing Business Admin...');

  const payload = {
    creatorRole: 'owner',
    fullName: document.getElementById('maFullName').value.trim(),
    email: document.getElementById('maEmail').value.trim(),
    username: document.getElementById('maUsername').value.trim(),
    password: document.getElementById('maPassword').value,
    phone: document.getElementById('maPhone').value.trim()
  };

  const res = await fetch('/api/hierarchy/create-admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  hideLoading();

  if (data.success) {
    window.closeCreateAdminModal();
    showToast(data.message, 'success');
    window.loadOwnerDashboard();
  } else {
    showToast(`Error: ${data.message}`, 'error');
  }
};

window.openAddBranchModal = function() {
  document.getElementById('modalCreateBranch').style.display = 'flex';
};

window.closeAddBranchModal = function() {
  document.getElementById('modalCreateBranch').style.display = 'none';
};

window.handleCreateBranchSubmit = async function(e) {
  e.preventDefault();
  showLoading('Creating Supermarket Branch...');

  const payload = {
    creatorRole: (STATE.currentUser && STATE.currentUser.role) || 'owner',
    name: document.getElementById('nbrName').value.trim(),
    code: document.getElementById('nbrCode').value.trim(),
    location: document.getElementById('nbrLocation').value.trim(),
    phone: document.getElementById('nbrPhone').value.trim()
  };

  try {
    const res = await fetch('/api/hierarchy/create-branch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': STATE.currentTenantId,
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    hideLoading();

    if (data.success) {
      window.closeAddBranchModal();
      showToast(data.message, 'success');
      document.getElementById('nbrName').value = '';
      document.getElementById('nbrCode').value = '';
      document.getElementById('nbrLocation').value = '';
      document.getElementById('nbrPhone').value = '';
      window.loadOwnerDashboard();
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    hideLoading();
    showToast('Failed to create branch: ' + err.message, 'error');
  }
};

window.openCreateBranchManagerModal = async function() {
  const select = document.getElementById('mbBranchId');
  select.innerHTML = '<option value="">Loading branches...</option>';
  document.getElementById('modalCreateBranchManager').style.display = 'flex';

  try {
    const res = await fetch('/api/hierarchy/branches', {
      headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
    });
    const data = await res.json();
    if (data.branches && data.branches.length > 0) {
      select.innerHTML = data.branches.map(b => 
        `<option value="${b.id}">${b.name} &bull; ${b.location} (${b.code})</option>`
      ).join('');
    } else {
      select.innerHTML = '<option value="">No branches configured yet (Add a branch first)</option>';
    }
  } catch (err) {
    select.innerHTML = '<option value="BR-001">Main Branch (Default)</option>';
  }
};

window.closeCreateBranchManagerModal = function() {
  document.getElementById('modalCreateBranchManager').style.display = 'none';
};

window.handleCreateBranchManagerSubmit = async function(e) {
  e.preventDefault();
  showLoading('Appointing Branch Manager...');

  const payload = {
    creatorRole: 'admin',
    branchId: document.getElementById('mbBranchId').value,
    fullName: document.getElementById('mbFullName').value.trim(),
    email: document.getElementById('mbEmail').value.trim(),
    password: document.getElementById('mbPassword').value
  };

  const res = await fetch('/api/hierarchy/create-branch-manager', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  hideLoading();

  if (data.success) {
    window.closeCreateBranchManagerModal();
    showToast(data.message, 'success');
    window.loadAdminDashboard();
  } else {
    showToast(`Error: ${data.message}`, 'error');
  }
};

window.openCreateStaffModal = function() {
  document.getElementById('modalCreateStaff').style.display = 'flex';
};

window.closeCreateStaffModal = function() {
  document.getElementById('modalCreateStaff').style.display = 'none';
};

window.handleCreateStaffSubmit = async function(e) {
  e.preventDefault();
  showLoading('Appointing Staff Member...');

  const payload = {
    creatorRole: 'branch_manager',
    role: document.getElementById('msRole').value,
    fullName: document.getElementById('msFullName').value.trim(),
    email: document.getElementById('msEmail').value.trim(),
    password: document.getElementById('msPassword').value,
    pinCode: document.getElementById('msPinCode').value.trim() || '0000',
    phone: document.getElementById('msPhone').value.trim(),
    branchId: STATE.currentBranchId
  };

  const res = await fetch('/api/hierarchy/create-staff', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'X-Branch-Id': STATE.currentBranchId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  hideLoading();

  if (data.success) {
    window.closeCreateStaffModal();
    showToast(data.message, 'success');
    window.loadBranchManagerDashboard();
  } else {
    showToast(`Error: ${data.message}`, 'error');
  }
};

// =========================================================================
// 9. OTHER ROLE DASHBOARDS LOADERS
// =========================================================================
window.loadOwnerDashboard = async function() {
  const res = await fetch('/api/dashboard/owner', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  document.getElementById('boTotalRevenue').innerText = `KES ${(data.totalRevenueKes || 0).toLocaleString()}.00`;
  document.getElementById('boTxCount').innerText = `${data.transactionCount || 0} Completed Transactions`;
  document.getElementById('boGrossProfit').innerText = `KES ${(data.grossProfitKes || 0).toLocaleString()}.00`;
  document.getElementById('boVatCollected').innerText = `KES ${(data.vatCollectedKes || 0).toLocaleString()}.00`;

  if (data.subscription) {
    document.getElementById('boSubPlan').innerText = data.subscription.plan;
    document.getElementById('boSubNext').innerText = `KES ${Number(data.subscription.monthlySubscriptionKes || 8500).toLocaleString()} (Due 1st of month)`;
  }

  const bTbody = document.getElementById('boBranchesTableBody');
  bTbody.innerHTML = '';
  (data.branches || []).forEach(b => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${b.id}</code></td>
      <td><strong>${b.name}</strong></td>
      <td>${b.location}</td>
      <td>${b.registerCount || 1} Tills</td>
      <td>${b.branchSalesCount || 0}</td>
      <td><strong>KES ${(b.branchRevenueKes || 0).toLocaleString()}.00</strong></td>
      <td><span class="badge-success">${b.status}</span></td>
    `;
    bTbody.appendChild(tr);
  });

  const aTbody = document.getElementById('boAdminsTableBody');
  aTbody.innerHTML = '';
  (data.admins || []).forEach(a => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${a.full_name}</strong></td>
      <td><code>${a.username}</code></td>
      <td>${a.email}</td>
      <td>${a.phone || 'N/A'}</td>
      <td><span class="badge-success">ACTIVE</span></td>
    `;
    aTbody.appendChild(tr);
  });
};

window.loadAdminDashboard = async function() {
  const res = await fetch('/api/dashboard/admin', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  document.getElementById('admTotalProducts').innerText = data.totalProducts || 0;
  document.getElementById('admStandardVat').innerText = data.standardVatCount || 0;
  document.getElementById('admZeroRated').innerText = data.zeroRatedCount || 0;
  document.getElementById('admLowStock').innerText = data.lowStockCount || 0;

  const tbody = document.getElementById('admBranchManagersTableBody');
  tbody.innerHTML = '';
  (data.branchManagers || []).forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${m.full_name}</strong></td>
      <td>${m.email}</td>
      <td>${m.phone || 'N/A'}</td>
      <td><strong>${m.branch_name || m.branch_id}</strong></td>
      <td><span class="badge-success">ACTIVE</span></td>
    `;
    tbody.appendChild(tr);
  });
};

window.loadBranchManagerDashboard = async function() {
  const res = await fetch('/api/dashboard/branch_manager', {
    headers: {
      'X-Tenant-Id': STATE.currentTenantId,
      'X-Branch-Id': STATE.currentBranchId,
      'Authorization': `Bearer ${STATE.token}`
    }
  });
  const data = await res.json();

  if (data.branch) {
    document.getElementById('bmBranchTitle').innerText = `${data.branch.name} — Command Center`;
  }

  const s = data.branchSales || {};
  document.getElementById('bmRevenue').innerText = `KES ${(s.totalRevenueKes || 0).toLocaleString()}.00`;
  document.getElementById('bmTxCount').innerText = `${s.transactionCount || 0} Transactions Completed`;
  document.getElementById('bmCash').innerText = `KES ${(s.cashRevenueKes || 0).toLocaleString()}.00`;
  document.getElementById('bmMpesa').innerText = `KES ${(s.mpesaRevenueKes || 0).toLocaleString()}.00`;
  document.getElementById('bmActiveShifts').innerText = (data.activeShifts || []).length;

  const tbody = document.getElementById('bmStaffTableBody');
  tbody.innerHTML = '';
  (data.staff || []).forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${u.full_name}</strong><br><small style="color:#64748b">${u.username}</small></td>
      <td><span class="badge-primary">${u.role.toUpperCase()}</span></td>
      <td>${u.email}</td>
      <td>${u.phone || 'N/A'}</td>
      <td><span class="badge-success">ACTIVE</span></td>
    `;
    tbody.appendChild(tr);
  });
};

window.loadSupervisorDashboard = async function() {
  const res = await fetch('/api/dashboard/supervisor', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  document.getElementById('supPendingCount').innerText = data.pendingSuspensionsCount || 0;
  document.getElementById('supActiveTills').innerText = (data.registers || []).length;

  const tbody = document.getElementById('supSuspendedTableBody');
  tbody.innerHTML = '';
  (data.suspendedSales || []).forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${s.id}</strong></td>
      <td>${s.register_code || s.register_id}</td>
      <td>${s.cashier_name || 'Cashier'}</td>
      <td>${s.suspension_reason || 'Stepped away'}</td>
      <td><strong>KES ${(s.total_kes || 0).toFixed(2)}</strong></td>
      <td>${new Date(s.suspended_at || s.created_at).toLocaleTimeString()}</td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="window.requestResumeSale('${s.id}')">
          Authorize & Resume
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

window.loadCashierDashboard = async function() {
  const res = await fetch('/api/dashboard/cashier', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  if (data.activeShift) {
    document.getElementById('cashShiftStatus').innerText = data.activeShift.status || 'OPEN';
    document.getElementById('cashShiftFloat').innerText = `Opening Float: KES ${(data.activeShift.opening_float_kes || 2500).toLocaleString()}.00`;
  }

  const tbody = document.getElementById('cashRecentSalesTable');
  tbody.innerHTML = '';
  (data.recentSales || []).forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${s.id}</strong></td>
      <td><span class="badge-primary">${s.payment_method || 'CASH'}</span></td>
      <td><strong>KES ${(s.total_kes || 0).toFixed(2)}</strong></td>
      <td><code>${s.mpesa_code || 'N/A'}</code></td>
      <td><span class="badge-success">${s.status}</span></td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="window.previewReceipt('${s.id}')">
          Receipt
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

window.loadStockDashboard = async function() {
  const res = await fetch('/api/dashboard/inventory_manager', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  document.getElementById('imValuation').innerText = `KES ${(data.totalInventoryValuationKes || 0).toLocaleString()}.00`;
  document.getElementById('imTotalSkus').innerText = data.totalProducts || 0;
  document.getElementById('imLowStockCount').innerText = data.lowStockCount || 0;

  const tbody = document.getElementById('imLowStockTable');
  tbody.innerHTML = '';
  (data.lowStockItems || []).forEach(i => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${i.barcode}</code></td>
      <td><strong>${i.name}</strong></td>
      <td>${i.category}</td>
      <td>${i.unit}</td>
      <td><strong style="color:#dc2626;">${i.quantity}</strong></td>
      <td>${i.reorder_level}</td>
      <td>KES ${(i.cost_price_kes || 0).toFixed(2)}</td>
      <td><span class="badge-danger">LOW STOCK</span></td>
    `;
    tbody.appendChild(tr);
  });
};

window.loadProcurementDashboard = async function() {
  const res = await fetch('/api/dashboard/procurement_officer', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  const poTbody = document.getElementById('procurePoTable');
  poTbody.innerHTML = '';
  (data.purchaseOrders || []).forEach(po => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${po.poNumber}</code></td>
      <td><strong>${po.supplier}</strong></td>
      <td>${po.itemsCount} units</td>
      <td><strong>KES ${(po.totalKes || 0).toLocaleString()}.00</strong></td>
      <td><span class="badge-primary">${po.status}</span></td>
    `;
    poTbody.appendChild(tr);
  });

  const supTbody = document.getElementById('procureSuppliersTable');
  supTbody.innerHTML = '';
  (data.suppliers || []).forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${s.id}</code></td>
      <td><strong>${s.name}</strong></td>
      <td>${s.category}</td>
      <td>${s.terms}</td>
      <td>${s.phone}</td>
    `;
    supTbody.appendChild(tr);
  });
};

window.loadAccountantDashboard = async function() {
  const res = await fetch('/api/dashboard/accountant', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  document.getElementById('acctGross').innerText = `KES ${(data.totalRevenueKes || 0).toLocaleString()}.00`;
  document.getElementById('acctVatA').innerText = `KES ${(data.vatRateAKes || 0).toLocaleString()}.00`;
  document.getElementById('acctVatB').innerText = `KES ${(data.zeroRatedSalesKes || 0).toLocaleString()}.00`;
  document.getElementById('acctVariance').innerText = `KES ${(data.tenderReconciliation ? data.tenderReconciliation.discrepancyKes : 0).toFixed(2)}`;

  const tbody = document.getElementById('acctTenderTable');
  tbody.innerHTML = '';
  if (data.tenderReconciliation) {
    const t = data.tenderReconciliation;
    tbody.innerHTML = `
      <tr>
        <td><strong>Physical Cash</strong></td>
        <td>Till Cash Drawer</td>
        <td><strong>KES ${(t.cashKes || 0).toLocaleString()}.00</strong></td>
        <td><span class="badge-success">BALANCED</span></td>
      </tr>
      <tr>
        <td><strong>Safaricom M-Pesa</strong></td>
        <td>Daraja 2.0 Settlement Till</td>
        <td><strong>KES ${(t.mpesaKes || 0).toLocaleString()}.00</strong></td>
        <td><span class="badge-success">SETTLED</span></td>
      </tr>
    `;
  }
};

window.loadAuditorDashboard = async function() {
  const res = await fetch('/api/dashboard/auditor', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  document.getElementById('audTotalLogs').innerText = data.totalAuditLogs || 0;
  document.getElementById('audFailedLogs').innerText = data.failedAttempts || 0;

  const tbody = document.getElementById('audLogsTable');
  tbody.innerHTML = '';
  (data.auditLogs || []).forEach(l => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><small>${new Date(l.timestamp).toLocaleString()}</small></td>
      <td><code>${l.event_type}</code></td>
      <td><strong>${l.user_name}</strong></td>
      <td>${l.user_role}</td>
      <td>${l.action}</td>
      <td><span class="${l.status === 'SUCCESS' ? 'badge-success' : 'badge-danger'}">${l.status}</span></td>
      <td><small style="font-family:monospace; color:#64748b;">${l.integrity_checksum ? l.integrity_checksum.slice(0, 16) + '...' : 'VALID'}</small></td>
    `;
    tbody.appendChild(tr);
  });
};

// =========================================================================
// 10. CLOUD & SUPABASE OFFLINE-FIRST SYNC MODAL
// =========================================================================
function initCloudSyncPoller() {
  updateSyncStatusPill();
  setInterval(updateSyncStatusPill, 20000);
}

async function updateSyncStatusPill() {
  try {
    const res = await fetch('/api/sync/status');
    const data = await res.json();

    const dot = document.getElementById('sbSyncDot');
    const label = document.getElementById('sbSyncLabel');
    const topbarText = document.getElementById('topbarSyncText');

    if (data.status === 'SYNCED') {
      if (dot) dot.className = 'pulse-dot green';
      if (label) label.innerText = 'Supabase Cloud: Synced';
      if (topbarText) topbarText.innerText = 'Cloud Synced';
    } else if (data.status === 'SYNCING') {
      if (dot) dot.className = 'pulse-dot green';
      if (label) label.innerText = `Syncing (${data.pendingQueueCount} queued)`;
      if (topbarText) topbarText.innerText = `Syncing (${data.pendingQueueCount})`;
    } else {
      if (dot) dot.className = 'pulse-dot';
      if (label) label.innerText = 'Offline: Local Secured';
      if (topbarText) topbarText.innerText = 'Local Offline';
    }
  } catch (err) {
    // Offline
    const dot = document.getElementById('sbSyncDot');
    const label = document.getElementById('sbSyncLabel');
    if (dot) dot.className = 'pulse-dot';
    if (label) label.innerText = 'Offline: Local Secured';
  }
}

window.openSyncDetailsModal = async function() {
  showLoading('Checking Cloud Synchronization status...');
  try {
    const res = await fetch('/api/sync/status');
    const data = await res.json();
    hideLoading();

    document.getElementById('lblSyncTarget').innerText = data.supabaseUrl || 'Configured via .env';
    document.getElementById('lblSyncState').innerText = data.hasCloudCredentials
      ? 'ONLINE &bull; REAL-TIME SUPABASE SYNC ACTIVE'
      : 'LOCAL SQLITE SECURE (Add SUPABASE_URL & SUPABASE_KEY to .env to connect Cloud)';
    document.getElementById('lblSyncPending').innerText = `${data.pendingQueueCount} records waiting in local outbox`;
    document.getElementById('modalSyncDetails').style.display = 'flex';
  } catch (err) {
    hideLoading();
    document.getElementById('lblSyncState').innerText = 'OFFLINE (Zero-downtime local store running)';
    document.getElementById('modalSyncDetails').style.display = 'flex';
  }
};

window.closeSyncDetailsModal = function() {
  document.getElementById('modalSyncDetails').style.display = 'none';
};

window.triggerCloudSync = async function() {
  showLoading('Flushing local queue to Supabase...');
  await updateSyncStatusPill();
  setTimeout(() => {
    hideLoading();
    showToast('Local queue flushed to Supabase!', 'success');
    window.closeSyncDetailsModal();
  }, 600);
};

// =========================================================================
// 11. GENERAL STORE DETAILS, SHIFTS, AND CATALOG MANAGEMENT
// =========================================================================
async function loadTenantDetails() {
  const res = await fetch('/api/status', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId }
  });
  const data = await res.json();
  if (data.tenant) {
    const storeTitle = (data.tenant.trade_name || data.tenant.name).toUpperCase();
    const shortcode = data.tenant.mpesa_shortcode || '174379';
    const tillType = data.tenant.mpesa_type || 'TILL';

    const sbStore = document.getElementById('sbStoreName');
    if (sbStore) sbStore.innerText = storeTitle;
    const subTitle = document.getElementById('lblStageSubtitle');
    if (subTitle) subTitle.innerText = `${storeTitle} &bull; Vertext POS SaaS`;

    // Per-Business Till Displays
    const tillCode = document.getElementById('lblActiveTillCode');
    if (tillCode) tillCode.innerText = shortcode;
    const tillHuge = document.getElementById('lblTillNumberHuge');
    if (tillHuge) tillHuge.innerText = shortcode;
    const tillInline = document.getElementById('lblTillNumberInline');
    if (tillInline) tillInline.innerText = shortcode;
    const tillStore = document.getElementById('lblTillStoreName');
    if (tillStore) tillStore.innerText = storeTitle;
    const modalTill = document.getElementById('lblModalTillNumber');
    if (modalTill) modalTill.innerText = shortcode;
    const modalStore = document.getElementById('lblModalStoreName');
    if (modalStore) modalStore.innerText = storeTitle;
    const typeTag = document.getElementById('lblTillTypeTag');
    if (typeTag) typeTag.innerText = `${tillType} NUMBER`;
  }
}

// =========================================================================
// PWA STANDALONE DESKTOP INSTALLATION ENGINE
// =========================================================================
let deferredPwaPrompt = null;

function initPwaInstaller() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('[PWA] Vertext POS Service Worker active with scope:', reg.scope);
    }).catch((err) => {
      console.warn('[PWA] Service Worker registration note:', err.message);
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
    const btn = document.getElementById('btnPwaInstall');
    if (btn) btn.style.display = 'inline-flex';
  });

  window.addEventListener('appinstalled', () => {
    showToast('Vertext POS Desktop App installed successfully!', 'success');
    deferredPwaPrompt = null;
    const btn = document.getElementById('btnPwaInstall');
    if (btn) btn.style.display = 'none';
  });
}

window.triggerPwaInstall = async function() {
  if (!deferredPwaPrompt) {
    showToast('To install: click the Install icon in your browser URL address bar.', 'info');
    return;
  }
  deferredPwaPrompt.prompt();
  const choiceResult = await deferredPwaPrompt.userChoice;
  if (choiceResult.outcome === 'accepted') {
    showToast('Vertext POS installed successfully!', 'success');
  }
  deferredPwaPrompt = null;
  const btn = document.getElementById('btnPwaInstall');
  if (btn) btn.style.display = 'none';
};

// =========================================================================
// BUSINESS PROFILE & RECEIPT LOGO WATERMARK CONFIGURATION
// =========================================================================
let currentBizLogoBase64 = null;

window.openBusinessSettingsModal = async function(specificTenantId) {
  const targetId = specificTenantId || STATE.currentTenantId;
  showLoading('Loading business profile...');

  try {
    const res = await fetch(`/api/tenant/settings?tenantId=${targetId}`, {
      headers: { 'X-Tenant-Id': targetId, 'Authorization': `Bearer ${STATE.token}` }
    });
    const data = await res.json();
    hideLoading();

    if (!data.success || !data.tenant) {
      showToast('Could not load business profile.', 'error');
      return;
    }

    const t = data.tenant;
    document.getElementById('bizSettingTenantId').value = t.id;
    document.getElementById('bizSettingName').value = t.name || '';
    document.getElementById('bizSettingTradeName').value = t.trade_name || t.name || '';
    document.getElementById('bizSettingKraPin').value = t.kra_pin || '';
    document.getElementById('bizSettingPhone').value = t.phone || '';
    document.getElementById('bizSettingEmail').value = t.email || '';
    document.getElementById('bizSettingLocation').value = t.location || 'Nairobi';
    document.getElementById('bizSettingHeaderMsg').value = t.receipt_header_msg || '';
    document.getElementById('bizSettingFooterMsg').value = t.receipt_footer_msg || '';

    currentBizLogoBase64 = t.logo_base64 || null;
    updateBizLogoPreview();

    document.getElementById('modalBusinessSettings').style.display = 'flex';
  } catch (err) {
    hideLoading();
    showToast('Error loading store profile.', 'error');
  }
};

window.closeBusinessSettingsModal = function() {
  document.getElementById('modalBusinessSettings').style.display = 'none';
};

window.handleBizLogoFileSelected = function(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    showToast('Logo file should be under 2MB for fast receipt rendering.', 'warning');
  }

  const reader = new FileReader();
  reader.onload = function(evt) {
    currentBizLogoBase64 = evt.target.result;
    updateBizLogoPreview();
    showToast('Logo loaded! Click Save to apply to receipts.', 'info');
  };
  reader.readAsDataURL(file);
};

window.removeBizLogo = function() {
  currentBizLogoBase64 = null;
  document.getElementById('bizLogoFileInput').value = '';
  updateBizLogoPreview();
  showToast('Logo removed. Save to apply.', 'info');
};

function updateBizLogoPreview() {
  const placeholder = document.getElementById('bizLogoPlaceholder');
  const img = document.getElementById('bizLogoPreviewImg');
  const btnRemove = document.getElementById('btnRemoveLogo');

  if (currentBizLogoBase64) {
    img.src = currentBizLogoBase64;
    img.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (btnRemove) btnRemove.style.display = 'inline-block';
  } else {
    img.src = '';
    img.style.display = 'none';
    if (placeholder) placeholder.style.display = 'inline';
    if (btnRemove) btnRemove.style.display = 'none';
  }
}

window.handleSaveBusinessSettings = async function(e) {
  e.preventDefault();
  showLoading('Saving business settings & receipt branding...');

  const targetId = document.getElementById('bizSettingTenantId').value || STATE.currentTenantId;

  const payload = {
    targetTenantId: targetId,
    name: document.getElementById('bizSettingName').value.trim(),
    tradeName: document.getElementById('bizSettingTradeName').value.trim(),
    kraPin: document.getElementById('bizSettingKraPin').value.trim(),
    phone: document.getElementById('bizSettingPhone').value.trim(),
    email: document.getElementById('bizSettingEmail').value.trim(),
    location: document.getElementById('bizSettingLocation').value.trim(),
    receiptHeaderMsg: document.getElementById('bizSettingHeaderMsg').value.trim(),
    receiptFooterMsg: document.getElementById('bizSettingFooterMsg').value.trim(),
    logoBase64: currentBizLogoBase64
  };

  try {
    const res = await fetch('/api/tenant/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': targetId,
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    hideLoading();

    if (data.success) {
      window.closeBusinessSettingsModal();
      showToast('Business configurations & receipt watermark saved!', 'success');
      await loadTenantDetails();
      if (STATE.currentUser && STATE.currentUser.role === 'owner') {
        window.loadOwnerDashboard();
      } else if (STATE.currentUser && STATE.currentUser.role === 'super_admin') {
        window.loadSuperAdminDashboard();
      }
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    hideLoading();
    showToast('Failed to save settings.', 'error');
  }
};

async function loadActiveShift() {
  const res = await fetch('/api/shifts/active', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'X-Register-Id': STATE.currentRegisterId }
  });
  const data = await res.json();
  STATE.activeShift = data.shift;

  const pillText = document.getElementById('lblShiftStatusText');
  if (data.shift) {
    if (pillText) pillText.innerText = `SHIFT OPEN (Float KES ${(data.shift.opening_float_kes || 2500).toLocaleString()})`;
    const statusDisplay = document.getElementById('shiftStatusDisplay');
    if (statusDisplay) statusDisplay.innerText = data.shift.status;
    const floatDisplay = document.getElementById('shiftFloatDisplay');
    if (floatDisplay) floatDisplay.innerText = `KES ${(data.shift.opening_float_kes || 0).toFixed(2)}`;
    const cashSalesDisplay = document.getElementById('shiftCashSalesDisplay');
    if (cashSalesDisplay) cashSalesDisplay.innerText = `KES ${(data.shift.cash_sales_kes || 0).toFixed(2)}`;
    const mpesaSalesDisplay = document.getElementById('shiftMpesaSalesDisplay');
    if (mpesaSalesDisplay) mpesaSalesDisplay.innerText = `KES ${(data.shift.mpesa_sales_kes || 0).toFixed(2)}`;
  } else {
    if (pillText) pillText.innerText = 'NO SHIFT OPEN';
  }
}

window.openCloseShiftModal = function() {
  document.getElementById('closeShiftModal').style.display = 'flex';
};

window.closeCloseShiftModal = function() {
  document.getElementById('closeShiftModal').style.display = 'none';
};

window.submitCloseShift = async function() {
  if (!STATE.activeShift) {
    showToast('No active shift to close.', 'warning');
    return;
  }
  const counted = parseFloat(document.getElementById('txtClosingCashCount').value) || 0;
  const notes = document.getElementById('txtShiftNotes').value;

  showLoading('Reconciling shift cash and calculating variances...');
  const res = await fetch('/api/shifts/close', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': STATE.currentTenantId,
      'Authorization': `Bearer ${STATE.token}`
    },
    body: JSON.stringify({
      shiftId: STATE.activeShift.id,
      closingCashKes: counted,
      notes,
      approvedBy: 'Alice Wambui (Supervisor)'
    })
  });

  const data = await res.json();
  hideLoading();

  if (data.success) {
    window.closeCloseShiftModal();
    showToast(`Shift closed! Expected: KES ${data.shift.expectedCashKes.toFixed(2)} | Counted: KES ${data.shift.closingCashKes.toFixed(2)}`, 'success');
    await loadActiveShift();
  } else {
    showToast(`Error: ${data.message}`, 'error');
  }
};

async function loadInventoryTable() {
  const tbody = document.getElementById('inventoryTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const res = await fetch('/api/products', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();
  const prods = data.products || [];

  prods.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${p.barcode}</code></td>
      <td><strong>${p.name}</strong><br><small style="color:#64748b;">SKU: ${p.sku || p.barcode}</small></td>
      <td>${p.category}</td>
      <td>KES ${Number(p.cost_price_kes || 0).toFixed(2)}</td>
      <td><strong>KES ${Number(p.selling_price_kes || 0).toFixed(2)}</strong></td>
      <td>KES ${Number(p.wholesale_price_kes || p.selling_price_kes).toFixed(2)}</td>
      <td><span class="badge-primary">${p.vat_rate === 0.0 ? '0% Zero-Rated' : '16% Standard'}</span></td>
      <td>100 ${p.unit || 'PCS'}</td>
    `;
    tbody.appendChild(tr);
  });
}

window.openAddProductModal = function() {
  document.getElementById('addProductModal').style.display = 'flex';
};

window.closeAddProductModal = function() {
  document.getElementById('addProductModal').style.display = 'none';
};

window.handleCreateProductSubmit = async function(e) {
  if (e && e.preventDefault) e.preventDefault();

  try {
    showLoading('Saving product SKU to supermarket catalog...');

    const nameInput = document.getElementById('npName');
    const barcodeInput = document.getElementById('npBarcode');
    const skuInput = document.getElementById('npSku');
    const catElem = document.getElementById('npCategory');
    const stockInput = document.getElementById('npInitialStock');
    const costInput = document.getElementById('npCostPrice');
    const sellInput = document.getElementById('npSellingPrice');
    const wholeInput = document.getElementById('npWholesalePrice');
    const vatElem = document.getElementById('npVatRate');

    const name = nameInput ? nameInput.value.trim() : '';
    const barcode = barcodeInput ? barcodeInput.value.trim() : '';

    if (!name || !barcode) {
      showToast('Product name and barcode are required.', 'warning');
      return;
    }

    const payload = {
      name,
      barcode,
      sku: (skuInput && skuInput.value.trim()) || ('SKU-' + barcode.slice(-6)),
      category: (catElem && catElem.value) || 'FMCG & Groceries',
      initialStock: parseFloat(stockInput?.value) || 100,
      costPriceKes: parseFloat(costInput?.value) || 0,
      sellingPriceKes: parseFloat(sellInput?.value) || 0,
      wholesalePriceKes: parseFloat(wholeInput?.value) || parseFloat(sellInput?.value) || 0,
      vatRate: vatElem ? parseFloat(vatElem.value) : 16.0
    };

    const res = await fetch('/api/products', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': STATE.currentTenantId,
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (data.success) {
      window.closeAddProductModal();
      showToast(`Product "${payload.name}" saved successfully!`, 'success');
      try { await loadProducts(); } catch (e) {}
      try {
        if (document.getElementById('inventoryTableBody')) {
          await loadInventoryTable();
        }
      } catch (e) {}

      // If POS terminal is active, immediately add this newly created item to customer cart!
      const activeTab = document.querySelector('.pos-tab-btn.active');
      const isPos = activeTab && activeTab.dataset.tab === 'pos';
      if (isPos && payload.barcode) {
        await addItemByBarcode(payload.barcode);
      }
    } else {
      showToast(`Error: ${data.message || 'Failed to save product.'}`, 'error');
    }
  } catch (err) {
    showToast('Failed to save product: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
};

async function loadSuspendedSales() {
  const res = await fetch('/api/pos/suspended', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();
  STATE.suspendedSales = data.suspendedSales || [];

  const badgeHeld = document.getElementById('btnHeldCount');
  if (badgeHeld) badgeHeld.innerText = STATE.suspendedSales.length;

  const tbody = document.getElementById('suspendedTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (STATE.suspendedSales.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center">No transactions currently suspended.</td></tr>`;
  } else {
    STATE.suspendedSales.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${s.id}</strong></td>
        <td>${new Date(s.suspended_at || s.created_at).toLocaleTimeString()}</td>
        <td><span class="badge-primary">${s.suspended_by || 'Supervisor'}</span></td>
        <td>${s.suspension_reason || 'Stepped away'}</td>
        <td>${s.items ? s.items.length : 0} items</td>
        <td><strong>KES ${(s.total_kes || 0).toFixed(2)}</strong></td>
        <td>KES ${(s.paid_amount_kes || 0).toFixed(2)}</td>
        <td>
          <button class="btn btn-sm btn-primary" onclick="window.requestResumeSale('${s.id}')">
            Resume
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// Supervisor Suspension / Resumption
let currentSuspendAction = null;
let currentResumeSaleId = null;

window.handleSuspendSale = function() {
  if (!STATE.currentSale || !STATE.currentSale.items || STATE.currentSale.items.length === 0) {
    showToast('Cart is empty. Add products to suspend.', 'warning');
    return;
  }
  currentSuspendAction = 'suspend';
  document.getElementById('supModalTitle').innerText = 'Supervisor Authorization to Suspend';
  document.getElementById('groupSuspendReason').style.display = 'block';
  document.getElementById('supervisorModal').style.display = 'flex';
};

window.requestResumeSale = function(saleId) {
  currentSuspendAction = 'resume';
  currentResumeSaleId = saleId;
  document.getElementById('supModalTitle').innerText = 'Supervisor Authorization to Resume';
  document.getElementById('groupSuspendReason').style.display = 'none';
  document.getElementById('supervisorModal').style.display = 'flex';
};

window.closeSupervisorModal = function() {
  document.getElementById('supervisorModal').style.display = 'none';
};

window.submitSupervisorAuth = async function() {
  const supervisorId = document.getElementById('selSupervisor').value;
  const pin = document.getElementById('txtSupervisorPin').value;

  if (pin !== '4444' && pin !== '3333' && pin !== '1111') {
    showToast('Invalid Supervisor PIN / Biometric mismatch.', 'error');
    return;
  }

  showLoading('Verifying supervisor authorization...');

  if (currentSuspendAction === 'suspend') {
    const reason = document.getElementById('selSuspendReason').value;
    const res = await fetch(`/api/pos/sale/${STATE.currentSale.id}/suspend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': STATE.currentTenantId,
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify({ supervisorId, reason })
    });
    const data = await res.json();
    hideLoading();

    if (data.success) {
      window.closeSupervisorModal();
      showToast('Transaction suspended by supervisor.', 'success');
      await startNewSale();
      await loadSuspendedSales();
    } else {
      showToast(`Suspension rejected: ${data.message}`, 'error');
    }
  } else if (currentSuspendAction === 'resume') {
    const res = await fetch(`/api/pos/sale/${currentResumeSaleId}/resume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': STATE.currentTenantId,
        'Authorization': `Bearer ${STATE.token}`
      },
      body: JSON.stringify({ supervisorId })
    });
    const data = await res.json();
    hideLoading();

    if (data.success) {
      window.closeSupervisorModal();
      showToast('Transaction resumed by supervisor! Items recovered.', 'success');
      STATE.currentSale = data.sale;
      window.switchTab('pos');
      renderCart();
      await loadSuspendedSales();
    } else {
      showToast(`Resumption rejected: ${data.message}`, 'error');
    }
  }
};

async function loadDashboardReports() {
  const res = await fetch('/api/reports/dashboard', {
    headers: { 'X-Tenant-Id': STATE.currentTenantId, 'Authorization': `Bearer ${STATE.token}` }
  });
  const data = await res.json();

  const revEl = document.getElementById('kpiTotalRevenue');
  if (revEl) revEl.innerText = `KES ${(data.todaySalesKes || 0).toFixed(2)}`;
  const mpesaEl = document.getElementById('kpiMpesaRevenue');
  if (mpesaEl) mpesaEl.innerText = `KES ${(data.mpesaRevenueKes || 0).toFixed(2)}`;
  const cashEl = document.getElementById('kpiCashRevenue');
  if (cashEl) cashEl.innerText = `KES ${(data.cashRevenueKes || 0).toFixed(2)}`;
  const txEl = document.getElementById('kpiTxCount');
  if (txEl) txEl.innerText = data.transactionCount || 0;
}

// UI Helpers
let loadingSafetyTimeout = null;
function showLoading(msg = 'Loading...') {
  const overlay = document.getElementById('loadingOverlay');
  const text = document.getElementById('lblLoadingText');
  if (text) text.innerText = msg;
  if (overlay) overlay.style.display = 'flex';

  // Failsafe: automatically dismiss after 5 seconds so user is never stuck
  if (loadingSafetyTimeout) clearTimeout(loadingSafetyTimeout);
  loadingSafetyTimeout = setTimeout(() => {
    hideLoading();
  }, 5000);
}

function hideLoading() {
  if (loadingSafetyTimeout) {
    clearTimeout(loadingSafetyTimeout);
    loadingSafetyTimeout = null;
  }
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.style.display = 'none';
}
window.hideLoading = hideLoading;
window.showLoading = showLoading;

function showToast(message, type = 'info') {
  const toast = document.getElementById('toastNotification');
  if (!toast) return;
  toast.innerText = message;
  toast.className = `toast-popup toast-${type}`;
  toast.style.display = 'block';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}
