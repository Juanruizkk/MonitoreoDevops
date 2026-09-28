const crypto = require('crypto');

const traceId = crypto.randomBytes(16).toString('hex');
const service = 'order-api';

function log(level, msg, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service,
    msg,
    trace_id: traceId,
    span_id: crypto.randomBytes(8).toString('hex'),
    ...fields
  };
  console.log(JSON.stringify(entry));
  return entry;
}

console.log('=== SIMULATED APPLICATION LOGS ===\n');

log('info', 'Request received', { method: 'POST', path: '/api/orders', user_id: 'usr_42', request_id: 'req_001' });
log('info', 'Validating order payload', { order_items: 3, total_cents: 8997 });
log('debug', 'Cache lookup for user preferences', { cache_key: 'prefs:usr_42', cache_hit: true });
log('info', 'Processing payment', { provider: 'stripe', amount_cents: 8997 });
log('warn', 'Payment retry needed', { attempt: 1, reason: 'timeout', duration_ms: 3000 });
log('info', 'Payment succeeded on retry', { attempt: 2, duration_ms: 450, payment_id: 'pay_abc' });
log('info', 'Order created', { order_id: 'ord_789', duration_ms: 3650 });
log('info', 'Response sent', { status: 201, duration_ms: 3680 });

console.log('\n=== VERIFICATION CHECKLIST ===');
console.log('[ ] Every line is valid JSON');
console.log('[ ] Every line has: timestamp, level, service, msg, trace_id, span_id');
console.log('[ ] All logs share the same trace_id (single request)');
console.log('[ ] Each log has a unique span_id');
console.log('[ ] Error/warn logs include actionable context');
console.log('[ ] No sensitive data (passwords, tokens, PII) logged');
