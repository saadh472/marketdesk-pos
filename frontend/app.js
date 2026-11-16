(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var money = new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', currencyDisplay: 'code', minimumFractionDigits: 2 });
  var numbers = new Intl.NumberFormat('en-PK');
  var storageKey = 'marketdesk.pending-checkout.v1';
  var state = { session: null, products: [], orders: [], dashboard: null, page: 'overview', cart: new Map(), cash: '', search: '', category: 'All', inventorySearch: '', inventoryFilter: 'active', orderFilter: 'all', busy: false, writeUncertain: false, attempt: null, notice: null, checkoutError: '', focusReturn: null, toastTimer: null };

  function escape(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]; }); }
  function icon(name) { return '<svg class="icon" aria-hidden="true"><use href="/icons.svg#' + name + '"></use></svg>'; }
  function cash(cents) { return money.format(cents / 100); }
  function count(value) { return numbers.format(value || 0); }
  function decimal(cents) { return Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0'); }
  function parsePaisa(value) {
    var text = String(value).trim();
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) return null;
    var parts = text.split('.');
    var result = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
    return Number.isSafeInteger(result) && result <= 100000000000 ? result : null;
  }
  function integer(value, min, max) { return /^-?\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max; }
  function date(value, short) {
    var parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Date unavailable';
    return parsed.toLocaleString('en-PK', short ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function uuid() {
    if (window.crypto.randomUUID) return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function product(id) { return state.products.find(function (entry) { return entry.id === Number(id); }); }
  function categories() { return Array.from(new Set(state.products.map(function (entry) { return entry.category; }))).sort(); }
  function pendingOrders() { return state.orders.filter(function (order) { return order.status === 'PENDING'; }).sort(function (a, b) { return a.id - b.id; }); }
  function blocked() { return state.busy || state.writeUncertain || Boolean(state.attempt && state.attempt.uncertain); }
  function unavailable(condition) { return condition ? ' data-unavailable="true" disabled' : ''; }
  function statusTag(status) { return '<span class="status-tag ' + escape(status.toLowerCase()) + '">' + escape(status.charAt(0) + status.slice(1).toLowerCase()) + '</span>'; }
  function symbol(category) {
    var key = String(category).toLowerCase();
    var known = ['grocery', 'dairy', 'beverages', 'snacks', 'household', 'produce'];
    var css = known.includes(key) ? key : 'grocery';
    return '<span class="product-symbol ' + css + '">' + icon(css === 'produce' ? 'leaf' : css === 'beverages' || css === 'dairy' ? 'cup' : css === 'snacks' ? 'bag' : 'box') + '</span>';
  }
  function productCell(entry) { return '<div class="product-cell">' + symbol(entry.category) + '<span><strong>' + escape(entry.name) + '</strong><small>' + escape(entry.sku) + '</small></span></div>'; }
  function empty(title, description, action) { return '<div class="empty-state">' + icon('box') + '<h3>' + escape(title) + '</h3><p>' + escape(description) + '</p>' + (action || '') + '</div>'; }
  function pageHeading(eyebrow, title, description, actions) { return '<div class="page-heading"><div><span class="eyebrow">' + escape(eyebrow) + '</span><h1 tabindex="-1">' + escape(title) + '</h1><p>' + escape(description) + '</p></div><div class="heading-actions">' + (actions || '') + '</div></div>'; }

  function notice(message, kind, action) { state.notice = { message: message, kind: kind || 'info', action: action || null }; renderNotice(); }
  function renderNotice() {
    var area = $('globalNotice');
    area.hidden = !state.notice;
    if (!state.notice) return;
    area.dataset.kind = state.notice.kind;
    area.innerHTML = '<span>' + escape(state.notice.message) + '</span>' + (state.notice.action ? '<button data-action="' + state.notice.action + '" class="button secondary compact">Reload records</button>' : '') + '<button data-action="dismiss-notice" class="icon-button" aria-label="Dismiss notification">' + icon('close') + '</button>';
  }
  function toast(message) {
    window.clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    state.toastTimer = window.setTimeout(function () { $('toast').hidden = true; }, 4200);
  }
  function syncControls() {
    document.querySelectorAll('[data-write]').forEach(function (button) { button.disabled = blocked() || button.dataset.unavailable === 'true'; });
    document.querySelectorAll('.cart-edit').forEach(function (control) { control.disabled = state.busy || Boolean(state.attempt) || control.dataset.limit === 'true'; });
    ['saveProduct', 'saveStock', 'confirmCancel'].forEach(function (id) { $(id).disabled = blocked(); });
    document.querySelectorAll('[data-action="logout"]').forEach(function (button) { button.disabled = state.busy; });
    document.querySelectorAll('[data-action="refresh"]').forEach(function (button) { button.disabled = state.busy; button.setAttribute('aria-busy', String(state.busy)); });
    $('loginForm').querySelector('button[type="submit"]').disabled = state.busy;
    $('fillDemo').disabled = state.busy;
  }
  function setBusy(value) { state.busy = value; syncControls(); }

  function ApiError(message, status, uncertain) { this.name = 'ApiError'; this.message = message; this.status = status || 0; this.uncertain = Boolean(uncertain); }
  ApiError.prototype = Object.create(Error.prototype);
  async function api(path, options) {
    options = options || {};
    var method = options.method || 'GET';
    var writing = method !== 'GET';
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, 12000);
    var headers = { Accept: 'application/json' };
    if (writing) headers['X-CSRF-TOKEN'] = state.session ? state.session.csrfToken : '';
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    var response;
    try {
      response = await window.fetch(path, { method: method, credentials: 'same-origin', headers: headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal });
      var body;
      try { body = await response.json(); }
      catch (error) { throw new ApiError('The server returned an unreadable result. Reload the records before continuing.', response.status, writing && (response.ok || response.status >= 500)); }
      if (!response.ok) {
        if (response.status === 401 && path !== '/api/login') signedOut('Your session expired. Sign in again to continue.');
        if (response.status === 403 && path !== '/api/session') {
          try {
            state.session = await api('/api/session');
            if (!state.session.authenticated) signedOut('Your session expired. Sign in again to continue.');
          } catch (ignored) { /* Do not repeat the original write. */ }
          throw new ApiError('The session token changed. Review your action and submit it again.', 403, false);
        }
        throw new ApiError(body.message || 'This request could not be completed.', response.status, writing && response.status >= 500);
      }
      return body;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(writing ? 'The result could not be confirmed. The server may have saved this change.' : 'The local server could not be reached. Check that the launcher is still running.', 0, writing);
    } finally { window.clearTimeout(timer); }
  }
  async function loadData() {
    var results = await Promise.all([api('/api/products'), api('/api/orders'), api('/api/dashboard')]);
    if (!Array.isArray(results[0]) || !Array.isArray(results[1]) || !results[2] || typeof results[2].productCount !== 'number') throw new ApiError('The server returned incomplete workspace data. Reload to try again.');
    state.products = results[0]; state.orders = results[1]; state.dashboard = results[2];
    renderPage();
  }
  async function refreshWorkspace() {
    if (state.busy) return;
    setBusy(true);
    try {
      await loadData();
      state.writeUncertain = false;
      if (state.attempt) notice('A checkout still needs confirmation. Return to Checkout and retry the same request to recover its original receipt.', 'warning');
      else { state.notice = null; renderNotice(); toast('Your workspace is up to date.'); }
      closeDialog();
    } catch (error) { notice(error.message, 'error', 'refresh'); }
    finally { setBusy(false); }
  }
  async function afterMutation(message) {
    try { await loadData(); toast(message); }
    catch (error) { state.writeUncertain = true; notice(message + ' The updated records could not be loaded. Reload before making another change.', 'warning', 'refresh'); }
  }
  function mutationError(error, target) {
    if (error.uncertain) { state.writeUncertain = true; notice(error.message + ' Reload and review the records before making another change.', 'warning', 'refresh'); }
    if (target) { $(target).textContent = error.message; $(target).hidden = false; }
    else if (!error.uncertain) notice(error.message, 'error', error.status === 409 || error.status === 503 ? 'refresh' : null);
    syncControls();
  }

  function signedOut(message) {
    closeDialog();
    state.products = []; state.orders = []; state.dashboard = null;
    $('boot').hidden = true; $('workspace').hidden = true; $('loginScreen').hidden = false;
    $('password').value = '';
    $('loginNote').textContent = message || ''; $('loginNote').hidden = !message;
  }
  async function enterWorkspace() {
    $('sidebarUser').textContent = state.session.user ? state.session.user.displayName : 'Demo Manager';
    $('loginScreen').hidden = true; $('workspace').hidden = false; $('boot').hidden = true;
    $('pageContent').innerHTML = '<div class="card skeleton" role="status">Loading your store…</div>';
    try {
      await loadData();
      if (state.attempt) { state.page = 'checkout'; renderPage(); notice('A previous checkout has an unknown result. Retry that same request below to recover its receipt safely.', 'warning'); }
    } catch (error) { notice(error.message, 'error', 'refresh'); }
  }
  async function submitLogin() {
    if (state.busy) return;
    $('loginError').hidden = true;
    setBusy(true);
    try {
      if (!state.session) state.session = await api('/api/session');
      state.session = await api('/api/login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } });
      $('password').value = '';
      state.notice = null; state.writeUncertain = false;
      await enterWorkspace();
    } catch (error) { $('loginError').textContent = error.message; $('loginError').hidden = false; }
    finally { setBusy(false); }
  }
  async function logout() {
    if (state.busy) return;
    setBusy(true);
    try { state.session = await api('/api/logout', { method: 'POST' }); signedOut('You are signed out. Your store records are saved locally.'); }
    catch (error) { notice(error.message, 'error'); }
    finally { setBusy(false); }
  }
  function setPage(page, focus) {
    if (!['overview', 'checkout', 'inventory', 'orders'].includes(page)) page = 'overview';
    state.page = page;
    window.history.replaceState(null, '', '#' + page);
    closeNavigation();
    renderPage();
    if (focus) { var title = $('pageContent').querySelector('h1'); if (title) title.focus(); }
  }
  function renderPage() {
    if (!state.session || !state.session.authenticated || !state.dashboard) return;
    $('breadcrumbPage').textContent = state.page.charAt(0).toUpperCase() + state.page.slice(1);
    $('pageContent').setAttribute('aria-label', $('breadcrumbPage').textContent);
    document.querySelectorAll('.nav-item').forEach(function (button) { var active = button.dataset.page === state.page; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    var cartCount = Array.from(state.cart.values()).reduce(function (sum, quantity) { return sum + quantity; }, 0);
    $('navCartCount').textContent = cartCount; $('navCartCount').hidden = !cartCount;
    $('navOrderCount').textContent = pendingOrders().length; $('navOrderCount').hidden = !pendingOrders().length;
    if (state.page === 'overview') renderOverview();
    if (state.page === 'checkout') renderCheckout();
    if (state.page === 'inventory') renderInventory();
    if (state.page === 'orders') renderOrders();
    renderNotice(); syncControls();
  }
  function renderOverview() {
    var data = state.dashboard;
    var today = new Date().toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
    var low = state.products.filter(function (entry) { return entry.active && entry.stock <= entry.reorderLevel; }).sort(function (a,b) { return a.stock - b.stock; });
    var metrics = [
      ['box', 'Active products', count(data.productCount), 'Across your store shelves', false],
      ['bag', 'Stock on hand', count(data.stockUnits), 'Units available to sell', false],
      ['trend', 'Sales recorded', cash(data.salesCents), 'Pending + fulfilled · excludes cancelled', true],
      ['receipt', 'Pending orders', count(data.pendingCount), 'Ready for the fulfillment queue', false]
    ].map(function (metric) { return '<article class="card metric"><div class="metric-label"><span>' + metric[1] + '</span><span class="metric-icon">' + icon(metric[0]) + '</span></div><div class="metric-value' + (metric[4] ? ' money' : '') + '">' + metric[2] + '</div><div class="metric-note">' + metric[3] + '</div></article>'; }).join('');
    var maxUnits = Math.max.apply(null, [1].concat(data.topProducts.map(function (entry) { return entry.quantity; })));
    var top = data.topProducts.length ? '<div class="top-products">' + data.topProducts.map(function (entry) { return '<div class="top-product"><div class="top-product-title"><strong>' + escape(entry.name) + '</strong><span>' + count(entry.quantity) + ' sold</span></div><div class="bar-track"><i style="width:' + Math.round(entry.quantity / maxUnits * 100) + '%"></i></div></div>'; }).join('') + '</div>' : empty('Your first sale starts here', 'Complete a simulated checkout to see your most popular products.');
    $('pageContent').innerHTML = pageHeading('STORE OVERVIEW', 'Your store, at a glance.', 'A little clarity for a well-run day.', '<span class="date-label">' + icon('receipt') + escape(today) + '</span><button class="button primary" data-action="navigate" data-page="checkout">' + icon('plus') + 'New checkout</button>') +
      '<div class="metric-grid">' + metrics + '</div><div class="overview-grid"><div class="card"><div class="store-banner"><div><span class="eyebrow">A GOOD DAY STARTS HERE</span><h2>Good stock.<br>Great store rhythm.</h2><p>Keep your shelves ready, check out with confidence, and bring a little order to every sale.</p><button class="button primary compact" data-action="navigate" data-page="inventory">Explore inventory ' + icon('arrow') + '</button></div><div class="banner-art" aria-hidden="true"><i></i><i></i><i></i></div></div><div class="card-header"><div><h2>Something for every shelf</h2><p>Your active product categories</p></div></div><div class="category-summary">' + data.categoryCounts.map(function (entry) { return '<span class="category-chip">' + escape(entry.category) + '<b>' + count(entry.count) + '</b></span>'; }).join('') + '</div></div><div class="card"><div class="card-header"><div><h2>Popular at the counter</h2><p>By units sold · cancelled orders excluded</p></div>' + icon('trend') + '</div>' + top + '</div></div>' +
      '<div class="card"><div class="card-header"><div><h2>A little shelf attention <span class="muted small">(' + low.length + ')</span></h2><p>Products at or below their low-stock threshold.</p></div><button class="text-button" data-action="low-stock">Manage stock ' + icon('arrow') + '</button></div>' + (low.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Product</th><th>Category</th><th>On hand</th><th>Threshold</th><th class="align-right">Status</th></tr></thead><tbody>' + low.slice(0,5).map(function (entry) { return '<tr><td>' + productCell(entry) + '</td><td>' + escape(entry.category) + '</td><td><span class="stock-number low">' + count(entry.stock) + ' units</span></td><td>' + count(entry.reorderLevel) + '</td><td class="align-right"><span class="status-tag warning">' + (entry.stock ? 'Low stock' : 'Out of stock') + '</span></td></tr>'; }).join('') + '</tbody></table></div>' : empty('Your shelves look ready', 'No active products are below their stock threshold.')) + '</div>' +
      '<div class="card" style="margin-top:22px"><div class="card-header"><div><h2>Recent orders</h2><p>A quick look at your latest checkouts.</p></div><button class="text-button" data-action="navigate" data-page="orders">View all ' + icon('arrow') + '</button></div>' + orderTable(data.recentOrders || [], false) + '</div>';
  }
  function renderCheckout() {
    $('pageContent').innerHTML = pageHeading('THE COUNTER', 'A smoother way to check out.', 'Find a product, build your basket, and simulate a cash sale.', '<span class="inventory-summary"><i></i>Prices in PKR</span>') +
      '<div class="checkout-layout"><section aria-label="Product catalog"><div class="catalog-toolbar"><div class="search-field">' + icon('search') + '<label class="visually-hidden" for="catalogSearch">Search products</label><input id="catalogSearch" type="search" value="' + escape(state.search) + '" placeholder="Search products or SKU…"></div><span id="catalogCount" class="catalog-count"></span></div><div class="category-tabs" aria-label="Product categories">' + ['All'].concat(categories()).map(function (category) { return '<button class="category-tab' + (state.category === category ? ' active' : '') + '" data-action="category" data-category="' + escape(category) + '" aria-pressed="' + (state.category === category) + '">' + escape(category === 'All' ? 'All products' : category) + '</button>'; }).join('') + '</div><div id="catalogGrid" class="catalog-grid"></div></section><aside id="cartPanel" class="cart-panel" aria-label="Current sale"></aside></div>';
    renderCatalog(); renderCart();
  }
  function renderCatalog() {
    var matches = state.products.filter(function (entry) { return entry.active && (state.category === 'All' || entry.category === state.category) && (entry.name + ' ' + entry.sku).toLowerCase().includes(state.search.toLowerCase().trim()); });
    $('catalogCount').textContent = matches.length + ' products';
    $('catalogGrid').innerHTML = matches.length ? matches.map(function (entry) {
      var selected = state.cart.get(entry.id) || 0;
      return '<article class="product-card"><div class="product-card-top">' + symbol(entry.category) + '<span class="stock-label' + (entry.stock <= entry.reorderLevel ? ' low' : '') + '">' + (entry.stock ? count(entry.stock) + ' in stock' : 'Out of stock') + '</span></div><small>' + escape(entry.category) + '</small><h3>' + escape(entry.name) + '</h3><div class="product-card-bottom"><span class="product-price">' + cash(entry.priceCents) + '</span><button class="add-product" data-action="cart-add" data-id="' + entry.id + '" data-write aria-label="Add ' + escape(entry.name) + ' to basket"' + unavailable(selected >= entry.stock) + '>' + icon('plus') + (selected ? '<span>' + selected + '</span>' : '') + '</button></div></article>';
    }).join('') : '<div class="catalog-empty">' + empty('No products found', 'Try another name, SKU, or category.') + '</div>';
    syncControls();
  }
  function cartLines() {
    return Array.from(state.cart.entries()).map(function (pair) {
      var entry = product(pair[0]);
      if (!entry && state.attempt) {
        var saved = state.attempt.snapshot.find(function (item) { return item.id === pair[0]; });
        if (saved) entry = { id: saved.id, name: saved.name, priceCents: saved.unitPriceCents, stock: 0, active: false };
      }
      return { product: entry, quantity: pair[1], valid: Boolean(entry && entry.active && pair[1] <= entry.stock) };
    });
  }
  function cartTotal() { return cartLines().reduce(function (sum, line) { return sum + (line.product ? line.product.priceCents * line.quantity : 0); }, 0); }
  function renderCart() {
    var lines = cartLines();
    var units = lines.reduce(function (sum,line) { return sum + line.quantity; }, 0);
    var total = cartTotal();
    var locked = Boolean(state.attempt);
    $('cartPanel').innerHTML = '<div class="cart-header"><h2>Current sale <span>' + units + ' items</span></h2><span>CASH ONLY</span></div>' +
      (lines.length ? '<div class="cart-items">' + lines.map(function (line) {
        var entry = line.product;
        return '<div class="cart-item"><div><h3>' + escape(entry ? entry.name : 'Unavailable product') + '</h3><small>' + (entry ? cash(entry.priceCents) + ' each' : 'Remove this item to continue') + '</small></div><span class="cart-line-price">' + cash(entry ? entry.priceCents * line.quantity : 0) + '</span><div class="cart-controls"><div class="quantity-control"><button class="cart-edit" data-action="cart-decrease" data-id="' + (entry ? entry.id : '') + '" aria-label="Decrease quantity of ' + escape(entry ? entry.name : 'item') + '"' + (locked ? ' disabled' : '') + '>' + icon('minus') + '</button><span>' + line.quantity + '</span><button class="cart-edit" data-action="cart-add" data-id="' + (entry ? entry.id : '') + '" aria-label="Increase quantity of ' + escape(entry ? entry.name : 'item') + '"' + (locked || !entry || line.quantity >= entry.stock ? ' disabled data-limit="true"' : '') + '>' + icon('plus') + '</button></div><button class="cart-remove cart-edit" data-action="cart-remove" data-id="' + (entry ? entry.id : '') + '"' + (locked ? ' disabled' : '') + '>Remove</button></div>' + (!line.valid && !locked ? '<span class="cart-line-warning">Stock changed. Reduce the quantity or remove this item.</span>' : '') + '</div>';
      }).join('') + '</div>' : '<div class="empty-state cart-empty">' + icon('cart') + '<h3>Make room for a good sale.</h3><p>Add a product from the catalog to start your basket.</p></div>') +
      (state.attempt && state.attempt.uncertain ? '<div class="checkout-recovery" role="alert"><strong>Checkout result unknown</strong>The server may already have saved this sale. Keep this basket unchanged and retry the same request to recover its receipt.<br><button data-action="retry-checkout" class="button secondary"' + (state.busy ? ' disabled' : '') + '>Retry same checkout ' + icon('refresh') + '</button><button data-action="navigate" data-page="orders" class="text-button">View orders</button></div>' : '') +
      (state.checkoutError ? '<p class="field-error checkout-error" role="alert">' + escape(state.checkoutError) + '</p>' : '') +
      '<form id="checkoutForm" class="checkout-summary"><div class="summary-line"><span>Subtotal</span><strong>' + cash(total) + '</strong></div><div class="summary-line"><span>Additional charges</span><strong>' + cash(0) + '</strong></div><div class="summary-line total"><span>Total to pay</span><strong id="cartTotal">' + cash(total) + '</strong></div><label class="cash-label" for="cashReceived">Cash received <span>SIMULATED PAYMENT</span></label><div class="cash-input"><span>PKR</span><input id="cashReceived" class="cart-edit" inputmode="decimal" placeholder="0.00" value="' + escape(state.cash) + '"' + (locked ? ' disabled' : '') + '></div><p id="cashChange" class="cash-change"></p><button id="completeCheckout" data-write class="button primary checkout-submit" type="submit">Complete checkout ' + icon('arrow') + '</button><p class="checkout-caption">' + icon('lock') + 'No real money moves. No card details needed.</p></form>';
    updateCash(); syncControls();
    // Quantity limits survive global busy-state updates.
    document.querySelectorAll('[data-limit="true"]').forEach(function (button) { button.disabled = true; });
  }
  function updateCash() {
    var tendered = parsePaisa(state.cash), total = cartTotal(), lines = cartLines();
    var valid = lines.length && lines.every(function (line) { return line.valid; }) && tendered !== null && tendered >= total && total <= 100000000000 && !state.attempt;
    $('completeCheckout').dataset.unavailable = String(!valid);
    $('cashChange').classList.toggle('cart-invalid', Boolean(state.cash && (tendered === null || tendered < total)));
    $('cashChange').textContent = !state.cash ? 'Change will appear here.' : tendered === null ? 'Use an amount with at most two decimal places.' : tendered < total ? cash(total - tendered) + ' more cash is needed.' : 'Change to return: ' + cash(tendered - total);
    syncControls();
  }
  function changeCart(id, direction) {
    if (blocked() || state.attempt) return;
    var entry = product(id); if (!entry) return;
    var value = (state.cart.get(entry.id) || 0) + direction;
    if (value <= 0) state.cart.delete(entry.id);
    else if (entry.active && value <= entry.stock && value <= 1000) state.cart.set(entry.id, value);
    else { toast('That quantity is not available.'); return; }
    state.checkoutError = ''; renderCatalog(); renderCart(); renderNavCounts();
  }
  function renderNavCounts() {
    var units = Array.from(state.cart.values()).reduce(function (sum,quantity) { return sum + quantity; },0);
    $('navCartCount').textContent = units; $('navCartCount').hidden = !units;
  }
  function saveAttempt() { try { sessionStorage.setItem(storageKey, JSON.stringify(state.attempt)); } catch (ignored) { notice('This browser cannot retain a pending checkout after reload. Keep this tab open until the receipt is confirmed.', 'warning'); } }
  function clearAttempt() { state.attempt = null; try { sessionStorage.removeItem(storageKey); } catch (ignored) { /* In-memory confirmation still clears the current sale. */ } }
  function restoreAttempt() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (!saved) return;
      if (!saved.payload || !/^[0-9a-f-]{36}$/i.test(saved.payload.requestId) || !Array.isArray(saved.payload.items) || !saved.payload.items.length || saved.payload.items.length > 100 || !Number.isSafeInteger(saved.payload.tenderedCents) || saved.payload.tenderedCents < 0 || saved.payload.tenderedCents > 100000000000 || !Array.isArray(saved.snapshot)) throw new Error('Invalid stored checkout');
      var ids = new Set();
      saved.payload.items.forEach(function (item) { if (!Number.isSafeInteger(item.productId) || item.productId < 1 || !integer(item.quantity,1,1000) || ids.has(item.productId)) throw new Error('Invalid stored cart'); ids.add(item.productId); });
      saved.uncertain = true; state.attempt = saved; state.cash = decimal(saved.payload.tenderedCents);
      saved.payload.items.forEach(function (item) { state.cart.set(item.productId,item.quantity); });
    } catch (ignored) { try { sessionStorage.removeItem(storageKey); } catch (unavailableStorage) { /* Storage is optional. */ } }
  }
  async function checkout(retry) {
    if (state.busy || state.writeUncertain) return;
    if (!retry) {
      if (state.attempt) return;
      var lines = cartLines(), tendered = parsePaisa(state.cash);
      if (!lines.length || !lines.every(function (line) { return line.valid; }) || tendered === null || tendered < cartTotal()) { state.checkoutError = 'Check your quantities and enter enough cash to cover the total.'; renderCart(); return; }
      state.attempt = { uncertain: false, payload: { requestId: uuid(), items: lines.map(function (line) { return { productId: line.product.id, quantity: line.quantity }; }), tenderedCents: tendered }, snapshot: lines.map(function (line) { return { id: line.product.id, name: line.product.name, unitPriceCents: line.product.priceCents, quantity: line.quantity }; }) };
      saveAttempt();
    }
    if (!state.attempt) return;
    var previousUncertainty = state.attempt.uncertain;
    setBusy(true); state.checkoutError = ''; renderCart();
    try {
      var order = await api('/api/checkout', { method: 'POST', body: state.attempt.payload });
      clearAttempt(); state.cart.clear(); state.cash = ''; state.checkoutError = ''; state.notice = null;
      await afterMutation('Checkout saved. Your receipt is ready.');
      showReceipt(order);
    } catch (error) {
      if (error.uncertain || previousUncertainty) { state.attempt.uncertain = true; saveAttempt(); state.checkoutError = error.message; }
      else { clearAttempt(); state.checkoutError = error.message; }
      if (state.page === 'checkout' && state.dashboard) renderCart();
    } finally { setBusy(false); if (state.page === 'checkout' && state.dashboard) renderCart(); }
  }

  function renderInventory() {
    var activeCount = state.products.filter(function (entry) { return entry.active; }).length;
    $('pageContent').innerHTML = pageHeading('YOUR SHELVES', 'A place for every product.', 'Keep product details clear and stock counts up to date.', '<button class="button primary" data-action="add-product" data-write>' + icon('plus') + 'Add product</button>') +
      '<div class="card"><div class="filter-row"><div class="search-field">' + icon('search') + '<label class="visually-hidden" for="inventorySearch">Search inventory</label><input id="inventorySearch" type="search" placeholder="Search name, category, or SKU…" value="' + escape(state.inventorySearch) + '"></div><span class="inventory-summary">' + activeCount + ' active products</span><label class="visually-hidden" for="inventoryFilter">Inventory filter</label><select id="inventoryFilter"><option value="active">Active products</option><option value="low">Low stock</option><option value="archived">Archived</option><option value="all">All products</option></select></div><div id="inventoryRecords"></div></div>';
    $('inventoryFilter').value = state.inventoryFilter;
    renderInventoryRecords();
  }
  function renderInventoryRecords() {
    var matches = state.products.filter(function (entry) {
      return (state.inventoryFilter === 'all' || state.inventoryFilter === 'active' && entry.active ||
        state.inventoryFilter === 'archived' && !entry.active || state.inventoryFilter === 'low' && entry.active && entry.stock <= entry.reorderLevel) &&
        (entry.name + ' ' + entry.sku + ' ' + entry.category).toLowerCase().includes(state.inventorySearch.toLowerCase().trim());
    });
    $('inventoryRecords').innerHTML = matches.length ? '<div class="table-wrap"><table class="data-table inventory-table"><thead><tr><th>Product</th><th>Category</th><th>Unit price</th><th>Stock</th><th>Threshold</th><th>Status</th><th class="align-right">Actions</th></tr></thead><tbody>' +
      matches.map(function (entry) { return '<tr><td>' + productCell(entry) + '</td><td>' + escape(entry.category) + '</td><td>' + cash(entry.priceCents) + '</td><td><span class="stock-number' + (entry.stock <= entry.reorderLevel ? ' low' : '') + '">' + count(entry.stock) + '</span></td><td>' + count(entry.reorderLevel) + '</td><td><span class="status-tag ' + (entry.active ? 'fulfilled' : 'cancelled') + '">' + (entry.active ? 'Active' : 'Archived') + '</span></td><td class="align-right"><button class="text-button" data-action="edit-product" data-id="' + entry.id + '" data-write aria-label="Edit ' + escape(entry.name) + '">Edit</button> <button class="text-button" data-action="adjust-stock" data-id="' + entry.id + '" data-write aria-label="Adjust stock for ' + escape(entry.name) + '">Stock</button></td></tr>'; }).join('') +
      '</tbody></table></div><div class="card-header"><p>' + matches.length + ' matching products · Archive products to preserve order history.</p></div>' :
      empty('No matching products', 'Try another filter or add a fictional product to get started.');
    syncControls();
  }
  function openDialog(id, first) {
    closeDialog(true);
    state.focusReturn = document.activeElement;
    var dialog = $(id);
    dialog.showModal();
    document.body.classList.add('dialog-open');
    var control = first ? $(first) : dialog.querySelector('button,input');
    if (control) control.focus();
  }
  function closeDialog(force) {
    if (state.busy && !force) return;
    var open = document.querySelector('dialog[open]');
    if (open) open.close();
    document.body.classList.remove('dialog-open');
    if (state.focusReturn && state.focusReturn.isConnected) state.focusReturn.focus();
    state.focusReturn = null;
  }
  function editProduct(id) {
    if (blocked()) return;
    var entry = id ? product(id) : null;
    if (id && !entry) return;
    $('productForm').reset();
    $('productId').value = entry ? entry.id : '';
    $('productTitle').textContent = entry ? 'Edit product' : 'Add a product';
    $('productDescription').textContent = entry ? 'Keep the product details current. Use a stock correction to adjust units.' : 'Give your new product a place on the shelf.';
    $('productSku').value = entry ? entry.sku : '';
    $('productName').value = entry ? entry.name : '';
    $('productCategory').value = entry ? entry.category : '';
    $('productPrice').value = entry ? decimal(entry.priceCents) : '';
    $('productStock').value = entry ? entry.stock : 0;
    $('productStock').readOnly = Boolean(entry);
    $('stockHint').textContent = entry ? 'Use Stock to adjust counts with a recorded reason.' : 'Whole units, ready to sell.';
    $('productReorder').value = entry ? entry.reorderLevel : 5;
    $('productActive').checked = entry ? entry.active : true;
    $('categories').innerHTML = categories().map(function (category) { return '<option value="' + escape(category) + '"></option>'; }).join('');
    $('productError').hidden = true;
    openDialog('productDialog', 'productSku');
  }
  async function saveProduct() {
    if (blocked() || !$('productForm').reportValidity()) return;
    var price = parsePaisa($('productPrice').value), id = $('productId').value;
    if (price === null || price <= 0 || !integer($('productStock').value, 0, 1000000) || !integer($('productReorder').value, 0, 1000000)) {
      $('productError').textContent = 'Use a positive price with at most two decimal places and whole stock values between 0 and 1,000,000.';
      $('productError').hidden = false; return;
    }
    var payload = { sku: $('productSku').value.trim(), name: $('productName').value.trim(), category: $('productCategory').value.trim(), priceCents: price, stock: Number($('productStock').value), reorderLevel: Number($('productReorder').value), active: $('productActive').checked };
    if (!payload.name || !payload.category) { $('productError').textContent = 'Product name and category are required.'; $('productError').hidden = false; return; }
    setBusy(true); $('productError').hidden = true;
    try { await api('/api/products' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: payload }); closeDialog(true); await afterMutation(id ? 'Product updated.' : 'Product added to your inventory.'); }
    catch (error) { mutationError(error, 'productError'); }
    finally { setBusy(false); }
  }
  function openStock(id) {
    if (blocked()) return;
    var entry = product(id); if (!entry) return;
    $('stockForm').reset(); $('stockProductId').value = entry.id;
    $('stockProduct').textContent = entry.name + ' · ' + entry.stock + ' units on hand';
    $('stockError').hidden = true; openDialog('stockDialog', 'stockDelta');
  }
  async function saveStock() {
    if (blocked() || !$('stockForm').reportValidity()) return;
    var delta = $('stockDelta').value, reason = $('stockReason').value.trim();
    if (!integer(delta, -1000000, 1000000) || Number(delta) === 0 || !reason) {
      $('stockError').textContent = 'Enter a non-zero whole adjustment and a reason.'; $('stockError').hidden = false; return;
    }
    setBusy(true); $('stockError').hidden = true;
    try { await api('/api/products/' + $('stockProductId').value + '/stock', { method: 'POST', body: { delta: Number(delta), reason: reason } }); closeDialog(true); await afterMutation('Stock adjustment saved.'); }
    catch (error) { mutationError(error, 'stockError'); }
    finally { setBusy(false); }
  }
  function orderTable(orders, details) {
    if (!orders.length) return empty('Your counter is ready', 'Simulate a checkout to see your receipts and fulfillment queue.');
    return '<div class="table-wrap"><table class="data-table"><thead><tr><th>Order</th><th>Created</th><th>Items</th><th>Total</th><th>Status</th><th class="align-right">Receipt</th></tr></thead><tbody>' + orders.map(function (order) {
      var units = order.items.reduce(function (sum, line) { return sum + line.quantity; }, 0);
      return '<tr><td><span class="order-number">MD-' + String(order.id).padStart(5, '0') + '</span></td><td>' + escape(date(order.createdAt, true)) + '</td><td>' + units + ' units</td><td>' + cash(order.totalCents) + '</td><td>' + statusTag(order.status) + '</td><td class="align-right"><button class="text-button" data-action="receipt" data-id="' + order.id + '" aria-label="View receipt for order ' + order.id + '">View receipt ' + icon('arrow') + '</button></td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function renderOrders() {
    var pending = pendingOrders(), first = pending[0], latest = pending[pending.length - 1];
    var matches = state.orders.filter(function (order) { return state.orderFilter === 'all' || order.status === state.orderFilter; });
    $('pageContent').innerHTML = pageHeading('FROM COUNTER TO CUSTOMER', 'Every order, in order.', 'Review receipts, fulfill the queue, or undo the latest pending sale.', '') +
      '<div class="queue-grid"><article class="card queue-card"><span class="metric-icon">' + icon('receipt') + '</span><div><span class="eyebrow">QUEUE · FIRST IN, FIRST OUT</span><h2>' + (first ? 'Next up: MD-' + String(first.id).padStart(5, '0') : 'Your queue is clear') + '</h2><p>The oldest pending order is fulfilled first. Stock was already reserved at checkout.</p><button class="button primary" data-action="fulfill-order" data-write' + unavailable(!first) + '>Fulfill next order ' + icon('arrow') + '</button></div></article>' +
      '<article class="card queue-card"><span class="metric-icon">' + icon('undo') + '</span><div><span class="eyebrow">STACK · LAST IN, FIRST OUT</span><h2>' + (latest ? 'Latest: MD-' + String(latest.id).padStart(5, '0') : 'Nothing to undo') + '</h2><p>Cancel the newest pending order. Its reserved products return to stock in one transaction.</p><button class="button secondary" data-action="cancel-order" data-write' + unavailable(!latest) + '>Cancel latest pending</button></div></article></div>' +
      '<div class="card"><div class="card-header"><div><h2>Order history <span class="muted small">(' + state.orders.length + ')</span></h2><p>Receipts retain the product names and prices used at checkout.</p></div><div class="orders-toolbar"><label class="visually-hidden" for="orderFilter">Order status</label><select id="orderFilter"><option value="all">All statuses</option><option value="PENDING">Pending</option><option value="FULFILLED">Fulfilled</option><option value="CANCELLED">Cancelled</option></select></div></div>' + orderTable(matches, true) + '</div>';
    $('orderFilter').value = state.orderFilter;
  }
  function showReceipt(order) {
    $('receiptContent').innerHTML = '<header class="receipt-head"><img src="/mark.svg" alt=""><h2 id="receiptTitle">MarketDesk receipt</h2><p>Fictional local supermarket · Simulated cash</p>' + statusTag(order.status) + '</header><div class="receipt-meta"><strong>MD-' + String(order.id).padStart(5, '0') + '</strong><span>' + escape(date(order.createdAt, true)) + '</span></div><div class="receipt-lines">' +
      order.items.map(function (line) { return '<div class="receipt-line"><div><strong>' + escape(line.name) + '</strong><small>' + line.quantity + ' × ' + cash(line.unitPriceCents) + '</small></div><span>' + cash(line.lineTotalCents) + '</span></div>'; }).join('') +
      '</div><div class="receipt-totals"><div class="summary-line total"><span>Total</span><strong>' + cash(order.totalCents) + '</strong></div><div class="summary-line"><span>Cash received</span><strong>' + cash(order.tenderedCents) + '</strong></div><div class="summary-line"><span>Change</span><strong>' + cash(order.changeCents) + '</strong></div></div><p class="receipt-foot">No real payment was processed.<br>' + (order.status === 'CANCELLED' ? 'This order was cancelled and its stock restored.' : 'Thank you for exploring your local store workspace.') + '</p>';
    openDialog('receiptDialog');
  }
  async function fulfillNext() {
    if (blocked() || !pendingOrders().length) return;
    setBusy(true);
    try { var order = await api('/api/orders/fulfill-next', { method: 'POST' }); await afterMutation('Order MD-' + String(order.id).padStart(5, '0') + ' fulfilled.'); }
    catch (error) { mutationError(error); }
    finally { setBusy(false); }
  }
  function confirmCancellation() {
    if (blocked()) return;
    var pending = pendingOrders(), latest = pending[pending.length - 1]; if (!latest) return;
    $('confirmMessage').textContent = 'The latest pending order is MD-' + String(latest.id).padStart(5, '0') + ' for ' + cash(latest.totalCents) + '. Its items will be returned to inventory.';
    $('confirmError').hidden = true; openDialog('confirmDialog', 'confirmCancel');
  }
  async function cancelLatest() {
    if (blocked()) return;
    setBusy(true);
    try { var order = await api('/api/orders/cancel-last', { method: 'POST' }); closeDialog(true); await afterMutation('Order MD-' + String(order.id).padStart(5, '0') + ' cancelled and stock restored.'); }
    catch (error) { mutationError(error, 'confirmError'); }
    finally { setBusy(false); }
  }
  function closeNavigation() {
    $('workspace').classList.remove('nav-open'); $('navBackdrop').hidden = true;
    document.querySelector('[data-action="toggle-nav"]').setAttribute('aria-expanded', 'false');
  }
  function toggleNavigation() {
    var open = !$('workspace').classList.contains('nav-open');
    $('workspace').classList.toggle('nav-open', open); $('navBackdrop').hidden = !open;
    document.querySelector('[data-action="toggle-nav"]').setAttribute('aria-expanded', String(open));
    if (open) $('navigation').querySelector('[aria-current="page"]').focus();
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    var action = button.dataset.action, id = Number(button.dataset.id);
    if (action === 'navigate') setPage(button.dataset.page, true);
    else if (action === 'refresh') refreshWorkspace();
    else if (action === 'logout') logout();
    else if (action === 'dismiss-notice') { state.notice = null; renderNotice(); }
    else if (action === 'category') { state.category = button.dataset.category; renderCheckout(); }
    else if (action === 'cart-add') changeCart(id, 1);
    else if (action === 'cart-decrease') changeCart(id, -1);
    else if (action === 'cart-remove' && !blocked() && !state.attempt) { state.cart.delete(id); renderCatalog(); renderCart(); renderNavCounts(); }
    else if (action === 'retry-checkout') checkout(true);
    else if (action === 'add-product') editProduct();
    else if (action === 'edit-product') editProduct(id);
    else if (action === 'adjust-stock') openStock(id);
    else if (action === 'close-dialog') closeDialog();
    else if (action === 'receipt') { var order = state.orders.find(function (entry) { return entry.id === id; }); if (order) showReceipt(order); }
    else if (action === 'fulfill-order') fulfillNext();
    else if (action === 'cancel-order') confirmCancellation();
    else if (action === 'confirm-cancel-order') cancelLatest();
    else if (action === 'toggle-nav') toggleNavigation();
    else if (action === 'close-nav') closeNavigation();
    else if (action === 'low-stock') { state.inventoryFilter = 'low'; setPage('inventory', true); }
    else if (action === 'print') window.print();
  });
  document.addEventListener('input', function (event) {
    if (event.target.id === 'catalogSearch') { state.search = event.target.value; renderCatalog(); }
    if (event.target.id === 'inventorySearch') { state.inventorySearch = event.target.value; renderInventoryRecords(); }
    if (event.target.id === 'cashReceived') { state.cash = event.target.value; updateCash(); }
  });
  document.addEventListener('change', function (event) {
    if (event.target.id === 'inventoryFilter') { state.inventoryFilter = event.target.value; renderInventoryRecords(); }
    if (event.target.id === 'orderFilter') { state.orderFilter = event.target.value; renderOrders(); syncControls(); }
  });
  document.addEventListener('submit', function (event) {
    var id = event.target.id;
    if (!['loginForm', 'checkoutForm', 'productForm', 'stockForm'].includes(id)) return;
    event.preventDefault();
    if (id === 'loginForm' && event.target.reportValidity()) submitLogin();
    if (id === 'checkoutForm') checkout(false);
    if (id === 'productForm') saveProduct();
    if (id === 'stockForm') saveStock();
  });
  $('fillDemo').addEventListener('click', function () { $('username').value = 'admin'; $('password').value = 'DemoPass123!'; $('loginError').hidden = true; $('loginForm').querySelector('button[type="submit"]').focus(); });
  $('showPassword').addEventListener('click', function () { var reveal = $('password').type === 'password'; $('password').type = reveal ? 'text' : 'password'; $('showPassword').setAttribute('aria-label', reveal ? 'Hide password' : 'Show password'); });
  document.querySelectorAll('dialog').forEach(function (dialog) {
    dialog.addEventListener('cancel', function (event) { if (state.busy) event.preventDefault(); });
    dialog.addEventListener('close', function () { document.body.classList.remove('dialog-open'); if (state.focusReturn && state.focusReturn.isConnected) state.focusReturn.focus(); state.focusReturn = null; });
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && $('workspace').classList.contains('nav-open')) { closeNavigation(); document.querySelector('[data-action="toggle-nav"]').focus(); } });
  window.addEventListener('hashchange', function () { if (state.session && state.session.authenticated) setPage(location.hash.slice(1), false); });
  async function boot() {
    restoreAttempt();
    state.page = ['overview','checkout','inventory','orders'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    try {
      state.session = await api('/api/session');
      if (state.session.authenticated) await enterWorkspace(); else signedOut();
    } catch (error) { state.session = null; signedOut(error.message + ' You can retry using Sign in.'); }
  }
  boot();
})();
