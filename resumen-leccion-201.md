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

### Tipos de métricas: Counter vs Gauge

Antes de escribir una query hay que saber qué tipo de métrica es, porque eso define cómo se consulta. Usando un auto como analogía:

| Tipo | En el auto | Comportamiento |
|---|---|---|
| **Counter** | Cuentakilómetros | Solo sube (o vuelve a 0 si la app se reinicia). Te dice el total acumulado |
| **Gauge** | Tanque de nafta | Sube y baja. Te dice cuánto hay **ahora** |

El valor de un gauge **ya tiene sentido por sí solo** ("tengo medio tanque"). El de un counter no ("llevo 50.000 km" no dice a qué velocidad vas).

**Ejemplos de gauges:**
- Memoria usada / disponible
- Temperatura de la CPU
- Requests en curso (procesándose ahora mismo)
- Conexiones abiertas a la base de datos
- Espacio libre en disco
- Cantidad de pods corriendo

**Ejemplos de counters:**
- Requests totales recibidos
- Errores totales
- Bytes enviados en total
- Segundos de CPU usados en total

> Pista: los counters suelen terminar en `_total` (ej: `prometheus_http_requests_total`).

**Cómo se consulta cada uno:**

```promql
# Counter → necesita rate() para convertir el total en velocidad
rate(http_requests_total[5m])        # requests por segundo

# Gauge → se usa directo
node_memory_MemAvailable_bytes       # memoria disponible ahora

# Gauge en el tiempo → funciones *_over_time() (ver sección 9)
max_over_time(node_memory_Active_bytes[1h])   # pico de memoria en la última hora
avg_over_time(node_memory_Active_bytes[1h])   # promedio en la última hora
```

**Regla clave:** nunca usar `rate()` sobre un gauge. `rate()` asume que el valor solo sube, así que cuando un gauge baja (ej: se libera memoria) lo interpreta como un reinicio del contador y da resultados sin sentido.

```
Counter  →  solo sube     →  "¿cuántos en total?"   →  usar rate()
Gauge    →  sube y baja   →  "¿cuánto hay ahora?"   →  usar directo o *_over_time()
```

> Hay un tercer tipo, el **Histogram**, que en realidad es un conjunto de counters (`_bucket`, `_count`, `_sum`). Se ve en la sección 7.

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

## 7. histogram_quantile() para percentiles

Los histogramas son la forma preferida de medir latencia en Prometheus. `histogram_quantile()` calcula percentiles (p50, p95, p99) a partir de los buckets.

### Estructura de un histograma

Cada bucket cuenta las observaciones **menores o iguales** a su límite `le` (less-than-or-equal). Los buckets son **acumulativos**.

```
http_server_request_duration_seconds_bucket{le="0.005"}  → cantidad <= 5ms
http_server_request_duration_seconds_bucket{le="0.01"}   → cantidad <= 10ms
http_server_request_duration_seconds_bucket{le="0.025"}  → cantidad <= 25ms
http_server_request_duration_seconds_bucket{le="0.05"}   → cantidad <= 50ms
http_server_request_duration_seconds_bucket{le="0.1"}    → cantidad <= 100ms
http_server_request_duration_seconds_bucket{le="+Inf"}   → total de requests
```

`histogram_quantile()` **interpola** entre buckets para estimar el valor del percentil (es una estimación, no un valor exacto).

### Calcular percentiles

```promql
# p99 de latencia de la demo app
histogram_quantile(0.99, rate(http_server_request_duration_seconds_bucket[5m]))

# p50 global agregando todas las instancias
histogram_quantile(0.50, sum by (le)(rate(http_server_request_duration_seconds_bucket[5m])))
```

### Probarlo en vivo (p95 de la demo app)

```bash
curl -s 'http://localhost:9090/api/v1/query?query=histogram_quantile(0.95,sum%20by(le)(rate(http_server_request_duration_seconds_bucket[5m])))' | jq '.data.result'
```

Devuelve el p95 en **segundos** — típicamente un número chico como `0.005` (5ms) para un servidor Express simple.

La métrica `http_server_request_duration_seconds` viene de la auto-instrumentación OTel de la demo app.

### Reglas importantes
- **Siempre** aplicar `rate()` a los buckets primero
- **CRÍTICO:** al agregar histogramas, **siempre conservar el label `le`**: `sum by (le)(...)`. Sin `le`, `histogram_quantile()` no puede reconstruir los buckets
- Elegir los límites de los buckets según tus SLOs — ej: si el SLO es p99 < 500ms, tener buckets en `0.1`, `0.25`, `0.5`, `1.0`
- `histogram_quantile(0.99, ...)` significa que el 99% de los requests son más rápidos que ese valor

---

## 8. Vector matching y group modifiers (en profundidad)

Cuando hacés una operación entre dos vectores (`A / B`), Prometheus tiene que decidir **qué serie de la izquierda va con qué serie de la derecha**. Lo hace comparando labels. Esto es como un JOIN en SQL, donde los labels son la clave.

### 8.1 One-to-one (uno a uno) — el comportamiento por defecto

Cada serie de la izquierda se empareja con **exactamente una** de la derecha que tenga los mismos labels.

```promql
# Error rate por endpoint
sum by (handler)(rate(prometheus_http_requests_total{code="500"}[5m]))
  / on(handler)
sum by (handler)(rate(prometheus_http_requests_total[5m]))
```

Cómo funciona paso a paso:

```
Izquierda (errores 500)          Derecha (total)
{handler="/api/v1/query"} 0.02   {handler="/api/v1/query"} 0.5    → 0.02 / 0.5 = 0.04 (4%)
{handler="/metrics"}      0.01   {handler="/metrics"}      0.1    → 0.01 / 0.1 = 0.1  (10%)
                                 {handler="/api/v1/series"} 0.3   → sin pareja → NO aparece
```

- `on(handler)` dice "emparejá usando solo el label `handler`"
- Acá técnicamente `on()` no hace falta porque ambos lados ya quedaron solo con `handler` gracias al `sum by (handler)`, pero hacerlo explícito es buena práctica
- **Ojo:** si un handler no tiene ningún error 500, no aparece del lado izquierdo, así que **desaparece del resultado** (no muestra 0). Las series sin pareja se descartan

### 8.2 Many-to-one con `group_left` — enriquecer métricas con labels

Pasa cuando **varias series de la izquierda** tienen que emparejarse con **una sola de la derecha**. Sin `group_left`, Prometheus tira error (`many-to-many matching not allowed` / `multiple matches for labels`).

El caso típico: las **info metrics**. Son métricas cuyo valor es siempre `1` y existen solo para cargar labels de metadata.

```
# Izquierda: varias series por instancia (una por filesystem)
node_filesystem_avail_bytes{instance="srv1", mountpoint="/"}      50GB
node_filesystem_avail_bytes{instance="srv1", mountpoint="/data"}  200GB

# Derecha: una sola serie por instancia, valor = 1
machine_role_info{instance="srv1", role="database"}  1
```

```promql
node_filesystem_avail_bytes
  * on(instance) group_left(role)
machine_role_info
```

Resultado:

```
{instance="srv1", mountpoint="/",     role="database"}  50GB    ← 50GB * 1 = 50GB
{instance="srv1", mountpoint="/data", role="database"}  200GB
```

- Multiplicar por `1` no cambia el valor, solo **agrega el label `role`**
- `group_left` = "el lado izquierdo es el que tiene muchas series"
- `group_right` es lo mismo pero al revés (el lado derecho tiene muchas)
- **Importante:** los labels que querés copiar del lado derecho van **dentro del paréntesis**: `group_left(role)`. Con `group_left()` vacío (como aparece en el ejemplo de la lección) el join funciona pero **no se copia ningún label nuevo**
- `machine_role_info` es un ejemplo ilustrativo; no existe en el lab. Un ejemplo real que sí existe en muchos setups es `node_uname_info` o `kube_pod_info`

> La lección dice que `group_left` es "el equivalente a un LEFT JOIN de SQL". Es una buena analogía para la idea de "traer columnas de otra tabla", pero técnicamente se comporta como un **INNER JOIN**: si una serie de la izquierda no encuentra pareja a la derecha, se descarta.

### 8.3 Operadores de comparación: filtrar vs `bool`

Los operadores `>`, `<`, `>=`, `<=`, `==`, `!=` tienen dos modos:

```promql
# SIN bool → FILTRA: solo devuelve las series que cumplen, con su valor original
rate(prometheus_http_requests_total[5m]) > 0.1

# CON bool → NO filtra: devuelve TODAS las series con valor 1 (cumple) o 0 (no cumple)
rate(prometheus_http_requests_total[5m]) > bool 0.1
```

Ejemplo con los datos del lab:

```
Serie                          rate    > 0.1       > bool 0.1
/api/v1/query_range            0.098   (no está)   0
/metrics                       0.067   (no está)   0
/api/v1/query                  0.15    0.15        1
```

Cuándo usar cada uno:
- **Sin `bool`**: alertas ("mostrame solo lo que está mal") — así funcionan las reglas de alerta, si la query devuelve algo, la alerta dispara
- **Con `bool`**: cálculos condicionales, ej. contar cuántas series cumplen una condición:

```promql
# Cuántos handlers tienen más de 0.1 req/s
sum(rate(prometheus_http_requests_total[5m]) > bool 0.1)
```

### Resumen de modificadores

| Situación | Qué usar |
|-----------|----------|
| Los labels de ambos lados coinciden exacto | Nada (one-to-one por defecto) |
| Querés emparejar solo por algunos labels | `on(labels)` |
| Querés emparejar por todos menos algunos | `ignoring(labels)` |
| Muchas series a la izquierda, una a la derecha | `group_left(labels_a_copiar)` |
| Una a la izquierda, muchas a la derecha | `group_right(labels_a_copiar)` |
| Filtrar series por umbral | `>` / `<` sin `bool` |
| Obtener 0/1 en vez de filtrar | `> bool` |

---

## 9. Subqueries para ventanas de tiempo complejas

### El problema

`rate(x[5m])` devuelve un **instant vector** (un número por serie, ahora). Pero las funciones `*_over_time()` necesitan un **range vector** (una lista de valores en el tiempo). Entonces esto **no funciona**:

```promql
# ERROR — no podés poner [1h] después de una función
max_over_time(rate(prometheus_http_requests_total[5m])[1h])
```

Una subquery resuelve esto: toma una expresión que devuelve un instant vector y la **evalúa muchas veces en el pasado**, armando un range vector con los resultados.

### Sintaxis: `[range:resolution]`

```promql
max_over_time(rate(prometheus_http_requests_total[5m])[1h:1m])
```

Se lee así:
- `rate(...[5m])` → la expresión interna (req/s promediado en 5 min)
- `[1h:1m]` → "evaluala **cada 1 minuto** durante **la última hora**"
- Eso da ~60 valores de rate → `max_over_time()` se queda con el más alto

```
Tiempo:  -60m   -59m   -58m  ...  -1m    ahora
rate:    0.05   0.07   0.21  ...  0.06   0.08
                        ↑
               max_over_time → 0.21 (el pico de la última hora)
```

| Parte | Significado |
|-------|-------------|
| `range` (`1h`) | Cuánto tiempo hacia atrás mirar |
| `resolution` (`1m`) | Cada cuánto evaluar la expresión interna |
| `[1h:]` (sin resolution) | Usa el `evaluation_interval` global de Prometheus |

### Ejemplos

```promql
# Pico de tráfico de la última hora
max_over_time(rate(prometheus_http_requests_total[5m])[1h:1m])

# Tráfico promedio de la última hora (tendencia)
avg_over_time(rate(prometheus_http_requests_total[5m])[1h:1m])

# Pico de tráfico de las últimas 24h (típico para dashboards)
max_over_time(rate(prometheus_http_requests_total[5m])[24h:5m])
```

### Funciones `*_over_time()`

Todas reciben un range vector y devuelven un número por serie:

| Función | Devuelve | Uso típico |
|---------|----------|-----------|
| `max_over_time()` | Valor máximo | Pico de tráfico |
| `min_over_time()` | Valor mínimo | Valle de tráfico |
| `avg_over_time()` | Promedio | Tendencias |
| `stddev_over_time()` | Desviación estándar | Detectar variabilidad/anomalías |
| `quantile_over_time(q, ...)` | Percentil | p95 de un rate a lo largo del tiempo |
| `count_over_time()` | Cantidad de muestras | Ver si hubo scrapes perdidos |
| `last_over_time()` | Último valor | Rellenar huecos de series intermitentes |

> **No siempre hace falta una subquery.** Si la métrica es "cruda" (no pasó por una función), ya podés ponerle un range directo: `max_over_time(up[1h])`. La subquery (`[1h:1m]`) solo se necesita cuando adentro hay una **expresión** como `rate(...)` o `sum(...)`.

### Reglas importantes
- Las subqueries son **caras**: `[24h:1m]` evalúa el `rate()` 1440 veces. Para queries que se usan seguido (dashboards, alertas), conviene crear una **recording rule** que precalcule el `rate()` y hacer el `max_over_time()` sobre esa métrica
- Mientras más chica la resolution, más preciso pero más costoso
- Ideales para paneles tipo "pico de requests en las últimas 24h"

---

## 10. Patrones de queries para dashboards de producción

Estas seis queries son la base de la mayoría de los dashboards reales. Combinan todo lo visto en la lección (rate, sum by, histogram_quantile, binary operators).

| # | Query | Qué responde | ¿Funciona ya en el lab? |
|---|-------|--------------|-------------------------|
| 1 | Request rate | ¿Cuánto tráfico hay? | Sí (demo app) |
| 2 | Error rate % | ¿Cuántos requests fallan? | Lección 202 |
| 3 | P99 latency | ¿Qué tan rápido responde? | Sí (demo app) |
| 4 | Availability | ¿Estamos cumpliendo el SLO? | Lección 202 |
| 5 | CPU % | ¿Cómo está la CPU? | Lección 203 (Node Exporter) |
| 6 | Memoria % | ¿Cómo está la RAM? | Lección 203 (Node Exporter) |

### 10.1 Request rate (tráfico)

```promql
sum(rate(http_server_request_duration_seconds_count[5m])) by (http_route)
```

- `_count` de un histograma es un counter con la cantidad total de requests → `rate()` lo convierte en req/s
- `by (http_route)` → una línea por endpoint
- `sum(...) by (x)` es lo mismo que `sum by (x)(...)`, solo cambia dónde se escribe el `by`

#### Desglose paso a paso (de adentro hacia afuera)

**Paso 1 — La métrica: varias series con contadores acumulados**

La métrica no es un solo número: hay **una serie por cada combinación de labels**. Cada una cuenta todos los requests desde que arrancó la app (solo sube).

```
{http_route="/",          method="GET",  status="200"}  → 1500
{http_route="/",          method="GET",  status="404"}  → 30
{http_route="/api/users", method="GET",  status="200"}  → 800
{http_route="/api/users", method="POST", status="201"}  → 200
```

**Paso 2 — `[5m]`: arma la lista**

Con scrape cada 15s, 5 minutos = **~20 muestras por serie**. El `[5m]` es el que arma la lista (range vector), no el `rate`:

```
{http_route="/", method="GET", status="200"}
  → [1200, 1210, 1225, 1240, ... , 1500]   (~20 valores)
```

**Paso 3 — `rate()`: convierte la lista en UN número (req/s)**

El contador es como el **cuentakilómetros** de un auto: nunca baja, y ver `50.000 km` no te dice si vas rápido o lento. Para saber la velocidad lo mirás en dos momentos:

```
A las 10:00 marca  50.000 km
A las 11:00 marca  50.080 km
Anduvo 80 km en 1 hora → 80 km/h
```

Es decir: **(valor final − valor inicial) ÷ tiempo**. `rate()` hace exactamente eso con los requests:

```
Hace 5 minutos el contador marcaba  1200
Ahora el contador marca             1500

Entraron 1500 − 1200 = 300 requests
En 5 minutos = 300 segundos
300 requests ÷ 300 segundos = 1 request por segundo
```

| Contador | `rate()` |
|---|---|
| Cuentakilómetros (km totales) | Velocímetro (km/h) |
| Requests totales desde siempre | Requests por segundo ahora |

Después del `rate()`, cada serie queda con un solo número:

```
{http_route="/",          method="GET",  status="200"}  → 1.0 req/s
{http_route="/",          method="GET",  status="404"}  → 0.1 req/s
{http_route="/api/users", method="GET",  status="200"}  → 0.5 req/s
{http_route="/api/users", method="POST", status="201"}  → 0.2 req/s
```

**Paso 4 — `sum by (http_route)`: suma series, no tiempo**

El `sum` **no** suma los 20 valores del tiempo (eso ya lo resolvió `rate`). Suma las **distintas series que tienen la misma ruta** y descarta los labels que no están en el `by` (`method`, `status`):

```
{http_route="/"}          → 1.0 + 0.1 = 1.1 req/s
{http_route="/api/users"} → 0.5 + 0.2 = 0.7 req/s
```

Ejemplo con un kiosco que anota ventas por producto y forma de pago:

```
Golosinas + efectivo  →  10 ventas/hora
Golosinas + tarjeta   →   5 ventas/hora
Bebidas   + efectivo  →   8 ventas/hora
```

`sum by (producto)` responde "¿cuánto vendo por producto?":

```
Golosinas → 10 + 5 = 15 ventas/hora
Bebidas   → 8 ventas/hora
```

La forma de pago desaparece porque no está en el `by`.

**Resumen del flujo**

```
métrica            →  varias series con contadores acumulados   ("llevo 1500 en total")
   [5m]            →  cada serie pasa a ser una lista de ~20 valores
   rate()          →  cada lista pasa a ser 1 número (req/s)     ("entran 1 por segundo")
   sum by (route)  →  junta las series de la misma ruta          ("/ recibe 1.1 req/s en total")
```

| Parte | Qué hace | Opera sobre |
|---|---|---|
| `[5m]` | Arma la lista de muestras | Tiempo |
| `rate()` | Lista → req/s | Tiempo |
| `sum by` | Junta series | Labels |

> **Regla para acordarte:** `[5m]` y `rate` trabajan en el eje del **tiempo**; `sum` trabaja en el eje de los **labels**.

### 10.2 Error rate % (confiabilidad)

```promql
sum(rate(app_http_requests_total{status_code=~"5.."}[5m]))
/ sum(rate(app_http_requests_total[5m])) * 100
```

- Numerador: requests con código 5xx por segundo. Denominador: todos los requests por segundo
- Como ambos lados usan `sum()` sin `by`, no hace falta `on()` (ver sección 5)
- **Ojo:** si no hubo ningún 5xx, el numerador no devuelve series y el resultado queda **vacío** en vez de `0`. Se soluciona con `or vector(0)`:
  ```promql
  (sum(rate(app_http_requests_total{status_code=~"5.."}[5m])) or vector(0))
  / sum(rate(app_http_requests_total[5m])) * 100
  ```

### 10.3 P99 latency (experiencia del usuario)

```promql
histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket[5m])) by (le, http_route))
```

- El 99% de los requests de cada ruta son más rápidos que este valor (en segundos)
- `by (le, http_route)` → conserva `le` (obligatorio, ver sección 7) y agrega `http_route` para tener un p99 por endpoint

### 10.4 Availability (base de los SLOs)

```promql
1 - (
  sum(rate(app_http_requests_total{status_code=~"5.."}[5m]))
  / sum(rate(app_http_requests_total[5m]))
)
```

- Es `1 - error_rate` → la fracción de requests exitosos
- Devuelve un valor entre **0 y 1** (no porcentaje): `0.999` = 99.9% de disponibilidad. En Grafana se usa la unidad "Percent (0.0-1.0)"
- Se compara contra el SLO (ej: 99.9%) para saber cuánto error budget queda

### 10.5 CPU usage % (infraestructura)

```promql
(1 - avg by (instance)(irate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100
```

- `node_cpu_seconds_total{mode="idle"}` es un counter de segundos que la CPU pasó sin hacer nada
- `irate()` → fracción del tiempo idle (0 a 1) por cada core
- `avg by (instance)` → promedio de todos los cores de cada máquina
- `1 - idle` = tiempo ocupado → `* 100` para porcentaje
- `irate` muestra spikes; para un gráfico más suave (o alertas) se puede usar `rate` (ver sección 3)

### 10.6 Memory usage % (infraestructura)

```promql
(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100
```

- Son **gauges** → no llevan `rate()`, se usan directo
- `MemAvailable / MemTotal` = fracción libre → `1 - eso` = fracción usada
- Se usa `MemAvailable` (y no `MemFree`) porque incluye la memoria de cache que el sistema puede liberar; `MemFree` exagera el uso

### Las métricas clave detrás de estos patrones

- **Request rate, errores y latencia** son las señales **RED** (Rate, Errors, Duration) → miden el servicio desde el punto de vista del usuario
- **CPU y memoria** son señales **USE** (Utilization, Saturation, Errors) → miden la salud de la infraestructura

---

## 11. Referencia rápida de funciones

| Función | Input | Output | Uso típico |
|---------|-------|--------|-----------|
| `rate()` | Counter range vector | req/s suavizado | Dashboards, alertas |
| `irate()` | Counter range vector | req/s instantáneo | Ver spikes |
| `increase()` | Counter range vector | Total en ventana | "Cuántos en 1h" |
| `sum by()` | Instant vector | Agrupado | Agrupar por label |
| `histogram_quantile()` | Histogram buckets | Percentil | P95, P99 de latencia |
| `max_over_time()` | Range vector / subquery | Máximo en la ventana | Pico de tráfico |
| `avg_over_time()` | Range vector / subquery | Promedio en la ventana | Tendencias |
