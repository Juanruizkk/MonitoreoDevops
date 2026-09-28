// Simulating OTel context propagation for logging
// In a real app, @opentelemetry/api provides this automatically

const { randomBytes } = require('crypto');

// Simulate OTel context
const traceContext = {
  traceId: randomBytes(16).toString('hex'),
  spanId: randomBytes(8).toString('hex')
};

// Logger that auto-injects trace context
function createContextLogger(baseContext) {
  return {
    info: (fields, msg) => console.log(JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      msg,
      trace_id: baseContext.traceId,
      span_id: baseContext.spanId,
      ...fields
    })),
    error: (fields, msg) => console.log(JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      msg,
      trace_id: baseContext.traceId,
      span_id: baseContext.spanId,
      ...fields
    }))
  };
}

// Every log automatically includes trace context
const logger = createContextLogger(traceContext);

logger.info({ step: 'auth' }, 'Validating user token');
logger.info({ step: 'db', query: 'SELECT * FROM orders' }, 'Executing query');
logger.error({ step: 'db', error: 'TIMEOUT' }, 'Query failed after 5s');
logger.info({ step: 'response', status: 500 }, 'Returning error response');

console.log('\n--- All 4 logs share the same trace_id ---');
console.log('--- This lets you find every log for one request ---');
