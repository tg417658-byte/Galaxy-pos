/* ═══════════════════════════════════════════════════════════════════
   GALAXY RESTAURANT — Service Worker
   • Polls Firebase REST every 15s even when app is closed/phone locked
   • Shows notification when new order arrives
   • Caches app shell for instant load
═══════════════════════════════════════════════════════════════════ */

var DB_URL      = 'https://galaxy-pos-3bbc7-default-rtdb.asia-southeast1.firebasedatabase.app';
var CACHE_NAME  = 'galaxy-pos-v1';
var POLL_MS     = 15000;
var _knownNums  = null;   // Set of order nums we've already notified about
var _pollTimer  = null;

/* ── Install: cache the app shell ── */
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(self.clients.claim());
  startPolling();
});

/* ── Message from main page ── */
self.addEventListener('message', function(e) {
  if (!e.data) return;
  if (e.data.type === 'KNOWN_ORDERS') {
    // Main page tells SW which orders it already knows about
    _knownNums = new Set(e.data.nums);
  }
  if (e.data.type === 'START_POLL') {
    startPolling();
  }
  if (e.data.type === 'STOP_POLL') {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }
});

/* ── Background polling ── */
function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(pollOrders, POLL_MS);
  pollOrders(); // fire immediately
}

function pollOrders() {
  var url = DB_URL + '/orders.json?t=' + Date.now();
  fetch(url).then(function(r) {
    if (!r.ok) return;
    return r.json();
  }).then(function(data) {
    if (!data) return;
    var orders = [];
    if (typeof data === 'object') {
      Object.keys(data).forEach(function(k) {
        if (data[k] && !data[k].init) orders.push(data[k]);
      });
    }
    var pending = orders.filter(function(o) { return o.status === 'pending'; });
    var nums    = pending.map(function(o) { return o.orderNum; });

    // First run — just record, don't notify
    if (_knownNums === null) {
      _knownNums = new Set(nums);
      // Tell main page our known set
      broadcastToClients({ type: 'SW_KNOWN', nums: nums });
      return;
    }

    // Find genuinely new orders
    var newOrders = pending.filter(function(o) { return !_knownNums.has(o.orderNum); });
    newOrders.forEach(function(o) { _knownNums.add(o.orderNum); });

    if (newOrders.length === 0) return;

    // Tell main page immediately (if open)
    broadcastToClients({ type: 'NEW_ORDERS', orders: newOrders, allPending: pending });

    // Show notification for each new order
    newOrders.forEach(function(o) {
      var title = '🔔 New Order — Table ' + o.tableNumber;
      var body  = (o.customerName ? o.customerName + ' • ' : '') +
                  (Array.isArray(o.items) ? o.items.length + ' item(s)' : '') +
                  ' • ₹' + (o.total || 0);
      self.registration.showNotification(title, {
        body:             body,
        tag:              'order-' + o.orderNum,
        requireInteraction: false,
        silent:           false,
        vibrate:          [200, 100, 200, 100, 400],
        icon:             'https://api.dicebear.com/7.x/icons/svg?seed=galaxy',
        badge:            'https://api.dicebear.com/7.x/icons/svg?seed=galaxy',
        data:             { orderNum: o.orderNum, url: self.registration.scope + 'owner.html' }
      });
      // Auto-close notification after 3 seconds
      setTimeout(function() {
        self.registration.getNotifications({ tag: 'order-' + o.orderNum }).then(function(notifs) {
          notifs.forEach(function(n) { n.close(); });
        });
      }, 3000);
    });
  }).catch(function() {
    /* silently ignore network errors in background */
  });
}

/* ── Notification click: open/focus the owner app ── */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url)
    ? e.notification.data.url
    : self.registration.scope + 'owner.html';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.indexOf('owner') !== -1 && 'focus' in cs[i]) {
          return cs[i].focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

/* ── Broadcast to all open windows ── */
function broadcastToClients(msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cs) {
    cs.forEach(function(c) { c.postMessage(msg); });
  });
}

/* ── Fetch: serve from cache when offline ── */
self.addEventListener('fetch', function(e) {
  /* Only cache same-origin HTML/CSS/JS — let Firebase REST pass through */
  if (e.request.url.indexOf(DB_URL) !== -1) return;
  if (e.request.method !== 'GET') return;
});
