const path = require('path');
const appDir = path.join(__dirname, '..', 'app');
const pino = require(require.resolve('pino', { paths: [appDir] }));

const logPath = path.join(appDir, 'logs', 'app.log');
const logger = pino({
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level(label) {
            return { level: label };
        }
    }
}, pino.destination(logPath));

// Application startup
logger.info({ port: 4000, env: 'production', service: 'demo-app' }, 'Server started');

// Request handling with trace context
logger.info({
    method: 'POST',
    path: '/api/orders',
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    span_id: '00f067aa0ba902b7',
    user_id: 'usr_123',
    request_id: 'req_abc',
    service: 'demo-app'
}, 'Request received');

// Error with context
logger.error({
    error: 'CONNECTION_TIMEOUT',
    db_host: 'postgres-primary',
    duration_ms: 5000,
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    span_id: '11a067bb1cb903c8',
    service: 'demo-app'
}, 'Database query failed');

logger.flush();
console.log(`Wrote structured logs to ${logPath}`);