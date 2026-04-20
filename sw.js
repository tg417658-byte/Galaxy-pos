/* ═══════════════════════════════════════════════════════════════════
   GALAXY RESTAURANT — Service Worker
   • Polls Firebase REST every 5s in background
   • Strong vibration + notification when new order arrives
   • Vibration repeats 3 times so you always feel it
═══════════════════════════════════════════════════════════════════ */

var DB_URL     = 'https://galaxy-pos-3bbc7-default-rtdb.asia-southeast1.firebasedatabase.app';
var POLL_MS    = 5000;   // poll every 5 seconds
var _knownNums = null;
var _pollTimer = null;

/* ── Install ── */
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
    _knownNums = new Set(e.data.nums);
  }
  if (e.data.type === 'START_POLL') { startPolling(); }
  if (e.data.type === 'STOP_POLL')  {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }
});

/* ── Background polling every 5 seconds ── */
function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(pollOrders, POLL_MS);
  pollOrders();
}

function pollOrders() {
  var url = DB_URL + '/orders.json?t=' + Date.now();
  fetch(url).then(function(r) {
    if (!r.ok) return;
    return r.json();
  }).then(function(data) {
    if (!data) return;
    var orders = [];
    Object.keys(data).forEach(function(k) {
      if (data[k] && !data[k].init) orders.push(data[k]);
    });

    var pending = orders.filter(function(o) { return o.status === 'pending'; });
    var nums    = pending.map(function(o) { return o.orderNum; });

    // First run — just record known orders, don't alert
    if (_knownNums === null) {
      _knownNums = new Set(nums);
      broadcastToClients({ type: 'SW_KNOWN', nums: nums });
      return;
    }

    // Find genuinely new orders
    var newOrders = pending.filter(function(o) { return !_knownNums.has(o.orderNum); });
    newOrders.forEach(function(o) { _knownNums.add(o.orderNum); });

    if (newOrders.length === 0) return;

    // Tell main page (if open)
    broadcastToClients({ type: 'NEW_ORDERS', orders: newOrders, allPending: pending });

    // Show notification with strong vibration for each new order
    newOrders.forEach(function(o) {
      var title = '🔔 New Order! Table ' + o.tableNumber;
      var body  = (o.customerName ? o.customerName + ' • ' : '') +
                  (Array.isArray(o.items) ? o.items.length + ' item(s)' : '') +
                  ' • ₹' + (o.total || 0);

      // Strong vibration pattern: 3 rounds of buzz-pause-buzz
      // [vibrate, pause, vibrate, pause, vibrate, pause, long-buzz]
      var VIBRATE = [400,150,400,150,400,150,600];

      self.registration.showNotification(title, {
        body:               body,
        tag:                'order-' + o.orderNum,
        requireInteraction: true,   // stays on screen until tapped — gives more time to vibrate
        silent:             false,
        vibrate:            VIBRATE,
        renotify:           true,   // vibrate again even if same tag
        icon:               'https://api.dicebear.com/7.x/icons/svg?seed=galaxy',
        badge:              'https://api.dicebear.com/7.x/icons/svg?seed=galaxy',
        data:               { orderNum: o.orderNum, url: self.registration.scope + 'owner.html' }
      });

      // Repeat vibration 2 more times (at 3s and 6s) so you definitely feel it
      setTimeout(function() { triggerExtraVibration(o.orderNum, VIBRATE); }, 3000);
      setTimeout(function() { triggerExtraVibration(o.orderNum, VIBRATE); }, 6000);

      // Auto-close after 10 seconds (longer so vibration has time to repeat)
      setTimeout(function() {
        self.registration.getNotifications({ tag: 'order-' + o.orderNum }).then(function(notifs) {
          notifs.forEach(function(n) { n.close(); });
        });
      }, 10000);
    });
  }).catch(function() { /* ignore network errors */ });
}

/* ── Trigger extra vibration by updating existing notification ── */
function triggerExtraVibration(orderNum, vibrate) {
  self.registration.getNotifications({ tag: 'order-' + orderNum }).then(function(notifs) {
    if (!notifs.length) return; // already dismissed
    // Re-show same notification to re-trigger vibration
    var n = notifs[0];
    self.registration.showNotification(n.title, {
      body:               n.body,
      tag:                'order-' + orderNum,
      requireInteraction: true,
      silent:             false,
      vibrate:            vibrate,
      renotify:           true,
      icon:               n.icon,
      badge:              n.badge,
      data:               n.data
    });
  }).catch(function(){});
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

/* ── Fetch handler ── */
self.addEventListener('fetch', function(e) {
  if (e.request.url.indexOf(DB_URL) !== -1) return;
  if (e.request.method !== 'GET') return;
});
