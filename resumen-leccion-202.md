# Resumen — Lección 202: Custom Metrics

## 1. Cuándo agregar métricas custom

### Auto-instrumentación vs métricas custom

La auto-instrumentación (lección 103) te da métricas HTTP **gratis**, sin tocar código. Pero solo ve lo técnico: requests que entran y salen. No sabe nada de **tu negocio**.

| | Auto-instrumentación | Métricas custom |
|---|---|---|
| **Qué captura** | La "forma" del tráfico HTTP | El "significado" del negocio |
| **Esfuerzo** | Cero código | Hay que escribirlas en la app |
| **Ejemplos** | Latencia de requests, requests en curso | Órdenes procesadas, cache hits, profundidad de cola, tiempo de pago |

Ejemplo: la auto-instrumentación sabe que hubo un `POST /checkout` que tardó 200ms. Pero no sabe si se creó una orden, si el pago fue aprobado o rechazado, o cuánto dinero se cobró. Eso solo lo sabe tu código.

### Lo que ya tenés (auto-instrumentación, lección 103)

```
http_server_request_duration_seconds  → Histogram de latencia de requests
http_server_active_requests           → Gauge de requests en curso
```

### Lo que vas a agregar en esta lección

| Métrica | Tipo | Qué mide |
|---------|------|----------|
| `app_http_requests_total` | Counter | Cantidad de requests con su status code |
| `app_orders_processed_total` | Counter | Evento de negocio: órdenes procesadas |
| `app_active_connections` | Gauge | Conexiones activas en el pool |
| `app_http_request_duration_seconds` | Histogram | Latencia medida por la app |

Se usan los tres tipos de métricas vistos en la lección 201 (ver sección 1 de ese resumen):
- **Counters** (`_total`) → cosas que solo suben: requests, órdenes
- **Gauge** → algo que sube y baja: conexiones activas
- **Histogram** → distribución de tiempos: latencia

`app_http_requests_total` es la métrica que usan las queries de **error rate** y **availability** de la lección 201 (sección 10).

### Cómo se crean: OTel Meter API

Las métricas custom se definen en el código con la **Meter API** de OpenTelemetry, que permite crear counters, gauges e histogramas.

Viajan por el **mismo pipeline** que las auto-instrumentadas, así que no hay que configurar nada nuevo en la infraestructura:

```
App (auto + custom) → OTel Collector → Prometheus → Grafana
```

### Reglas
- **Empezar siempre con auto-instrumentación.** Agregar métricas custom solo para lo que la auto-instrumentación **no puede ver**
- No duplicar lo que ya tenés gratis. Si solo necesitás latencia HTTP, `http_server_request_duration_seconds` ya alcanza
- Los conceptos son iguales en todos los lenguajes. En Python, por ejemplo, se puede usar el SDK de OpenTelemetry (mismo enfoque que acá) o la librería `prometheus_client`, que expone las métricas directamente a Prometheus sin pasar por el Collector

---

## 2. Convenciones de nombres de métricas

Seguir las convenciones de Prometheus hace que las métricas sean **consistentes**, **fáciles de encontrar** (el autocompletado de Grafana/Prometheus funciona mejor) y **compatibles** con dashboards y herramientas del ecosistema.

### Formato

```
<namespace>_<nombre>_<unidad>
    app    _http_request_duration_seconds
```

| Parte | Qué es | Ejemplo |
|-------|--------|---------|
| **namespace** | Prefijo que identifica de dónde viene la métrica | `app_`, `node_`, `prometheus_` |
| **nombre** | Qué se mide | `http_request_duration`, `orders_processed` |
| **unidad** | En qué se mide (en unidad base) | `_seconds`, `_bytes` |
| **sufijo** | Solo counters: `_total` | `_total` |

### Ejemplos buenos ✅

```
app_http_requests_total              # counter → termina en _total
app_http_request_duration_seconds    # histogram → incluye la unidad
app_orders_processed_total           # counter de negocio
app_active_connections               # gauge → SIN _total
app_cache_hits_total                 # counter
```

### Ejemplos malos ❌ y por qué

| Nombre malo | Problema | Corrección |
|-------------|----------|-----------|
| `requests` | Muy genérico, sin namespace. ¿Requests de qué servicio? | `app_http_requests_total` |
| `http_request_time_ms` | Usa milisegundos en vez de la unidad base | `app_http_request_duration_seconds` |
| `MyApp_Requests` | camelCase/PascalCase. Prometheus usa snake_case | `myapp_requests_total` |
| `app_queue_depth_total` | `_total` en un gauge (la cola sube y baja) | `app_queue_depth` |

### Las reglas

1. **snake_case**: todo en minúsculas, separado por guiones bajos
2. **Siempre con namespace** (`app_` para tu aplicación): evita choques con métricas de otros servicios. Si dos servicios exponen `requests_total`, no sabés cuál es cuál
3. **Counters terminan en `_total`**, gauges **no**. Así con solo ver el nombre sabés si hay que usar `rate()` (ver lección 201, sección 1)
4. **Unidades base**: `seconds` (no `ms`), `bytes` (no `kb`/`mb`). Grafana convierte automáticamente a la unidad más legible al mostrarlo (ej: `0.005 s` → `5 ms`)
5. **Las dimensiones van en labels, no en el nombre**

### Regla 5 en detalle: labels vs nombre

❌ Mal — una métrica por cada variante:
```
app_success_requests_total
app_error_requests_total
app_get_requests_total
app_post_requests_total
```

✅ Bien — una sola métrica con labels:
```
app_http_requests_total{status_code="200", method="GET"}
app_http_requests_total{status_code="500", method="POST"}
```

Con labels podés filtrar y agrupar como quieras con una sola query:
```promql
# Solo errores
sum(rate(app_http_requests_total{status_code=~"5.."}[5m]))

# Por método
sum by (method)(rate(app_http_requests_total[5m]))
```

Con nombres separados tendrías que sumar métricas distintas a mano, y cada variante nueva requeriría una métrica nueva.

### Conversión de nombres OTel → Prometheus

OpenTelemetry usa otra convención (puntos y la unidad como atributo aparte). El SDK / Collector **convierte automáticamente** al formato Prometheus al exportar:

```
OTel:        http.server.request.duration   (unidad: s)
Prometheus:  http_server_request_duration_seconds
```

- Los puntos se convierten en guiones bajos
- La unidad se agrega como sufijo (`s` → `_seconds`)
- A los counters se les agrega `_total`

Por eso las métricas auto-instrumentadas de la lección 103 ya tienen nombres con formato Prometheus.
