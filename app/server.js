const express = require('express');
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');

// Lección 303 — Step 7: tracer para spans y atributos custom
const tracer = trace.getTracer('demo-app', '1.0.0');

const app = express();
const PORT = 4000;

app.use(express.json());

// === CUSTOM METRICS ===
const meter = metrics.getMeter('demo-app', '1.0.0');

// COUNTER: Total HTTP requests
const requestCounter = meter.createCounter('app_http_requests_total', {
  description: 'Total HTTP requests by method, endpoint, and status code',
});

// COUNTER: Business events
const ordersCounter = meter.createCounter('app_orders_processed_total', {
  description: 'Total orders processed by product category',
});

// GAUGE: Active connections (goes up and down)
const activeConnections = meter.createUpDownCounter('app_active_connections', {
  description: 'Number of currently active connections',
});

// HISTOGRAM: Custom request duration (in seconds)
const requestDuration = meter.createHistogram('app_http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  unit: 's',
  advice: {
    explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1.0],
  },
});

// === MIDDLEWARE: track active connections and duration ===
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

  // Atributos de negocio sobre el span HTTP que crea la auto-instrumentación
  const httpSpan = trace.getActiveSpan();
  httpSpan?.setAttribute('user.id', userId);

  // Span hijo manual: una unidad de trabajo propia con contexto de negocio
  tracer.startActiveSpan('processOrder', (span) => {
    const orderId = `ord_${Date.now()}`;
    const itemCount = Math.floor(Math.random() * 5) + 1;
    span.setAttribute('order.id', orderId);
    span.setAttribute('order.category', category);
    span.setAttribute('order.item_count', itemCount);
    span.setAttribute('feature.new_checkout', Math.random() < 0.5);

    // Evento: un "log" pegado al span
    span.addEvent('order_created', { 'order.id': orderId, 'payment.method': 'stripe' });

    ordersCounter.add(1, { product_category: category });
    requestCounter.add(1, { method: 'GET', endpoint: '/order', status_code: '200' });
    span.end(); // sin esto el span queda huérfano y nunca se exporta
    res.json({ order: 'placed', order_id: orderId, category, user_id: userId });
  });
});

app.get('/slow', (req, res) => {
  const delay = Math.floor(Math.random() * 1900) + 100;
  trace.getActiveSpan()?.setAttribute('app.simulated_delay_ms', delay);
  setTimeout(() => {
    requestCounter.add(1, { method: 'GET', endpoint: '/slow', status_code: '200' });
    res.json({ message: 'slow response', delay_ms: delay });
  }, delay);
});

app.post('/webhook', (req, res) => {
  requestCounter.add(1, { method: 'POST', endpoint: '/webhook', status_code: '200' });
  res.json({ status: 'received' });
});

app.get('/error', (req, res) => {
  requestCounter.add(1, { method: 'GET', endpoint: '/error', status_code: '500' });
  // Registrar la excepción como evento del span y marcarlo en rojo en Tempo
  const span = trace.getActiveSpan();
  span?.recordException(new Error('Something went wrong'));
  span?.setStatus({ code: SpanStatusCode.ERROR, message: 'Something went wrong' });
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`Demo app listening on http://localhost:${PORT}`);
});
