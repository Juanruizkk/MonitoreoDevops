const express = require('express');
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const pino = require('pino');
const path = require('path');

const tracer = trace.getTracer('demo-app', '1.0.0');

const app = express();
const PORT = 4000;

app.use(express.json());

// === STRUCTURED LOGGING ===
const logger = pino(
  {
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) { return { level: label }; },
    },
    base: { service: 'demo-app' },
  },
  pino.destination(path.join(__dirname, 'logs', 'app.log'))
);

// Helper: log con trace_id del span activo inyectado automáticamente
function getTraceContext() {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

// === CUSTOM METRICS ===
const meter = metrics.getMeter('demo-app', '1.0.0');

const requestCounter = meter.createCounter('app_http_requests_total', {
  description: 'Total HTTP requests by method, endpoint, and status code',
});

const ordersCounter = meter.createCounter('app_orders_processed_total', {
  description: 'Total orders processed by product category',
});

const activeConnections = meter.createUpDownCounter('app_active_connections', {
  description: 'Number of currently active connections',
});

const requestDuration = meter.createHistogram('app_http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  unit: 's',
  advice: {
    explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1.0],
  },
});

// === MIDDLEWARE ===
app.use((req, res, next) => {
  activeConnections.add(1);
  const start = Date.now();
  res.on('finish', () => {
    activeConnections.add(-1);
    const duration = (Date.now() - start) / 1000;
    requestDuration.record(duration, {
      method: req.method,
      endpoint: req.route ? req.route.path : req.path,
      status_code: String(res.statusCode),
    });
    logger.info(
      { ...getTraceContext(), method: req.method, path: req.path, status_code: res.statusCode, duration_ms: Math.round(duration * 1000) },
      'request completed'
    );
  });
  next();
});

// === ENDPOINTS ===

app.get('/', (req, res) => {
  requestCounter.add(1, { method: 'GET', endpoint: '/', status_code: '200' });
  res.json({ status: 'ok', service: 'demo-app' });
});

app.get('/users', (req, res) => {
  const delay = Math.floor(Math.random() * 100) + 10;
  setTimeout(() => {
    requestCounter.add(1, { method: 'GET', endpoint: '/users', status_code: '200' });
    res.json({ users: ['alice', 'bob', 'charlie'], latency_ms: delay });
  }, delay);
});

app.get('/order', (req, res) => {
  const categories = ['electronics', 'books', 'clothing', 'food'];
  const category = categories[Math.floor(Math.random() * categories.length)];
  const userId = req.query.user_id || `usr_${Math.floor(Math.random() * 100)}`;

  const httpSpan = trace.getActiveSpan();
  httpSpan?.setAttribute('user.id', userId);

  tracer.startActiveSpan('processOrder', (span) => {
    const orderId = `ord_${Date.now()}`;
    const itemCount = Math.floor(Math.random() * 5) + 1;
    span.setAttribute('order.id', orderId);
    span.setAttribute('order.category', category);
    span.setAttribute('order.item_count', itemCount);
    span.setAttribute('feature.new_checkout', Math.random() < 0.5);
    span.addEvent('order_created', { 'order.id': orderId, 'payment.method': 'stripe' });

    logger.info(
      { ...getTraceContext(), order_id: orderId, category, user_id: userId, item_count: itemCount },
      'order processed'
    );

    ordersCounter.add(1, { product_category: category });
    requestCounter.add(1, { method: 'GET', endpoint: '/order', status_code: '200' });
    span.end();
    res.json({ order: 'placed', order_id: orderId, category, user_id: userId });
  });
});

app.get('/slow', (req, res) => {
  const delay = Math.floor(Math.random() * 1900) + 100;
  trace.getActiveSpan()?.setAttribute('app.simulated_delay_ms', delay);
  setTimeout(() => {
    requestCounter.add(1, { method: 'GET', endpoint: '/slow', status_code: '200' });
    logger.warn({ ...getTraceContext(), delay_ms: delay }, 'slow response detected');
    res.json({ message: 'slow response', delay_ms: delay });
  }, delay);
});

app.post('/webhook', (req, res) => {
  requestCounter.add(1, { method: 'POST', endpoint: '/webhook', status_code: '200' });
  logger.info({ ...getTraceContext() }, 'webhook received');
  res.json({ status: 'received' });
});

app.get('/error', (req, res) => {
  requestCounter.add(1, { method: 'GET', endpoint: '/error', status_code: '500' });
  const span = trace.getActiveSpan();
  const err = new Error('Something went wrong');
  span?.recordException(err);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  logger.error({ ...getTraceContext(), error: err.message }, 'request failed');
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Demo app started');
  console.log(`Demo app listening on http://localhost:${PORT}`);
});
