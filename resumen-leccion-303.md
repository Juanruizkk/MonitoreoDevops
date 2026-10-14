# Resumen — Lección 303: Distributed Tracing with Grafana Tempo

## 1. Conceptos fundamentales

**El problema que resuelve:** con una sola app es fácil ver qué es lento. Con 5-10 microservicios, una request lenta puede originarse en cualquiera de ellos. Los logs y métricas te dicen *que* algo está lento, la traza te dice *exactamente dónde*.

**Trace vs Span:**
```
TRACE = el viaje completo de una request (un trace_id único)
SPAN  = una unidad de trabajo dentro de ese viaje
```

```
User → "Place Order"
│
├─ SPAN: api-gateway /checkout          [200ms total]
│   ├─ SPAN: order-api.createOrder      [150ms]
│   │   ├─ SPAN: postgres INSERT        [ 20ms]  ✓
│   │   └─ SPAN: payment-api.charge     [100ms]  ← BOTTLENECK
│   │       └─ SPAN: stripe-sdk.request [ 95ms]
│   └─ SPAN: notification.sendEmail     [ 30ms]  ✓
│
Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736
```

**Anatomía de un span:**

| Campo | Qué es |
|---|---|
| `trace_id` | ID único de toda la request |
| `span_id` | ID de este span particular |
| `parent_span_id` | Quién lo llamó (vacío en el root span) |
| `start_time` | Cuándo empezó |
| `duration` | Cuánto tardó |
| `service.name` | Qué servicio lo generó |
| `attributes` | Metadata extra (HTTP method, DB query, etc.) |

---

## 2. Context propagation

Cómo sabe el Servicio B que es parte del mismo trace que el Servicio A:

```
Service A  ──HTTP──>  Service B  ──gRPC──>  Service C
  │                     │                      │
Injects               Extracts               Extracts
traceparent            traceparent             traceparent
header                 header                  header
```

**W3C Trace Context header:**
```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │   │                                │                 │
           ver  trace_id (128 bits)          parent_span_id    flags (sampled)
```

El SDK de OTel maneja la propagación automáticamente. No hay código manual de propagación.

---

## 3. Stack — Tempo en Docker Compose

Tempo usa el patrón de override igual que Loki: `docker-compose.tracing.yml` se fusiona con el base al pasar múltiples `-f`.

**Para levantar el stack completo:**
```powershell
docker compose -f docker-compose.yml -f docker-compose.logging.yml -f docker-compose.tracing.yml up -d
```

**Archivos creados:**

| Archivo | Qué hace |
|---|---|
| `tempo/tempo-config.yml` | Config de Tempo: OTLP receivers, storage local, metrics_generator |
| `docker-compose.tracing.yml` | Servicio Tempo + Prometheus override + datasource de Grafana |
| `tempo/grafana-tempo-datasource.yml` | Provisioning automático del datasource en Grafana |
| `tempo/otel-collector-sampling.yml` | Config de referencia con tail sampling (no montada en el stack) |

**`metrics_generator`** — genera métricas de las trazas automáticamente (`service-graphs`, `span-metrics`) y las escribe en Prometheus via remote write. Así Grafana puede mostrar el Service Graph sin instrumentar nada extra.

Prometheus requiere el flag `--web.enable-remote-write-receiver` para aceptar esas escrituras — el override de tracing lo agrega automáticamente vía merge.

---

## 4. Cómo buscar trazas — tres métodos

### Método 1 — Grafana Explore UI
Grafana → Explore → datasource "Tempo" → query type "Search". Filtros visuales por Service Name, Duration, Status. Ideal para exploración sin saber TraceQL.

### Método 2 — TraceQL
El lenguaje de queries de Tempo. Inspirado en PromQL y LogQL.

```
{resource.service.name = "order-api" && duration > 500ms}
 │                                       │
 atributo del recurso                    intrínseco del span
```

**Tipos de filtros:**

| Tipo | Prefijo | Ejemplo |
|---|---|---|
| Recurso (el servicio) | `resource.` | `resource.service.name = "api"` |
| Span (la operación) | `span.` | `span.http.status_code >= 500` |
| Intrínsecos | sin prefijo | `duration > 1s`, `status = error` |

**Operador `>>` — query estructural:**
```
{resource.service.name = "api"} >> {resource.service.name = "db"}
```
"Dame trazas donde `api` llamó a `db`" — útil para detectar N+1 queries.

**Flujo recomendado — empezar broad y achicar:**
```
1. {resource.service.name = "demo-app"}
2. {resource.service.name = "demo-app"} | duration > 500ms
3. {resource.service.name = "demo-app" && status = error}
4. Entrás a un trace específico → waterfall
```

### Método 3 — HTTP API
```bash
curl -s http://localhost:3200/api/search \
  --data-urlencode 'q={resource.service.name="demo-app" && duration > 500ms}' \
  --data-urlencode "limit=20"
```

---

## 5. Leer un span waterfall

El waterfall es un **diagrama de Gantt** de la request. Tiempo corre izquierda → derecha, cada barra es un span, los hijos están anidados bajo el padre.

```
0ms    50ms   100ms  150ms  200ms  250ms  300ms
│
├──────────────────────────────────────────┤  api-gateway [310ms]  ← root span
│
│  ├───────────────────────────────┤          order-api [250ms]
│  │
│  │  ├──┤                                    postgres INSERT [15ms]  ✓
│  │
│  │     ├────────────────────────┤            payment-api [200ms]  ← BOTTLENECK
│  │     │
│  │     │  ├──────────────────┤               stripe-sdk [180ms]
│  │
│  │           ├───┤                            sendEmail [25ms]     ✓
```

**Los 5 patrones a identificar:**

| Patrón | Qué significa |
|---|---|
| Span más ancho | El cuello de botella — optimizá acá |
| Spans apilados verticalmente | Ejecución secuencial — ¿pueden paralelizarse? |
| Spans lado a lado | Ejecución paralela — ideal |
| Espacios en blanco | Tiempo no trazado — serialización, cola, código sin instrumentar |
| Spans rojos | Error — click → ver events → stack trace |

**Critical path:** la cadena más larga de spans secuenciales que determina la latencia total. Optimizar un span fuera del critical path no mejora la latencia total.

---

## 6. Custom span attributes en Node.js

La auto-instrumentación captura HTTP method, URL, status code, DB type. Los atributos custom agregan contexto de negocio.

```javascript
// 1. Atributo sobre el span de auto-instrumentación
const httpSpan = trace.getActiveSpan();
httpSpan?.setAttribute('user.id', userId);

// 2. Span hijo manual
tracer.startActiveSpan('processOrder', (span) => {
  span.setAttribute('order.id', orderId);
  span.setAttribute('order.category', category);
  span.setAttribute('order.item_count', itemCount);
  span.setAttribute('feature.new_checkout', true);

  // 3. Span event — como un log pegado al span
  span.addEvent('order_created', {
    'order.id': orderId,
    'payment.method': 'stripe'
  });

  span.end();  // crítico en Node.js — sin esto el span queda huérfano
});

// 4. Marcar error — span rojo en Tempo + stack trace adjunto
span?.recordException(new Error('Something went wrong'));
span?.setStatus({ code: SpanStatusCode.ERROR, message: '...' });
```

**Reglas:**
- Seguir OTel semantic conventions: dot-separated, lowercase (`user.id`, `order.total_usd`)
- Nunca PII en atributos — `user.id` sí, `user.email` no
- No poner request bodies completos — bloquea storage y ralentiza queries

---

## 7. Tail-based sampling

**Head vs Tail sampling:**

| | Head sampling | Tail sampling |
|---|---|---|
| **Cuándo decide** | Al inicio de la request | Al final, con todos los spans |
| **Qué puede ver** | Solo el primer span | Resultado completo (error, duración) |
| **Riesgo** | Descarta errores que no predijo | Necesita bufferear en memoria |

Con head sampling al 5% podrías descartar el 95% de los errores.

**Las 5 políticas (lógica OR — si cualquiera dice KEEP, se guarda):**

| Policy | Tipo | Qué guarda |
|---|---|---|
| `errors-policy` | `status_code` | 100% de trazas con error |
| `latency-policy` | `latency` | 100% de trazas > 2s |
| `critical-endpoints` | `string_attribute` | 100% de checkout/payment/login |
| `baseline-sampling` | `probabilistic` | 5% del tráfico sano restante |
| `rate-limit` | `rate_limiting` | Red de seguridad — máx 500 spans/seg |

**`decision_wait: 30s`** — Alertmanager espera 30s para acumular todos los spans antes de decidir. No bajar de 15s o los spans de servicios lentos llegan tarde y se pierden.

**Orden en el pipeline — crítico:**
```yaml
processors: [tail_sampling, batch]  # sampling SIEMPRE antes del batch
```

---

## 8. Flujo completo de debugging — de alerta a root cause

```
Métrica alerta → Tempo identifica → Waterfall localiza → Logs confirman
```

**Caso: p95 checkout latency > 3s**

```
1. Alerta Prometheus
   traces_spanmetrics_duration_bucket → p95 > 3s

2. TraceQL en Tempo
   {resource.service.name="order-api" && span.http.route="/api/checkout"} | duration > 3s
   → 47 trazas en 15 minutos

3. Waterfall
   api-gateway /checkout          [4200ms]
     └─ order-api createOrder     [4100ms]
         ├─ postgres INSERT          [ 15ms] ✓
         ├─ inventory-api check      [ 50ms] ✓
         └─ payment-api charge      [3900ms] ← acá
             └─ stripe-sdk request  [3850ms] ← causa raíz

4. Atributos del span lento
   stripe.retry_count: 3  ← sin este atributo custom no lo verías

5. Correlación con logs
   {service="payment-api"} | json | trace_id = "a1b2c3d4..."
   → "Stripe API timeout, retrying (attempt 2/3)"
   → "Stripe API timeout, retrying (attempt 3/3)"

6. Root cause
   3 reintentos × 1.2s = 3.8s total
   Stripe con timeouts intermitentes + sin circuit breaker

7. Action items
   - Reducir timeout de reintento 1s → 500ms
   - Agregar circuit breaker en payment-api
   - Considerar pagos asincrónicos
```

---

## 9. Los tres pilares juntos

| Señal | Pregunta que responde |
|---|---|
| **Prometheus** | "¿Hay un problema?" |
| **Tempo** | "¿En qué servicio y en qué operación?" |
| **Loki** | "¿Por qué exactamente?" |

```
Flujo de debugging:
  métricas alertan el problema
       │
  trazas muestran dónde está el bottleneck + trace_id
       │
  logs explican la causa raíz con contexto detallado
```

Ninguna señal sola alcanza. Los tres juntos permiten pasar de "hay un problema" a "esta línea de código es la causa" en minutos.

---

## 10. UIs y endpoints del stack completo

| Servicio | URL |
|---|---|
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Tempo | http://localhost:3200 |
| Alertmanager | http://localhost:9093 |
| App | http://localhost:4000 |

**Verificar que Tempo esté healthy:**
```powershell
curl http://localhost:3200/ready  # debe responder "ready"
```
