const fs = require('fs');
const path = require('path');
const express = require('express');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 4000;
app.use(express.json());

const logDir = '/var/log/demo-app';
fs.mkdirSync(logDir, { recursive: true });

// Structured logger written to a shared volume so the Collector can ingest it.
const logger = pino({
  level: 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
    log(obj) {
      const span = trace.getActiveSpan();
      if (span) {
        const ctx = span.spanContext();
        obj.trace_id = ctx.traceId;
        obj.span_id = ctx.spanId;
      }
      obj.service = 'demo-app';
      return obj;
    }
  }
}, pino.destination(path.join(logDir, 'app.log')));

// Custom metrics
const meter = metrics.getMeter('demo-app');
const requestCounter = meter.createCounter('app_http_requests_total', {
  description: 'Total HTTP requests'
});
const requestDuration = meter.createHistogram('app_http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  unit: 'seconds'
});
const activeConnections = meter.createUpDownCounter('app_active_connections', {
  description: 'Number of active connections'
});

// Simulated data stores
const users = [
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
  { id: 3, name: 'Charlie', email: 'charlie@example.com' }
];

const orders = [
  { id: 101, userId: 1, product: 'Widget', amount: 29.99, status: 'shipped' },
  { id: 102, userId: 2, product: 'Gadget', amount: 49.99, status: 'pending' },
  { id: 103, userId: 1, product: 'Doohickey', amount: 19.99, status: 'delivered' }
];

// Memory leak simulation
const leakyStore = [];
const memoryLeakBytes = meter.createObservableGauge('app_memory_leak_bytes', {
  description: 'Estimated bytes retained by the simulated leak'
});
const heapUsedBytes = meter.createObservableGauge('app_heap_used_bytes', {
  description: 'Node.js heap used in bytes'
});
meter.addBatchObservableCallback((observableResult) => {
  observableResult.observe(memoryLeakBytes, leakyStore.length * 1024);
  observableResult.observe(heapUsedBytes, process.memoryUsage().heapUsed);
}, [memoryLeakBytes, heapUsedBytes]);

// Middleware: track request metrics
app.use((req, res, next) => {
  const start = Date.now();
  activeConnections.add(1);

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    requestCounter.add(1, {
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode.toString()
    });
    requestDuration.record(duration, {
      method: req.method,
      route: req.route?.path || req.path
    });
    activeConnections.add(-1);

    logger.info({
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: Math.round(duration * 1000)
    }, 'request completed');
  });

  next();
});

// Simulate slow database query
async function simulateDbQuery(collection, queryMs = 5) {
  const tracer = trace.getTracer('demo-app');
  return tracer.startActiveSpan(`db.query.${collection}`, async (span) => {
    span.setAttribute('db.system', 'postgresql');
    span.setAttribute('db.collection', collection);

    let delay = queryMs;
    if (process.env.SIMULATE_DB_LATENCY === 'true') {
      delay = 800 + Math.random() * 1200; // 800-2000ms
      span.setAttribute('db.slow_query', true);
      logger.warn({ collection, delay_ms: Math.round(delay) }, 'slow database query detected');
    }

    await new Promise(resolve => setTimeout(resolve, delay));
    span.end();
  });
}

// GET /api/health
app.get('/api/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB'
    }
  });
});

// GET /api/users
app.get('/api/users', async (req, res) => {
  try {
    await simulateDbQuery('users');

    // Memory leak simulation
    if (process.env.SIMULATE_MEMORY_LEAK === 'true') {
      for (let i = 0; i < 1000; i++) {
        leakyStore.push({ data: Buffer.alloc(1024), ts: Date.now() });
      }
      logger.warn({ leaky_store_size: leakyStore.length }, 'memory allocation growing');
    }

    res.json({ users, count: users.length });
  } catch (err) {
    logger.error({ err: err.message }, 'failed to fetch users');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/webhook (receives Alertmanager notifications)
app.post('/api/webhook', (req, res) => {
  logger.info({ source: 'alertmanager' }, 'alert webhook received');
  res.json({ status: 'received' });
});

// GET /api/orders
app.get('/api/orders', async (req, res) => {
  const parentSpan = trace.getActiveSpan();
  try {
    await simulateDbQuery('orders');

    if (process.env.SIMULATE_DB_LATENCY === 'true' && Math.random() < 0.3) {
      const err = new Error('Connection pool exhausted');
      if (parentSpan) {
        parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        parentSpan.recordException(err);
      }
      logger.error({ err: err.message, endpoint: '/api/orders' }, 'database connection error');
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

    res.json({ orders, count: orders.length });
  } catch (err) {
    logger.error({ err: err.message }, 'failed to fetch orders');
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'demo app started');
});
