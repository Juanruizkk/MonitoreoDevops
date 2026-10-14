# 501 — Full Observability Stack Project: Documentación

## Arquitectura general

```
  ┌──────────────┐
  │  Demo App    │  Node.js/Express :4000
  └──────┬───────┘
         │ OTLP gRPC :4317
         ▼
  ┌──────────────────┐
  │  OTel Collector  │  :4317 / :4318
  └──┬──────┬──────┬─┘
     │      │      │
     ▼      ▼      ▼
  ┌─────┐ ┌────┐ ┌─────┐
  │Prom │ │Loki│ │Tempo│
  │:9090│ │:3100│ │:3200│
  └──┬──┘ └──┬─┘ └──┬──┘
     └───────┴──────┘
                │
                ▼
  ┌─────────────────────┐
  │       Grafana        │  :3001
  └─────────────────────┘
         ▲
  ┌──────────────┐
  │ Alertmanager │  :9093
  └──────────────┘
```

**Flujo de datos por señal:**
```
Trazas:   App → OTLP gRPC → OTel Collector → Tempo
Métricas: App → OTLP gRPC → OTel Collector → expone :8889 → Prometheus scrapeá
Logs:     App → /var/log/demo-app/app.log → OTel Collector (filelog) → Loki
```

---

## Estructura de directorios

```
observability-capstone/
  app/
    package.json          ← dependencias Node.js
    server.js             ← app Express con métricas, logs y endpoints
    tracing.js            ← bootstrap OTel SDK (carga antes que server.js)
    Dockerfile            ← containerización
  otel/
    otel-collector-config.yml   ← config del Collector
  prometheus/
    prometheus.yml              ← scrape targets + alertmanager
    alert_rules.yml             ← reglas de alertas Golden Signals
  loki/
    loki-config.yml             ← config de Loki
  tempo/
    tempo-config.yml            ← config de Tempo
  grafana/
    provisioning/
      datasources/              ← datasources.yml (Prometheus, Loki, Tempo)
      dashboards/               ← provider.yml
      alerting/
      plugins/
      notifiers/
    dashboards/                 ← JSONs de dashboards
  alertmanager/
    alertmanager.yml            ← routing de notificaciones
```

---

## Step 1 — Arquitectura

7 servicios que se comunican sobre una red Docker compartida. Los nombres de servicio funcionan como hostnames (`otel-collector`, `prometheus`, `loki`, `tempo`, `grafana`, `alertmanager`).

---

## Step 2 — Demo App (`app/server.js`)

App Node.js/Express con tres endpoints:

| Endpoint | Descripción |
|---|---|
| `GET /api/health` | Estado de salud + uso de memoria |
| `GET /api/users` | Lista usuarios (simula query a DB) |
| `GET /api/orders` | Lista órdenes (simula query a DB, puede retornar 503) |
| `POST /api/webhook` | Receptor de notificaciones de Alertmanager |

**Métricas custom definidas en la app:**

| Métrica | Tipo | Descripción |
|---|---|---|
| `app_http_requests_total` | Counter | Total de requests HTTP |
| `app_http_request_duration_seconds` | Histogram | Duración de requests |
| `app_active_connections` | UpDownCounter | Conexiones activas |
| `app_memory_leak_bytes` | Observable Gauge | Bytes retenidos por el leak simulado |
| `app_heap_used_bytes` | Observable Gauge | Heap de Node.js en uso |

**Flags de simulación de incidentes (dormidos por defecto):**

```bash
SIMULATE_DB_LATENCY=true    # queries de 800-2000ms + 30% chance de 503 en /api/orders
SIMULATE_MEMORY_LEAK=true   # agrega ~1MB al leakyStore por cada request a /api/users
```

**Logging estructurado:**
- Escribe JSON a `/var/log/demo-app/app.log`
- Inyecta `trace_id` y `span_id` en cada línea → correlación log↔traza en Grafana
- El Collector lee ese archivo con el receiver `filelog`

---

## Step 3 — OTel SDK (`app/tracing.js`)

Se carga **antes** que `server.js` gracias al flag `--require` en `package.json`:
```json
"start": "node --require ./tracing.js server.js"
```

OTel usa monkey-patching — modifica módulos internamente para interceptar llamadas. Si los módulos se importan antes de que OTel esté inicializado, no pueden ser instrumentados.

**Configuración del SDK:**

```
Resource → identifica el servicio en todas las señales
  service.name = "demo-app"
  service.version = "1.0.0"
  deployment.environment = "development"

Trace exporter → OTLP gRPC → otel-collector:4317
Metric reader   → OTLP gRPC → otel-collector:4317 (cada 10 segundos)
```

**Auto-instrumentaciones activas:**
- HTTP: cada request/response genera un span automáticamente
- Express: cada route handler genera un span

**Instrumentación manual en server.js:**
- `tracer.startActiveSpan('db.query.users')` → span del query simulado
- Agrega visibilidad a nivel de operación, no solo de HTTP

**Patrón por lenguaje para cargar OTel primero:**

| Lenguaje | Cómo |
|---|---|
| Node.js | `--require ./tracing.js` |
| Python | `opentelemetry-instrument python app.py` |
| Java | `-javaagent:opentelemetry-javaagent.jar` |
| Go | Inicializar explícitamente en `main()` antes de todo |

---

## Step 4 — OTel Collector (`otel/otel-collector-config.yml`)

**Secciones del config:**

### Extensions
```yaml
health_check:
  endpoint: 0.0.0.0:13133   # health check para Docker y meta-monitoring
```

### Receivers

**`otlp`** — recibe trazas y métricas de la app:
```
grpc: :4317
http: :4318
```

**`filelog`** — lee los logs de la app desde disco:
```
include: /var/log/demo-app/*.log
operators:
  json_parser    → parsea cada línea JSON
  severity_parser → mapea "level" a severidades OTel
```

### Processors (orden importa — memory_limiter siempre primero)

| Processor | Qué hace |
|---|---|
| `memory_limiter` | Dropea datos si el Collector supera 256MB de RAM |
| `batch` | Agrupa hasta 1024 items o espera 5s antes de exportar |
| `attributes` | Agrega `loki.attribute.labels: service,level` para Loki |

**Por qué `memory_limiter` va primero:**
```
memory_limiter → batch    ✓  dropea antes de acumular
batch → memory_limiter    ✗  el batch acumuló demasiado antes de chequear
```

### Exporters

| Exporter | Destino | Modelo |
|---|---|---|
| `prometheus` | :8889 (Prometheus scrapeá) | Pull |
| `loki` | http://loki:3100/loki/api/v1/push | Push |
| `otlp/tempo` | tempo:4317 | Push gRPC |
| `debug` | stdout del Collector | - |

**`resource_to_telemetry_conversion: enabled: true`** — convierte atributos OTel (`service.name`, `deployment.environment`) en labels de Prometheus.

### Pipelines

```
traces:   [otlp] → [memory_limiter, batch] → [otlp/tempo, debug]
metrics:  [otlp] → [memory_limiter, batch] → [prometheus, debug]
logs:     [filelog] → [memory_limiter, attributes, batch] → [loki, debug]
```

Pipelines independientes — si Loki falla, trazas y métricas siguen funcionando.

### Loki labels — por qué no todo es label

```yaml
attributes:
  actions:
    - key: loki.attribute.labels
      value: service,level
```

Loki solo indexa labels — los demás campos van al body comprimido. Los labels deben ser valores acotados (service, level, environment). Usar `trace_id` como label explotaría la cardinalidad del índice.

```logql
{service="demo-app", level="error"}            # usa índice → rápido
{service="demo-app"} |= "pool exhausted"       # escanea body → más lento
```

---

## Step 5 — Prometheus (`prometheus/`)

### `prometheus.yml`

```yaml
scrape_interval: 10s
evaluation_interval: 10s   # evalúa las reglas de alerta cada 10s
```

**Scrape targets:**
```
otel-collector:8889   ← métricas de la app (via OTel Collector)
localhost:9090        ← Prometheus se auto-monitorea
```

La app no se scrapeá directamente — exporta por OTLP al Collector que expone el endpoint `:8889`.

**`rule_files`** — dónde están las reglas que Prometheus evalúa:
```yaml
rule_files:
  - /etc/prometheus/alert_rules.yml
```

**`alerting.alertmanagers`** — a quién enviar las alertas cuando disparan:
```yaml
alertmanagers:
  - static_configs:
      - targets: [alertmanager:9093]
```

Prometheus **detecta** la alerta, Alertmanager **notifica**. Son responsabilidades separadas.

### `alert_rules.yml` — Golden Signals

| Alerta | Señal | Condición | For |
|---|---|---|---|
| `HighErrorRate` | Errors | 5xx > 10% en 2min | 30s |
| `HighLatency` | Latency | P95 > 500ms en 2min | 30s |
| `HighMemoryUsage` | Saturation | leak gauge > 200MB | 1m |

**Regla del `rate()` con ventana mínima:**
```
scrape_interval = 10s → ventana mínima = 10s × 4 = 40s
Usamos [2m] → seguro y estable
```

---

## Step 6 — Loki (`loki/loki-config.yml`)

Loki indexa solo labels, no el contenido completo de los logs (a diferencia de Elasticsearch). Esto lo hace mucho más económico en storage.

**Storage:**
```
chunks_directory: /loki/chunks   ← logs comprimidos
rules_directory:  /loki/rules    ← reglas de alertas
```
En producción: S3 o GCS en vez de filesystem.

**Schema config:**
```yaml
store: tsdb      ← índice TSDB (eficiente para datos temporales)
schema: v13      ← versión más reciente
period: 24h      ← un archivo de índice por día
```

**Limits importantes:**
```yaml
allow_structured_metadata: true   ← guarda atributos OTel (trace_id, span_id)
volume_enabled: true              ← queries de volumen por label
reject_old_samples: true          ← rechaza logs > 7 días de antigüedad
```

`allow_structured_metadata` es lo que permite hacer click de log → traza en Grafana.

**TSDB en Loki** almacena solo el índice (qué chunk contiene qué logs para qué labels+timestamp). Los logs reales van comprimidos en los chunks. Las queries recientes son rápidas porque el índice activo es pequeño.

---

## Step 7 — Tempo (`tempo/tempo-config.yml`)

**Receivers:** acepta trazas via OTLP gRPC (:4317) y HTTP (:4318), igual que el OTel Collector.

**Flujo interno:**
```
OTel Collector → distributor (recibe spans)
                      ↓
                ingester (acumula en WAL, flush cada 5min)
                      ↓
                compactor (compacta, retiene 48h)
                      ↓
                metrics_generator → Prometheus (remote_write)
```

**metrics_generator — la feature más poderosa:**

Deriva métricas RED automáticamente desde las trazas entrantes, sin instrumentación adicional:

```
traces_spanmetrics_calls_total          ← Rate por operación
traces_spanmetrics_duration_seconds     ← Duration por operación
traces_service_graph_request_total      ← dependencias entre servicios
```

Processors activos:
- `span-metrics` → métricas RED por cada tipo de span
- `service-graphs` → mapa de dependencias entre servicios

**`send_exemplars: true`** — adjunta el `trace_id` a cada métrica enviada a Prometheus. Esto permite hacer click en un punto de un gráfico en Grafana y saltar directamente a la traza correspondiente.

**Storage local:**
```
wal:    /var/tempo/wal      ← Write-Ahead Log (datos recientes en memoria)
blocks: /var/tempo/blocks   ← bloques compactados (datos históricos)
```
Retención: 48 horas. En producción: object storage (S3, GCS).
