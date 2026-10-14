const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const OTEL_COLLECTOR_URL = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4317';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'demo-app',
    [ATTR_SERVICE_VERSION]: '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'development'
  }),

  traceExporter: new OTLPTraceExporter({
    url: OTEL_COLLECTOR_URL
  }),

  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: OTEL_COLLECTOR_URL
    }),
    exportIntervalMillis: 10000
  }),

  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingPaths: ['/favicon.ico']
      },
      '@opentelemetry/instrumentation-fs': { enabled: false }
    })
  ]
});

sdk.start();
console.log('OpenTelemetry SDK initialized — sending metrics and traces to', OTEL_COLLECTOR_URL);

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OTel SDK shut down'))
    .catch((err) => console.error('OTel shutdown error', err))
    .finally(() => process.exit(0));
});
