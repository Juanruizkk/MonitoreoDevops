# Resumen — Lección 403: Cardinality, Sampling & Cost Optimization

## 1. Qué es la cardinalidad y por qué importa

La cardinalidad es la cantidad de series temporales únicas que produce una métrica. Crece como el **producto** de todos los valores únicos de cada label:

```
http_requests_total{method, status, endpoint}
= 4 métodos × 5 estados × 20 endpoints = 400 series   ← manejable

Agregás user_id con 100.000 usuarios:
= 4 × 5 × 20 × 100.000 = 40.000.000 series            ← catástrofe
```

Cada serie consume ~1-2 KB de RAM. 40 millones = 40-80 GB solo para esa métrica.

**Regla de oro:** nunca uses valores no acotados como labels — user_id, request_id, email, session_token. Límite práctico: menos de 1 millón de series activas por instancia de Prometheus.

---

## 2. Identificar métricas de alta cardinalidad

```bash
# TSDB status page — punto de partida
curl -s http://localhost:9090/api/v1/status/tsdb | python3 -m json.tool

# Top 10 métricas por series (PromQL)
topk(10, count by (__name__)({__name__=~".+"}))

# Qué label infla una métrica específica
count by (__name__, endpoint)(http_requests_total)

# Total de series activas
prometheus_tsdb_head_series
```

Los histogramas tienen cardinalidad inherentemente mayor — cada bucket es una serie separada. Una métrica con 10 combinaciones de labels y 15 buckets = 150 series.

---

## 3. Label best practices

**Labels seguros** (valores acotados):

| Label | Cardinalidad |
|---|---|
| method | 4 |
| status_code | ~10 |
| service | ~20 |
| region | ~5 |
| environment | 2 |

**Labels peligrosos:** user_id, request_id, email, query_string, ip_address.

**El truco de parametrización para endpoints:**
```
✗ endpoint="/api/users/12345"   → una serie por usuario
✓ endpoint="/api/users/:id"     → una serie para todos
```

**División correcta por herramienta:**
```
Métricas → datos agregados   (¿cuántos requests fallaron?)
Logs     → datos de instancia (¿qué pasó con este request?)
Trazas   → datos de instancia (¿dónde tardó este request?)
```

---

## 4. Storage y retención en Prometheus

```yaml
--storage.tsdb.retention.time=30d   # retener por tiempo
--storage.tsdb.retention.size=50GB  # safety net de disco
```

Siempre configurar **los dos**. El de tamaño evita que Prometheus llene el disco ante un pico de cardinalidad inesperado. Recomendado: 80% del disco disponible.

**Fórmula de estimación:**
```
samples/día = series_activas × (86.400 / scrape_interval)
storage/día = samples × 1.5 bytes

Ejemplo: 100K series, 15s scrape, 30d:
  samples/día = 100.000 × 5.760 = 576.000.000
  storage/día = 864 MB
  30 días     = ~25 GB
```

Para retención larga (meses/años): remote write hacia Thanos, Grafana Mimir, VictoriaMetrics o Cortex.

---

## 5. Estrategias de trace sampling

| Estrategia | Cuándo decide | Ventaja | Problema |
|---|---|---|---|
| **Head sampling** | Al inicio | Simple, bajo overhead | Puede descartar errores raros |
| **Tail sampling** | Cuando completa | Ve el trace completo | Requiere más memoria (buffer) |
| **Probabilistic** | Aleatoriamente | Predecible | No distingue tráfico útil |

**Approach recomendado — tail sampling:**
```
Guardar 100% → traces con errores
Guardar 100% → traces lentos (> p99 latencia)
Guardar  10% → traces exitosos y rápidos
Guardar 100% → traces con headers de debug específicos
```

---

## 6. Tail sampling en el OTel Collector

```yaml
processors:
  tail_sampling:
    decision_wait: 10s      # bufferear antes de decidir
    num_traces: 100000      # traces en buffer simultáneo

    policies:
      - name: errors-policy
        type: status_code
        status_code: {status_codes: [ERROR]}

      - name: latency-policy
        type: latency
        latency: {threshold_ms: 2000}

      - name: probabilistic-policy
        type: probabilistic
        probabilistic: {sampling_percentage: 10}
```

**Cálculo de `num_traces`:**
```
1.000 RPS × 10s decision_wait = 10.000 traces mínimo en buffer
num_traces: 100.000 → 10x de margen para picos

Para 10.000 RPS → num_traces: 500.000-1.000.000
Memoria estimada del Collector: 4-8 GB
```

El orden en el pipeline importa: `tail_sampling` antes de `batch`.

---

## 7. Retención de logs en Loki

```yaml
compactor:
  retention_enabled: true
  compaction_interval: 10m
  retention_delete_delay: 2h       # margen de seguridad antes de borrar

limits_config:
  retention_period: 720h            # 30 días por defecto

# Per-stream: retenciones distintas por tipo de log
stream_retention:
  - selector: '{namespace="production"}'
    period: 2160h                   # 90 días
  - selector: '{level="debug"}'
    period: 168h                    # 7 días
```

**Retenciones típicas:**

| Tipo | Retención | Razón |
|---|---|---|
| Debug | 7 días | Volumen alto, valor bajo |
| Aplicación | 30 días | Balance costo/utilidad |
| Auditoría | 90-365 días | Compliance |
| Seguridad | 365 días | Requerimiento legal |

Verificar requerimientos legales antes de configurar retenciones cortas para logs de auditoría o seguridad.

---

## 8. Cost optimization strategies

| Estrategia | Ahorro esperado |
|---|---|
| Trace sampling (tail) | 80–90% |
| Log filtering en producción | 40–70% |
| Metric cardinality reduction | 30–60% |
| Right-size retention | variable |
| Tiered storage (SSD/HDD/S3) | variable |

**Dropear labels con `metric_relabel_configs`:**
```yaml
metric_relabel_configs:
  - action: labeldrop
    regex: "user_id|request_id"
```

**Filtrar logs en OTel Collector:**
```yaml
processors:
  filter/logs:
    logs:
      exclude:
        match_type: strict
        severity_texts: ["DEBUG", "TRACE"]
```

**Principio:** en desarrollo e incidentes colectá todo. En producción normal, sé selectivo en lo que guardás largo plazo.

---

## 9. Meta-monitoring (monitoring your monitoring)

Si Prometheus se cae, las alertas que dependen de él también se caen. Hay que monitorear el stack de observabilidad en sí.

**Métricas clave:**

```promql
# Prometheus
prometheus_tsdb_head_series                   # cardinalidad activa
rate(prometheus_tsdb_head_samples_appended_total[5m])  # ingesta
prometheus_tsdb_compactions_failed_total      # salud del storage

# OTel Collector
otelcol_processor_dropped_spans               # debería ser 0 siempre
otelcol_exporter_send_failed_spans            # fallos de export
otelcol_process_memory_rss                    # RAM (crítico con tail sampling)

# Grafana
grafana_http_request_duration_seconds         # performance de dashboards
```

**Alertas esenciales de meta-monitoring:**
```yaml
# Explosión de cardinalidad
- alert: CardinalityExplosion
  expr: rate(prometheus_tsdb_head_series[1h]) > 10000

# Collector dropeando spans
- alert: OtelCollectorDroppingSpans
  expr: rate(otelcol_processor_dropped_spans[5m]) > 0
```

Usar un sistema independiente (uptime checker externo) para monitorear el stack primario — no podés monitorear Prometheus solo con Prometheus.

---

## 10. Capacity planning

```
                  Métricas        Trazas (10% sampling)    Logs (comprimidos)
Por día:          864 MB          34.5 GB                  21.6 GB
30 días:          ~26 GB          ~1.035 GB                ~648 GB
% del total:      3%              59%                      38%
```

**Las trazas son el mayor consumidor** — sin sampling serían ~10 TB/mes. El tail sampling las hace viables.

**Fórmula de planning:**
```
Consumo actual × factor de crecimiento × 1.2 (headroom 20%)
Proyectar al menos 6 meses hacia adelante
Recalcular trimestralmente
```

**Regla práctica:** si tu tráfico crece 2x, tu storage de observabilidad crece ~2x.
