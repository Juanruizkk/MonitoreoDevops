# Resumen — Lección 201: PromQL Queries & Metric Types

## 1. Instant vector vs Range vector

Dos tipos fundamentales de datos en PromQL:

| Tipo | Sintaxis | Resultado | Uso |
|------|----------|-----------|-----|
| **Instant vector** | `up` | Un valor por serie ahora mismo | Graficar, alertas |
| **Range vector** | `up[5m]` | Lista de muestras en el tiempo | Input para funciones |

### Regla clave
Un range vector **no se puede graficar directamente**. Siempre hay que pasarlo por una función primero.

```promql
# ERROR — no se puede graficar
up[5m]

# BIEN — rate() procesa la lista y devuelve un solo número
rate(http_server_request_duration_seconds_count[5m])
```

Si Grafana muestra `parse error: expected type instant vector` es porque estás intentando graficar un range vector directo.

---

## 2. Selectors y matchers

Cada serie en Prometheus se identifica por su nombre más su conjunto de labels. Los matchers filtran series por sus labels.

| Operador | Significado | Ejemplo |
|----------|-------------|---------|
| `=` | Igual exacto | `{code="200"}` |
| `!=` | Distinto | `{code!="400"}` |
| `=~` | Regex | `{handler=~"/api/.*"}` |
| `!~` | No regex | `{code!~"5.."}` |

```promql
# Solo requests con código 200
prometheus_http_requests_total{code="200"}

# Excluir errores 5xx
prometheus_http_requests_total{code!~"5.."}

# Todos los endpoints de la API
prometheus_http_requests_total{handler=~"/api/.*"}

# Combinar múltiples matchers
prometheus_http_requests_total{code="200", handler="/metrics"}
```

### Tips
- Los regex usan sintaxis RE2 y deben coincidir con el valor completo del label (no substring)
- `metric{}` con llaves vacías selecciona explícitamente todas las labels
- `{__name__=~"prometheus_.*"}` selecciona todas las métricas que empiecen con `prometheus_`

---

## 3. rate(), irate() e increase() para counters

Los counters solo suben (o se resetean a cero al reiniciar). Estas funciones convierten ese valor acumulado en algo útil.

| Función | Cómo calcula | Cuándo usarla |
|---------|-------------|---------------|
| `rate()` | Promedio suavizado sobre toda la ventana | Dashboards y alertas |
| `irate()` | Solo los últimos dos puntos | Ver spikes en tiempo real |
| `increase()` | Total de incremento en la ventana | "Cuántos requests en 1h" |

```promql
# Requests por segundo (promedio suavizado de 5 min)
rate(prometheus_http_requests_total[5m])

# Requests por segundo instantáneo (más ruidoso)
irate(prometheus_http_requests_total[5m])

# Total de requests en la última hora
increase(prometheus_http_requests_total[1h])
```

### Reglas importantes
- **Nunca** usar `rate()` sobre un Gauge — solo sobre Counters
- La ventana `[Xm]` debería ser al menos 4 veces el scrape interval para tolerar scrapes perdidos (ej: scrape cada 15s → ventana mínima `[1m]`)
- `increase()` es equivalente a `rate() * duración_de_ventana_en_segundos`

---

## 4. Aggregation operators

Agregan múltiples series en una sola usando `by` o `without`.

```promql
# Suma de requests por handler (descarta todas las demás labels)
sum by (handler)(rate(prometheus_http_requests_total[5m]))

# Promedio de latencia por instancia
avg by (instance)(http_server_request_duration_seconds)

# Máximo de uso de CPU en todos los nodos
max(node_cpu_seconds_total)
```

### Salida real del lab

Al correr `sum by (handler)(rate(prometheus_http_requests_total[5m]))`:

```
{handler="/api/v1/query_range"}  → 0.098 req/s   ← Grafana renderizando gráficos
{handler="/metrics"}             → 0.067 req/s   ← Prometheus scrapeándose a sí mismo
{handler="/api/v1/query"}        → 0.011 req/s   ← queries manuales
{handler="/api/v1/series"}       → 0.003 req/s   ← Grafana descubriendo métricas
(todos los demás)                → 0             ← sin tráfico activo
```

Los valores reflejan qué endpoints están recibiendo tráfico real en este momento.

---

## 5. Binary operators y label matching

Combinan dos instant vectors con operadores aritméticos (`+`, `-`, `*`, `/`) o de comparación (`>`, `<`, `==`).

```promql
# Error rate en porcentaje
sum(rate(http_requests_total{status=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m]))
* 100

# Porcentaje de memoria usada
(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)
/ node_memory_MemTotal_bytes * 100
```

### El problema: los labels deben coincidir

Cuando dos métricas tienen label sets distintos, Prometheus no sabe cómo emparejarlas. Para eso existen los modificadores:

| Modificador | Comportamiento |
|-------------|----------------|
| `on(labels)` | Solo usar ESTOS labels para emparejar (como JOIN con clave) |
| `ignoring(labels)` | Emparejar con todo excepto ESTOS labels |
| `group_left` | Un elemento de la derecha puede emparejarse con muchos de la izquierda |
| `group_right` | Un elemento de la izquierda puede emparejarse con muchos de la derecha |

```promql
# Emparejar solo por "instance"
metric_a / on(instance) metric_b

# Emparejar ignorando el label "status"
metric_a / ignoring(status) metric_b

# Join uno a muchos (como SQL LEFT JOIN)
metric_a * on(instance) group_left metric_b
```

### Cuándo no necesitás modificadores

Si usás `sum()` sin `by()` antes de dividir, reducís todo a un solo número en cada lado y no hay ambigüedad:

```promql
# Funciona sin on() ni ignoring() porque sum() ya eliminó todos los labels
sum(rate(errores[5m])) / sum(rate(total[5m])) * 100
```

---

## 6. Queries de producción esenciales

```promql
# Requests por segundo por endpoint
sum by (handler)(rate(http_server_requests_total[5m]))

# Percentil 95 de latencia
histogram_quantile(0.95, rate(http_server_request_duration_seconds_bucket[5m]))

# Error rate (%)
sum(rate(http_requests_total{status=~"5.."}[5m]))
/ sum(rate(http_requests_total[5m])) * 100

# Porcentaje de responses 200 de Prometheus
sum(prometheus_http_requests_total{code="200"})
/ sum(prometheus_http_requests_total) * 100
```

---

## 7. Referencia rápida de funciones

| Función | Input | Output | Uso típico |
|---------|-------|--------|-----------|
| `rate()` | Counter range vector | req/s suavizado | Dashboards, alertas |
| `irate()` | Counter range vector | req/s instantáneo | Ver spikes |
| `increase()` | Counter range vector | Total en ventana | "Cuántos en 1h" |
| `sum by()` | Instant vector | Agrupado | Agrupar por label |
| `histogram_quantile()` | Histogram buckets | Percentil | P95, P99 de latencia |
