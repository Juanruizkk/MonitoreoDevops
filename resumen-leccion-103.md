# Resumen — Lección 103: OpenTelemetry Fundamentals

## 1. Arquitectura OpenTelemetry

OpenTelemetry tiene tres componentes principales:

### OTel API
- Define las interfaces: `TracerProvider`, `MeterProvider`
- Las librerías de terceros (Express, pg, Redis) instrumentan contra la API
- No hace nada por sí sola — si no hay SDK instalado, tiene overhead cero

### OTel SDK
- Implementa la API
- Maneja batching, sampling y exportación de telemetría
- Se configura una sola vez al arrancar la aplicación
- Recibe automáticamente la instrumentación de librerías terceras

### OTel Collector
- Proceso independiente que recibe datos en formato OTLP
- Puede procesar, filtrar y reenviar telemetría a múltiples backends
- Desacopla la app de los backends — cambiar de Jaeger a Tempo no toca el código

**La separación API/SDK es clave:** los autores de librerías instrumentan contra la API liviana, los desarrolladores de apps instalan el SDK y configuran el destino.

---

## 2. Auto-instrumentación (monkey-patching)

Al cargar el SDK con `--require ./instrumentation.js` antes del código de la app, OTel parchea internamente las librerías populares antes de que se usen.

### Qué captura automáticamente:
| Librería | Qué instrumenta |
|----------|----------------|
| `http` | Requests entrantes y salientes |
| `express` | Rutas y handlers |
| `router` | Middleware |
| `pg`, `mysql`, `mongodb` | Queries a base de datos |
| `redis` | Comandos GET/SET/etc. |
| `grpc` | Llamadas entre microservicios |

### Qué genera sin escribir código:
- Un span por cada request HTTP
- Duración de cada request
- Status codes
- Rutas (`http.route`)
- Métricas del event loop de Node.js (`nodejs_eventloop_*`)
- Métricas del motor V8 (`v8js_*`)
- Métricas del proceso (`process_cpu_*`, `process_*memory*`)

### Regla importante:
El SDK debe cargarse **antes** que cualquier `require` de la app:
```bash
node --require ./instrumentation.js server.js
```

---

## 3. Puertos y flujo de datos

```
demo-app (puerto 4000)
    │
    │  OTLP/gRPC
    ▼
OTel Collector (puerto 4317)
    │
    ├──── métricas ──▶ :8889 (formato Prometheus)
    │                      │
    │                      │ scrape cada 15s
    │                      ▼
    │              Prometheus (:9090)
    │                      │
    │                      ▼
    │              Grafana (:3001)
    │
    └──── trazas ───▶ debug exporter (logs del Collector)
```

| Puerto | Componente | Función |
|--------|-----------|---------|
| 4000 | App Node.js | Recibe requests HTTP |
| 4317 | OTel Collector | Recibe telemetría OTLP/gRPC |
| 4318 | OTel Collector | Recibe telemetría OTLP/HTTP |
| 8889 | OTel Collector | Expone métricas en formato Prometheus |
| 9090 | Prometheus | UI y API de consultas |
| 3001 | Grafana | Dashboards |

### Qué es gRPC
Protocolo de comunicación binario creado por Google. Alternativa a REST/HTTP+JSON:
- Datos comprimidos (más liviano)
- Conexión persistente (no abre/cierra por cada envío)
- Bidireccional con soporte de streaming
- Ideal para telemetría de alto volumen

---

## 4. Trazas: estructura de un span

Cada request genera un árbol de spans conectados por `Trace ID` y `Parent ID`:

```
GET /users  (http — span raíz, sin Parent ID)
  └── middleware - patched  (router)
        └── request handler - /users  (express)
```

Cada span contiene:
- `Trace ID`: ID único de toda la traza
- `Parent ID`: span que lo originó (ausente en el span raíz)
- `Start time` / `End time`: duración exacta
- Atributos: `http.route`, `http.response.status_code`, `http.request.method`, etc.

---

## 5. Tipos de métricas en Prometheus

| Tipo | Comportamiento | Cómo consultar | Ejemplo |
|------|---------------|----------------|---------|
| **Counter** | Solo sube, reset en restart | Siempre con `rate()` | `http_server_request_duration_seconds_count` |
| **Gauge** | Sube y baja | Directo, sin `rate()` | `nodejs_eventloop_delay_mean_seconds` |
| **Histogram** | Distribuye en buckets | `histogram_quantile()` + `rate()` | `http_server_request_duration_seconds_bucket` |
| **Summary** | Percentiles pre-calculados | Directo | `nodejs_eventloop_delay_p99_seconds` |

**Regla:** nunca aplicar `rate()` a un Gauge, siempre aplicarlo a un Counter antes de graficar.

---

## 6. Queries PromQL esenciales

```promql
# Estado de targets (1 = activo, 0 = caído)
up

# Requests por segundo (últimos 5 minutos)
rate(http_server_request_duration_seconds_count[5m])

# Percentil 95 de latencia
histogram_quantile(0.95, rate(http_server_request_duration_seconds_bucket[5m]))

# Contar targets activos
count(up)
```

### Tip para curl con PromQL
Usar `--data-urlencode` para evitar errores de encoding con `{`, `}`, `"`:
```bash
curl -s -G 'http://localhost:9090/api/v1/query' \
  --data-urlencode 'query=http_server_request_duration_seconds_count{job="otel-collector"}'
```

---

## 7. Configuración del lab

### otel-collector.yml
```yaml
exporters:
  debug:
    verbosity: detailed  # "basic" solo loguea resumen mínimo
```

### instrumentation.js — compatibilidad con @opentelemetry/resources v2.x
```javascript
// v2.x — usar resourceFromAttributes, no new Resource()
const { resourceFromAttributes } = require('@opentelemetry/resources');

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'demo-app',
  [ATTR_SERVICE_VERSION]: '1.0.0',
});
```

---

## 8. Lab vs Producción

| Aspecto | Lab | Producción |
|---------|-----|-----------|
| Infraestructura | Docker Compose local | Kubernetes / servidores dedicados |
| Seguridad | Sin TLS, sin auth | TLS en todo, auth en Grafana/Prometheus |
| Collector | Único contenedor, escucha en `0.0.0.0` | Sidecar/DaemonSet, solo localhost |
| Almacenamiento | En memoria, efímero | Thanos/Mimir, retención de meses |
| Trazas | Debug exporter (solo logs) | Tempo o Jaeger para almacenar y consultar |
| Dashboards | Curl manual / UI | Infraestructura como código (Terraform, provisioning) |
| Alertas | Ninguna | Alertmanager → PagerDuty, Slack, etc. |

**Lo que es igual:** el SDK de OTel, el protocolo OTLP, las métricas de auto-instrumentación y la arquitectura conceptual.

---

## 9. Verificación del stack

```bash
# Estado de todos los servicios
curl -s -o /dev/null -w '%{http_code}' http://localhost:9090/-/healthy  # Prometheus
curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/health  # Grafana
curl -s -o /dev/null -w '%{http_code}' http://localhost:8889/metrics     # OTel Collector

# Ver spans en tiempo real
docker logs otel-collector --since 2m 2>&1

# Reiniciar el stack
docker compose up -d
docker compose restart otel-collector
```
