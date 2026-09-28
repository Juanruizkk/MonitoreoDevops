// Examples of meaningful vs noisy log fields

console.log('=== GOOD: Meaningful fields ===');
console.log(JSON.stringify({
  level: 'error',
  msg: 'Payment processing failed',
  user_id: 'usr_12345',
  order_id: 'ord_67890',
  amount_cents: 4999,
  currency: 'USD',
  payment_provider: 'stripe',
  error_code: 'card_declined',
  duration_ms: 1230,
  retry_count: 2,
  trace_id: 'abc123def456',
  request_id: 'req_xyz789'
}, null, 2));

console.log('\n=== BAD: Noisy or missing context ===');
console.log(JSON.stringify({
  level: 'error',
  msg: 'Payment failed for user'
}, null, 2));

console.log('\n=== FIELD GUIDELINES ===');
console.log('ALWAYS include: trace_id, request_id, user_id, service name');
console.log('FOR ERRORS: error_code, duration_ms, retry_count');
console.log('FOR REQUESTS: method, path, status_code, duration_ms');
console.log('AVOID: passwords, tokens, PII (full emails), large payloads');
