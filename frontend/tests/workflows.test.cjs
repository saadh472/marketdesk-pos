'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { JSDOM } = require('jsdom');
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const script = readFileSync(resolve(__dirname, '../app.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + description);
    await sleep(5);
  }
}
function fixture(options = {}) {
  const data = {
    authenticated: options.authenticated !== false, token: 'bootstrap-token',
    products: [{ id: 1, sku: 'GR-001', name: 'Demo Rice', category: 'Grocery', priceCents: 12550, stock: 2, reorderLevel: 1, active: true },
      { id: 2, sku: 'BE-001', name: 'Demo Juice', category: 'Beverages', priceCents: 10000, stock: 8, reorderLevel: 2, active: true }],
    orders: [], calls: [], checkoutLost: false, csrfRejected: false,
  };
  function dashboard() {
    const orders = data.orders.filter(order => order.status !== 'CANCELLED');
    return { productCount: data.products.filter(p => p.active).length, stockUnits: data.products.reduce((sum,p) => sum+p.stock,0),
      lowStockCount: data.products.filter(p => p.stock <= p.reorderLevel).length,
      salesCents: orders.reduce((sum,o) => sum+o.totalCents,0), orderCount: data.orders.length,
      pendingCount: data.orders.filter(o => o.status === 'PENDING').length, recentOrders: data.orders.slice().reverse().slice(0,5), topProducts: [],
      categoryCounts: [{ category: 'Grocery', count: 1 }, { category: 'Beverages', count: 1 }] };
  }
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const session = () => ({ authenticated: data.authenticated, csrfToken: data.token, user: data.authenticated ? { username: 'admin', displayName: 'Demo Manager' } : null });
  async function fetch(path, options) {
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
    data.calls.push({ path, method, body, csrf: options.headers['X-CSRF-TOKEN'], credentials: options.credentials });
    if (path === '/api/session') return response(session());
    if (method !== 'GET' && options.headers['X-CSRF-TOKEN'] !== data.token) return response({ message: 'Invalid CSRF token.' },403);
    if (path === '/api/login') {
      if (body.username !== 'admin' || body.password !== 'DemoPass123!') return response({ message: 'Invalid username or password.' },401);
      data.authenticated = true; data.token = 'signed-in-token'; return response(session());
    }
    if (!data.authenticated) return response({ message: 'Sign in to continue.' },401);
    if (path === '/api/logout') { data.authenticated = false; data.token = 'signed-out-token'; return response(session()); }
    if (path === '/api/products' && method === 'GET') return response(data.products);
    if (path === '/api/orders' && method === 'GET') return response(data.orders.slice().reverse());
    if (path === '/api/dashboard') return response(dashboard());
    if (path === '/api/products' && method === 'POST') {
      if (optionsForFixture.csrfOnce && !data.csrfRejected) { data.csrfRejected=true; data.token='refreshed-token'; return response({message:'Invalid CSRF token.'},403); }
      const product = { ...body, id: data.products.length+1 }; data.products.push(product); return response(product,201);
    }
    const update = path.match(/^\/api\/products\/(\d+)$/);
    if (update && method === 'PUT') { const p=data.products.find(p=>p.id===Number(update[1])); Object.assign(p,body); return response(p); }
    const stock = path.match(/^\/api\/products\/(\d+)\/stock$/);
    if (stock) { const p=data.products.find(p=>p.id===Number(stock[1])); p.stock+=body.delta; return response(p); }
    if (path === '/api/checkout') {
      const previous = data.orders.find(order => order.requestId === body.requestId);
      if (previous) return response(previous,201);
      const items=body.items.map(item=>{ const p=data.products.find(p=>p.id===item.productId); p.stock-=item.quantity; return {productId:p.id,name:p.name,quantity:item.quantity,unitPriceCents:p.priceCents,lineTotalCents:p.priceCents*item.quantity}; });
      const totalCents=items.reduce((sum,item)=>sum+item.lineTotalCents,0);
      const order={id:data.orders.length+1,createdAt:'2026-11-15T10:00:00Z',status:'PENDING',totalCents,tenderedCents:body.tenderedCents,changeCents:body.tenderedCents-totalCents,items,requestId:body.requestId};
      data.orders.push(order);
      if(optionsForFixture.loseCheckout && !data.checkoutLost) { data.checkoutLost=true; throw new TypeError('Network response lost after commit'); }
      return response(order,201);
    }
    if(path==='/api/orders/fulfill-next') { const order=data.orders.filter(o=>o.status==='PENDING').sort((a,b)=>a.id-b.id)[0]; order.status='FULFILLED'; return response(order); }
    if(path==='/api/orders/cancel-last') {
      const pending=data.orders.filter(o=>o.status==='PENDING').sort((a,b)=>a.id-b.id); const order=pending[pending.length-1]; order.status='CANCELLED';
      order.items.forEach(item=>data.products.find(p=>p.id===item.productId).stock+=item.quantity); return response(order);
    }
    throw new Error('Unexpected route ' + method + ' ' + path);
  }
  const optionsForFixture = options;
  return { data, fetch };
}
async function open(options = {}) {
  const fx=fixture(options);
  const errors=[];
  const dom=new JSDOM(html,{url:'http://127.0.0.1:8081/',runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window;
  win.fetch=fx.fetch; win.AbortController=AbortController;
  win.HTMLDialogElement.prototype.showModal=function(){ this.setAttribute('open',''); };
  win.HTMLDialogElement.prototype.close=function(){ this.removeAttribute('open'); this.dispatchEvent(new win.Event('close')); };
  win.addEventListener('error',event=>errors.push(event.error || event.message));
  if(options.saved) win.sessionStorage.setItem('marketdesk.pending-checkout.v1',options.saved);
  win.eval(script);
  await waitFor(()=>win.document.getElementById('boot').hidden,'initial session');
  if(fx.data.authenticated) await waitFor(()=>win.document.querySelector('[data-action="navigate"][data-page="checkout"]'),'workspace');
  function click(selector) { const element=win.document.querySelector(selector); assert.ok(element,'Missing '+selector); element.click(); }
  function value(id,text,event='input') { const input=win.document.getElementById(id); assert.ok(input,'Missing '+id); input.value=String(text); input.dispatchEvent(new win.Event(event,{bubbles:true})); }
  function submit(id) { const form=win.document.getElementById(id); form.dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true})); }
  return { ...fx,dom,win,doc:win.document,click,value,submit,errors,close(){ assert.deepEqual(errors,[]); dom.window.close(); } };
}
async function addBasket(app,productId=1) { app.click('[data-action="navigate"][data-page="checkout"]'); app.click('[data-action="cart-add"][data-id="'+productId+'"]'); }
async function createSale(app,productId=1) {
  await addBasket(app,productId); app.value('cashReceived','500.00'); app.submit('checkoutForm');
  await waitFor(()=>app.doc.getElementById('receiptDialog').open,'receipt'); app.click('#receiptDialog [data-action="close-dialog"]');
}
function fillProduct(app) {
  app.value('productSku','SN-003'); app.value('productName','Fictional Oats'); app.value('productCategory','Snacks');
  app.value('productPrice','123.45'); app.value('productStock','10'); app.value('productReorder','2');
}
test('anonymous sign-in uses session CSRF, rotates token, and signs out',async()=>{
  const app=await open({authenticated:false});
  try {
    assert.equal(app.doc.getElementById('loginScreen').hidden,false);
    app.click('#fillDemo'); app.submit('loginForm');
    await waitFor(()=>app.doc.getElementById('workspace').hidden===false && app.doc.querySelector('.metric-grid'),'login');
    const login=app.data.calls.find(call=>call.path==='/api/login'); assert.equal(login.csrf,'bootstrap-token'); assert.equal(login.credentials,'same-origin');
    app.click('[data-action="logout"]');
    await waitFor(()=>app.doc.getElementById('loginScreen').hidden===false,'signout');
    assert.equal(app.data.calls.find(call=>call.path==='/api/logout').csrf,'signed-in-token');
    assert.equal(app.doc.getElementById('password').value,'');
  } finally {app.close();}
});
test('checkout enforces stock limits and sends exact integer paisa',async()=>{
  const app=await open();
  try {
    await addBasket(app);
    app.click('.cart-controls [data-action="cart-add"]');
    assert.equal(app.doc.querySelector('.cart-controls [data-action="cart-add"]').disabled,true);
    app.value('cashReceived','250.99'); assert.equal(app.doc.getElementById('completeCheckout').disabled,true);
    assert.equal(app.doc.querySelector('.cart-controls [data-action="cart-add"]').disabled,true,'Cash input must not re-enable an exhausted stock control.');
    app.value('cashReceived','300.00'); assert.equal(app.doc.getElementById('completeCheckout').disabled,false);
    app.submit('checkoutForm'); await waitFor(()=>app.doc.getElementById('receiptDialog').open,'checkout receipt');
    const request=app.data.calls.find(call=>call.path==='/api/checkout');
    assert.equal(request.body.tenderedCents,30000); assert.deepEqual(request.body.items,[{productId:1,quantity:2}]);
    assert.equal(app.data.orders[0].totalCents,25100); assert.equal(app.data.orders[0].changeCents,4900);
    assert.match(app.doc.getElementById('receiptContent').textContent,/49\.00/);
  } finally {app.close();}
});
test('lost checkout response requires an explicit retry with the original request ID',async()=>{
  const app=await open({loseCheckout:true});
  try {
    await addBasket(app); app.value('cashReceived','500'); app.submit('checkoutForm');
    await waitFor(()=>app.doc.querySelector('[data-action="retry-checkout"]'),'unknown-result recovery');
    assert.equal(app.data.calls.filter(call=>call.path==='/api/checkout').length,1,'No automatic replay');
    assert.equal(app.doc.getElementById('cashReceived').disabled,true);
    const saved=JSON.parse(app.win.sessionStorage.getItem('marketdesk.pending-checkout.v1')); assert.ok(saved.uncertain);
    app.click('[data-action="retry-checkout"]'); await waitFor(()=>app.doc.getElementById('receiptDialog').open,'recovered receipt');
    const requests=app.data.calls.filter(call=>call.path==='/api/checkout');
    assert.deepEqual(requests[0].body,requests[1].body); assert.equal(app.data.orders.length,1); assert.equal(app.data.products[0].stock,1);
    assert.equal(app.win.sessionStorage.getItem('marketdesk.pending-checkout.v1'),null);
  } finally {app.close();}
});
test('product forms validate amounts and send only the accepted DTO fields',async()=>{
  const app=await open();
  try {
    app.click('[data-action="navigate"][data-page="inventory"]'); app.click('[data-action="add-product"]');
    fillProduct(app); app.value('productPrice','123.456'); app.submit('productForm'); await sleep(10);
    assert.equal(app.data.calls.filter(call=>call.path==='/api/products'&&call.method==='POST').length,0);
    app.value('productPrice','123.45'); app.submit('productForm');
    await waitFor(()=>app.data.products.length===3 && !app.doc.getElementById('productDialog').open,'create product');
    const body=app.data.calls.find(call=>call.path==='/api/products'&&call.method==='POST').body;
    assert.equal(body.priceCents,12345); assert.equal(body.stock,10); assert.equal(body.active,true); assert.equal('id' in body,false);
    app.click('[data-action="edit-product"][data-id="3"]'); assert.equal(app.doc.getElementById('productStock').readOnly,true);
    app.value('productName','Fictional Rolled Oats'); app.submit('productForm');
    await waitFor(()=>!app.doc.getElementById('productDialog').open,'edit product');
    assert.equal(app.data.products[2].name,'Fictional Rolled Oats');
    app.click('[data-action="adjust-stock"][data-id="3"]'); app.value('stockDelta','-2'); app.value('stockReason','Fictional count correction'); app.submit('stockForm');
    await waitFor(()=>!app.doc.getElementById('stockDialog').open,'stock correction');
    assert.equal(app.data.products[2].stock,8);
  } finally {app.close();}
});
test('CSRF refresh never automatically repeats a product write',async()=>{
  const app=await open({csrfOnce:true});
  try {
    app.click('[data-action="navigate"][data-page="inventory"]'); app.click('[data-action="add-product"]'); fillProduct(app); app.submit('productForm');
    await waitFor(()=>!app.doc.getElementById('productError').hidden,'CSRF error');
    assert.equal(app.data.calls.filter(c=>c.path==='/api/products'&&c.method==='POST').length,1);
    assert.equal(app.data.products.length,2); assert.match(app.doc.getElementById('productError').textContent,/session token changed/);
    app.submit('productForm'); await waitFor(()=>app.data.products.length===3,'explicit resubmission');
    assert.equal(app.data.calls.filter(c=>c.path==='/api/products'&&c.method==='POST')[1].csrf,'refreshed-token');
  } finally {app.close();}
});
test('order controls fulfill FIFO and confirm LIFO cancellation with stock restoration',async()=>{
  const app=await open();
  try {
    await createSale(app,1); await createSale(app,2);
    app.click('[data-action="navigate"][data-page="orders"]');
    assert.match(app.doc.getElementById('pageContent').textContent,/Next up: MD-00001/);
    assert.match(app.doc.getElementById('pageContent').textContent,/Latest: MD-00002/);
    app.click('[data-action="fulfill-order"]'); await waitFor(()=>app.data.orders[0].status==='FULFILLED'&&!app.doc.querySelector('[data-action="fulfill-order"]').disabled,'FIFO fulfillment');
    app.click('[data-action="cancel-order"]'); assert.equal(app.doc.getElementById('confirmDialog').open,true);
    assert.match(app.doc.getElementById('confirmMessage').textContent,/MD-00002/);
    app.click('#confirmCancel'); await waitFor(()=>app.data.orders[1].status==='CANCELLED'&&!app.doc.getElementById('confirmDialog').open,'LIFO cancellation');
    assert.equal(app.data.products[0].stock,1); assert.equal(app.data.products[1].stock,8);
    assert.equal(app.data.orders[0].status,'FULFILLED');
  } finally {app.close();}
});
test('search, category filters, archive filters, and escaped product names remain usable',async()=>{
  const app=await open();
  try {
    app.data.products[0].name='<img src=x onerror=alert(1)>'; app.data.products[1].active=false;
    app.click('[data-action="refresh"]'); await waitFor(()=>app.doc.querySelector('[data-action="refresh"]').disabled===false,'refresh');
    app.click('[data-action="navigate"][data-page="checkout"]');
    assert.equal(app.doc.querySelector('#catalogGrid img[src="x"]'),null); assert.match(app.doc.getElementById('catalogGrid').textContent,/<img src=x/);
    app.value('catalogSearch','not present'); assert.match(app.doc.getElementById('catalogGrid').textContent,/No products found/);
    app.click('[data-action="navigate"][data-page="inventory"]'); app.value('inventoryFilter','archived','change');
    assert.match(app.doc.getElementById('inventoryRecords').textContent,/Demo Juice/); assert.doesNotMatch(app.doc.getElementById('inventoryRecords').textContent,/<img src=x/);
  } finally {app.close();}
});
test('malformed saved checkout is discarded without preventing startup',async()=>{
  const app=await open({saved:'{"payload":{"requestId":"unsafe"},"snapshot":[]}'});
  try { assert.equal(app.win.sessionStorage.getItem('marketdesk.pending-checkout.v1'),null); assert.equal(app.doc.getElementById('workspace').hidden,false); }
  finally {app.close();}
});
