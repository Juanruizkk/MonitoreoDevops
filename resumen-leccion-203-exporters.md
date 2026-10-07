# Resumen — Lección 203: Exporters, Blackbox Monitoring & Recording Rules

---

## 1. Exporters

Prometheus es **pull-based**: él va a buscar las métricas a cada target, no le llegan solas.

Un **exporter** es un proceso que traduce métricas de un sistema que no habla Prometheus a un `/metrics` que Prometheus sí puede raspar.

### Node Exporter — métricas del sistema operativo

Lee `/proc` y `/sys` del host Linux y los expone como métricas Prometheus.

```
Host Linux (/proc, /sys)
    ↑ lee
Node Exporter :9100/metrics
    ↑ raspa
Prometheus
```

Se monta como volumen read-only en `docker-compose.yml`:
```yaml
volumes:
  - /proc:/host/proc:ro
  - /sys:/host/sys:ro
```

Métricas que entrega: CPU, RAM, disco, red, carga del sistema, etc.

### Blackbox Exporter — monitoreo desde afuera (outside-in)

Simula ser un usuario externo y verifica que un endpoint responde bien. Hace **probes** (sondas).

- **HTTP probe**: hace un GET y verifica que el status sea 2xx
- **TCP probe**: verifica que el puerto esté abierto y acepte conexión

La config de los módulos va en `blackbox.yml`:
```yaml
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      valid_status_codes: [200]
      method: GET

  tcp_connect:
    prober: tcp
    timeout: 5s
```

---

## 2. Stack de scraping completo

```
Host Linux
  ├── /proc, /sys ──────────→ node-exporter:9100
  └── Docker
        ├── App Node.js → OTel Collector:8889
        └── Blackbox Exporter:9115
                              ↑ sondea
                    host.docker.internal:4000
                    prometheus.io
                    grafana.com

Prometheus :9090
  ├── raspa localhost:9090        (a sí mismo)
  ├── raspa otel-collector:8889   (métricas app via OTel)
  ├── raspa node-exporter:9100    (métricas OS)
  └── raspa blackbox-exporter:9115?target=...  (probes)
```

---

## 3. Relabeling para Blackbox Exporter

### El problema

Prometheus normalmente raspa así:
```
Prometheus → [__address__]/metrics → obtiene métricas
```

Con Blackbox no funciona así. El Blackbox es un **proxy**: Prometheus le dice "andá a probar *este* URL" pasándolo como parámetro:
```
Prometheus → blackbox-exporter:9115/probe?target=https://grafana.com
```

### Los labels internos `__`

Los labels que empiezan con `__` son internos de Prometheus y controlan cómo construye la URL de scrape:

```
http://  [__address__]  [metrics_path]  ?  [__param_X=valor]
```

Si al final del relabeling tenés:
```
__address__    = blackbox-exporter:9115
metrics_path   = /probe                  ← está en el config
__param_target = https://grafana.com
```

Prometheus arma: `http://blackbox-exporter:9115/probe?target=https://grafana.com`

### Estado inicial (antes de relabeling)

Cuando Prometheus lee el `static_configs`, carga los targets en `__address__`:
```
__address__    = "https://grafana.com"
instance       = (vacío)
__param_target = (no existe)
```

### Los 3 pasos

**Paso 1** — copiar `__address__` a `__param_target`
```yaml
- source_labels: [__address__]
  target_label: __param_target
```
```
ANTES:  __param_target = (vacío)
DESPUÉS: __param_target = "https://grafana.com"
```
Ahora existe el parámetro `?target=` en la URL futura.

**Paso 2** — guardar la URL como label visible `instance`
```yaml
- source_labels: [__param_target]
  target_label: instance
```
```
ANTES:  instance = (vacío)
DESPUÉS: instance = "https://grafana.com"
```
Los labels `__` desaparecen después del scrape. Si no guardás la URL en `instance`, en Grafana no sabés qué target fue.

**Paso 3** — reemplazar `__address__` con el Blackbox Exporter
```yaml
- target_label: __address__
  replacement: blackbox-exporter:9115
```
```
ANTES:  __address__ = "https://grafana.com"
DESPUÉS: __address__ = "blackbox-exporter:9115"
```
Ahora Prometheus va al Blackbox, no al sitio real.

### Estado final

```
__address__    = "blackbox-exporter:9115"   ← a dónde conectarse
__param_target = "https://grafana.com"      ← el ?target=
instance       = "https://grafana.com"      ← label que queda en las métricas
```

### Para múltiples targets en paralelo

| target original | `__address__` final | URL de scrape |
|---|---|---|
| `http://host.docker.internal:4000` | `blackbox-exporter:9115` | `/probe?target=http://host.docker.internal:4000` |
| `https://prometheus.io` | `blackbox-exporter:9115` | `/probe?target=https://prometheus.io` |
| `https://grafana.com` | `blackbox-exporter:9115` | `/probe?target=https://grafana.com` |

Siempre van al mismo Blackbox Exporter, pero con diferente `?target=`. El patrón de `relabel_configs` es el mismo para cualquier deployment — se puede copiar tal cual.

---

## 4. Recording Rules

Prometheus puede pre-calcular queries costosas y guardarlas como nuevas series temporales. Se evalúan según `evaluation_interval` (15s por defecto).

### El problema que resuelven

Cada vez que Grafana abre un dashboard, Prometheus ejecuta todas las queries en ese momento. Una query compleja como:

```promql
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))
```

Tiene que procesar todo el historial del rango visible. Con 10 paneles y 50 usuarios = 500 ejecuciones simultáneas.

Una recording rule corre esa query cada 15s y guarda el resultado como métrica simple lista para consultar.

### Convención de nombres `level:metric:operations`

```
job:http_requests:rate5m
│    │              │
│    │              └── qué se aplicó: rate con ventana 5m
│    └── métrica original
└── nivel de agregación
```

| Parte | Qué indica | Ejemplos |
|---|---|---|
| `level` | nivel de agregación | `job`, `instance`, `service`, `cluster` |
| `metric` | métrica base | `http_requests`, `node_cpu` |
| `operations` | transformaciones | `rate5m`, `p99`, `sum`, `utilization` |

### Estructura del archivo (`rules/recording-rules.yml`)

```yaml
groups:
  - name: http_recording_rules
    interval: 15s
    rules:
      - record: job:app_http_requests:rate5m
        expr: sum(rate(app_http_requests_total[5m])) by (job)
```

### Rules del lab

**Grupo `http_recording_rules`:**

| Rule | Qué pre-calcula |
|---|---|
| `job:app_http_requests:rate5m` | tasa de requests por job |
| `endpoint:app_http_requests:rate5m` | tasa de requests por endpoint |
| `job:app_http_errors:rate5m_ratio` | ratio de errores 5xx |
| `endpoint:app_http_request_duration_seconds:p99` | latencia p99 por endpoint |
| `endpoint:app_http_request_duration_seconds:p50` | latencia p50 por endpoint |

**Grupo `sli_recording_rules`:**

| Rule | Qué pre-calcula |
|---|---|
| `job:app_http_availability:ratio5m` | disponibilidad (1 - error rate) |
| `job:app_http_latency_sli:ratio5m` | % de requests bajo 500ms |

### Setup en el lab

El `prometheus.yml` ya tiene `rule_files: - "rules/*.yml"`. Hay que montar la carpeta en el contenedor:

```yaml
# docker-compose.yml
volumes:
  - ./config/prometheus.yml:/etc/prometheus/prometheus.yml
  - ./rules:/etc/prometheus/rules          # ← agregar esto
```

`docker compose restart prometheus` no alcanza para aplicar cambios de volúmenes — hay que usar `docker compose up -d prometheus` para recrear el contenedor.

### Estados de las rules

- `"health":"unknown"` → cargó pero todavía no evaluó (normal los primeros segundos)
- `"health":"ok"` → evaluando correctamente
- `"health":"bad"` → error en la expresión PromQL
- Valor `NaN` → la rule evalúa bien pero la métrica base no tiene datos (normal si la app no está corriendo)

### Cuándo usarlas

- La query aparece en más de un dashboard o alerta
- La query tarda más de ~1 segundo
- Querés nombres semánticos en alertas (`job:app_http_availability:ratio5m < 0.99` es más legible que la query cruda)

---

## 5. Dashboard de disponibilidad con Blackbox

### Las 4 queries esenciales

**Uptime % en las últimas 24h**
```promql
avg_over_time(probe_success{job="blackbox-http"}[24h]) * 100
```
`probe_success` vale 1 o 0 en cada scrape. El promedio en 24h es el % de disponibilidad. Ejemplo: 1h caído → `(23/24) * 100 = 95.8%`.

**Latencia promedio última hora**
```promql
avg_over_time(probe_duration_seconds{job="blackbox-http"}[1h])
```
Detecta degradación de performance antes de una caída total.

**Días hasta que vence el SSL**
```promql
(probe_ssl_earliest_cert_expiry{job="blackbox-http"} - time()) / 86400
```
`time()` devuelve el timestamp Unix actual. La diferencia dividida 86400 da días. Alertar cuando sea `< 30`.

**Endpoints caídos ahora mismo**
```promql
probe_success{job="blackbox-http"} == 0
```
Solo devuelve series cuando hay algo caído — ideal para alertas.

### Tips de producción

- Agregar todas las dependencias críticas como targets: payment gateway, CDN, auth provider
- Alerta de SSL: `(probe_ssl_earliest_cert_expiry - time()) / 86400 < 30`
- `probe_duration_seconds` detecta degradación antes de la caída completa
- Usar value mappings en Grafana: `1 → "UP"`, `0 → "DOWN"` en paneles Stat
