# Resumen — Lección 302: Centralized Logging with Grafana Loki

## 1. Arquitectura de Loki — por qué es diferente

Loki no indexa el contenido de los logs, solo las **labels**. Eso lo hace 10-100x más barato que Elasticsearch.

```
Lo que Loki indexa (labels):        Lo que Loki NO indexa:
─────────────────────────────────   ────────────────────────────────────────
service = "order-api"               "Payment failed for user 12345: timeout"
level   = "error"                   (guardado comprimido, se grepea on-demand)
env     = "prod"
```

### Flujo de una query

```
Paso 1: {service="order-api", level="error"}
        → Loki usa el índice de labels. Rápido. Descarta todo lo demás.

Paso 2: |= "timeout"
        → Grep sobre el texto comprimido. Sin parsear.

Paso 3: | json | duration_ms > 3000
        → Parsea JSON y filtra por campo numérico.
```

### Componentes internos

```
Promtail / OTel Collector
         │  (push via HTTP)
         ▼
  DISTRIBUTOR  → enruta al ingester correcto
         │
         ▼
  INGESTER     → agrupa y comprime en chunks
         │
         ▼
  STORAGE      → filesystem local (lab) o S3/GCS (prod)

  QUERIER      → carga chunks + aplica filtros LogQL
```

### Regla de cardinalidad

| Label | Cardinalidad | Resultado |
|-------|-------------|-----------|
| `level=error\|warn\|info` | 3 valores | Perfecto |
| `service=order-api\|payment` | 10-20 valores | Bien |
| `user_id=12345\|67890\|...` | Millones | **Rompe Loki** |
| `request_id=abc123\|...` | Ilimitado | **Jamás hacer esto** |

Los valores únicos por request van **dentro del log** como campos JSON, no como labels.

---

## 2. Setup del stack

### Archivos creados

| Archivo | Qué hace |
|---------|----------|
| `loki/loki-config.yml` | Config de Loki: storage filesystem, schema v13, puerto 3100 |
| `loki/grafana-loki-datasource.yml` | Provisioning automático del datasource en Grafana |
| `docker-compose.logging.yml` | Override: agrega Loki, monta datasource en Grafana, monta `app/logs` en OTel Collector |

### Cómo levantar el stack completo

```powershell
docker compose -f docker-compose.yml -f docker-compose.logging.yml up -d
```

El archivo override se **fusiona** con el base — no lo reemplaza. Grafana, Prometheus y OTel siguen funcionando igual, Loki se agrega a la misma red Docker.

### ¿Por qué el monitoreo de logs está en un docker-compose separado?

El uso de `docker-compose.logging.yml` responde a un patrón estándar en DevOps llamado **Docker Compose Layering / Overrides (Composición Modular)**:

1. **Es una Extensión (Overlay), no un entorno aislado:**
   Al pasar múltiples flags `-f`, Docker fusiona los archivos en un único proyecto:
   - Toma el `docker-compose.yml` base (Prometheus, Grafana, OTel Collector, Exporters).
   - Inyecta el contenedor **`loki`**.
   - **Extiende** los servicios base: monta en Grafana el datasource automático de Loki (`./loki/grafana-loki-datasource.yml`) y en el OTel Collector la carpeta de logs (`./app/logs`).
   - Todos los servicios comparten la misma red interna de Docker, comunicándose por DNS interno (`loki:3100`, `grafana:3000`, etc.).

2. **Diseño pedagógico y aprendizaje progresivo:**
   Permite aprender y depurar señal por señal sin sobrecargar el lab inicial:
   - **Módulo 1 y 2:** Base de métricas (`docker-compose.yml`).
   - **Lección 302:** Capa de logs (`docker-compose.logging.yml`).
   - **Trazas:** Capa de traces (`docker-compose.tracing.yml`).

3. **Ahorro de recursos (CPU / RAM):**
   Loki y la ingesta de logs consumen memoria y disco. Si solo estás probando métricas o dashboards rápidos, puedes levantar únicamente el archivo base (`docker compose up -d`) sin sobrecargar tu máquina.

4. **Modularidad y Mantenibilidad en Arquitectura DevOps:**
   - Evita un `docker-compose.yml` monolítico e inmanejable de cientos de líneas.
   - En entornos reales de staging/prod, los componentes de logs a menudo se alojan o escalan en nodos dedicados de forma independiente.

```text
┌────────────────────────────────────────────────────────┐
│                   docker-compose.yml (Base)            │
│  [Prometheus]  ───  [Grafana]  ───  [OTel Collector]   │
└──────────────────────────┬─────────────────────────────┘
                           │
             (Fusionado al ejecutar con -f)
                           │
┌──────────────────────────▼─────────────────────────────┐
│              docker-compose.logging.yml (Capa Logs)    │
│  [Loki:3100]  +  Datasource en Grafana  +  Logs Volume │
└────────────────────────────────────────────────────────┘
```

### Volumen persistente de Grafana

Se agregó `grafana-data` como named volume en `docker-compose.yml` para que los datasources y dashboards no se pierdan al recrear el contenedor:

```yaml
grafana:
  volumes:
    - grafana-data:/var/lib/grafana
```

Sin este volumen, cualquier `docker compose up` que recree Grafana borra toda la configuración manual.

### Provisioning de datasources

Grafana carga automáticamente cualquier YAML en `/etc/grafana/provisioning/datasources/`.
Ventaja: al clonar el repo y levantar el stack, Loki ya está configurado sin tocar la UI.

```yaml
# loki/grafana-loki-datasource.yml
datasources:
  - name: Loki
    uid: loki          # UID fijo — importante para dashboards reproducibles
    type: loki
    url: http://loki:3100
    jsonData:
      derivedFields:
        - matcherRegex: '"trace_id":"(\\w+)"'
          name: TraceID
          datasourceUid: tempo   # click en trace_id → salta a Tempo
```

El campo `derivedFields` crea links clickeables desde los logs hacia las trazas en Tempo.

---

## 3. OTel Collector — pipeline de logs

### Config actualizada (`config/otel-collector.yml`)

Se agregaron tres bloques nuevos manteniendo métricas y trazas intactos:

**Receiver — `filelog`**
```yaml
filelog:
  include:
    - /var/log/demo-app/*.log   # montado desde app/logs/
  operators:
    - type: json_parser         # parsea cada línea como JSON
      timestamp:
        parse_from: attributes.time
        layout: '%Y-%m-%dT%H:%M:%S.%LZ'
    - type: severity_parser     # traduce "error"/"warn"/"info" al estándar OTel
      parse_from: attributes.level
```

**Processors — labels para Loki**
```yaml
attributes:
  actions:
    - key: loki.attribute.labels
      value: service,level      # estos campos del log se vuelven labels en Loki
      action: insert

resource:
  attributes:
    - key: loki.resource.labels
      value: service.name       # este campo del resource se vuelve label en Loki
      action: insert
```

**Exporter — `loki`**
```yaml
loki:
  endpoint: http://loki:3100/loki/api/v1/push
```

**Pipeline de logs**
```yaml
logs:
  receivers: [filelog]
  processors: [attributes, resource, batch]   # orden importa: labels antes de batch
  exporters: [loki, debug]
```

`attributes` y `resource` van **antes** de `batch` porque los labels deben estar seteados antes de agrupar los logs.

---

## 4. LogQL — lenguaje de queries

### Estructura

```
{service="order-api", level="error"}  |=  "timeout"  |  json  |  duration_ms > 3000
         │                                    │              │            │
    Stream selector                     Line filter    Parser       Label filter
  (usa el índice,                      (grep rápido,  (extrae       (filtra sobre
   obligatorio)                        sin parsear)    campos)       campos)
```

### Stream selectors

| Operador | Ejemplo | Significado |
|----------|---------|-------------|
| `=` | `{service="api"}` | Exacto |
| `!=` | `{service!="frontend"}` | Excluir |
| `=~` | `{service=~"order-.*"}` | Regex match |
| `!~` | `{level!~"debug\|trace"}` | Regex excluir |

### Line filters

```logql
|= "timeout"     # contiene el string
!= "healthcheck" # no contiene el string
|~ "error|fail"  # regex match
!~ "debug|trace" # regex excluir
```

**Tip de performance:** usar `|=` antes de `| json` — descartás líneas sin parsear.

### Label filters (después de `| json`)

```logql
| json | status_code >= 500
| json | duration_ms > 1000
| json | user_id = "usr_42"
```

---

## 5. LogQL metric queries

LogQL tiene dos modos: devuelve líneas (log query) o devuelve números (metric query).

### Contar líneas

```logql
count_over_time({service="order-api", level="error"}[5m])   # conteo total
rate({service="order-api"}[1m])                              # por segundo
```

### Agregaciones

```logql
sum by (level) (count_over_time({service="order-api"}[5m]))
topk(5, sum by (service) (rate({level="error"}[5m])))
```

### `unwrap` — operar sobre valores numéricos

Sin `unwrap` solo podés contar líneas. Con `unwrap` operás sobre campos numéricos del log:

```logql
avg_over_time({service="order-api"} | json | unwrap duration_ms [5m])
quantile_over_time(0.99, {service="order-api"} | json | unwrap duration_ms [5m])
```

### Error rate

```logql
sum(rate({service="order-api", level="error"}[5m]))
/
sum(rate({service="order-api"}[5m]))
```

**Cuándo usar metric queries de Loki vs Prometheus:**
- Metric queries de Loki → análisis exploratorio ad-hoc, cuando no tenías la métrica instrumentada
- Prometheus → dashboards de alta frecuencia, alertas en producción (más barato de evaluar)

---

## 6. Flujo de debugging con LogQL

El patrón real: empezar amplio y achicar hasta el request exacto.

```
1. Encontrar errores del servicio
   {service="checkout-api", level=~"error|warn"}

2. Filtrar por síntoma
   {service="checkout-api"} | json | duration_ms > 5000

3. Extraer trace_id
   {service="checkout-api"} | json | duration_ms > 5000 | line_format "{{.trace_id}}"

4. Buscar ese trace en todos los servicios
   {service=~".+"} |= "4bf92f3577b34da6a3ce929d0e0e4736"

5. Click en trace_id → Tempo (via derivedField)
```

### `offset` — comparar con el pasado

```logql
-- hace 24 horas
sum by (msg) (count_over_time({level="error"}[1h] offset 24h))

-- ahora
sum by (msg) (count_over_time({level="error"}[1h]))
```

Útil para detectar si un deploy introdujo errores nuevos.

---

## 7. Log volume como señal de salud

El volumen de logs en sí mismo es un indicador. Los 4 patrones a monitorear:

| Patrón | Qué ves en el gráfico | Causa típica |
|--------|----------------------|--------------|
| **Error spike** | Pico repentino de errores | Deploy con regresión, caída de dependencia |
| **Log drop** | Servicio deja de producir logs | Crash, collector caído, partición de red |
| **Volume surge** | 10x más logs de golpe | Retry storm, debug logging en prod, log loop |
| **Level shift** | WARN pasa de 5% a 35% | Dependencia degradada, acercándose a límite de capacidad |

**"Zero logs" es más preocupante que errores** — un servicio con errores está vivo y reportando; uno silencioso puede estar crasheado.

### Queries para panels de volumen

```logql
# Volumen por servicio (stacked area)
sum by (service) (count_over_time({service=~".+"}[1m]))

# Errores totales (con threshold en Grafana)
sum(count_over_time({level="error"}[1m]))

# Distribución de niveles (100% stacked bar)
sum by (level) (count_over_time({service=~".+"}[5m]))
```

---

## 8. Loki vs ELK

| Feature | Grafana Loki | ELK Stack |
|---------|-------------|-----------|
| Indexing | Solo labels | Full-text de todo |
| Storage | Bajo | Alto (índice puede ser > que los logs) |
| Query speed | Rápido con labels | Rápido para cualquier búsqueda |
| RAM | Bajo | Alto (JVM heap) |
| Operaciones | Simple (un binario) | Complejo (ES + Logstash + Kibana) |
| Correlación | Metrics+Traces nativo | Requiere APM separado |
| Full-text search | Grep-like | Instantáneo (indexado) |

**Elegir Loki cuando:** ya usás Grafana+Prometheus, querés minimizar costos, la mayoría de queries filtran por servicio/nivel.

**Elegir ELK cuando:** necesitás buscar strings arbitrarios al instante, hay requisitos de compliance/auditoría, el equipo ya tiene expertise en Elasticsearch.

**Patrón híbrido en empresas grandes:**
```
Loki        → logs operacionales (errores, requests) — barato, integrado
Elasticsearch → logs de auditoría (accesos, pagos)  — searchable, compliant
```

---

## 9. El triángulo de observabilidad

```
Prometheus  ──► métricas    ─┐
Tempo       ──► trazas      ─┼──► Todo en Grafana, correlación nativa
Loki        ──► logs        ─┘

Flujo de debugging:
  métricas alertan el problema
       │
  logs muestran el síntoma + trace_id
       │
  trazas explican la causa raíz
```

Ninguna señal sola alcanza. Los tres juntos permiten pasar de "hay un problema" a "esta línea de código es la causa" en minutos.
