# Resumen — Lección 402: Dashboard Design & Alert Quality

## 1. Principios de diseño de dashboards

Todo dashboard debe responder a tres preguntas en orden:

```
¿Estamos sanos?        → Row 1 (SLO status)
¿Qué está pasando?     → Row 2-4 (Golden signals)
¿Por qué está pasando? → Row 5 (Infraestructura)
```

Tres principios fundamentales:
- **Audiencia** — ejecutivo, on-call engineer y developer necesitan dashboards distintos
- **Jerarquía** — overview primero, detalle después. Si tenés que scrollear para ver lo importante, el layout está mal
- **Contexto** — thresholds, anotaciones de deploys y comparaciones temporales. Un número sin referencia no dice nada

---

## 2. Golden Signals dashboard layout

```
┌─────────────────────────────────────────────┐
│  Row 1: SLO Status                          │  → ¿Me tengo que preocupar? (2 seg)
│  [Availability] [Error Budget] [Burn Rate]  │
├─────────────────────────────────────────────┤
│  Row 2: Latency                             │
│  [p50/p95/p99] [Heatmap]                   │
├─────────────────────────────────────────────┤
│  Row 3: Traffic                             │
│  [RPS total] [RPS por endpoint]             │
├─────────────────────────────────────────────┤
│  Row 4: Errors                              │
│  [Error rate %] [Errors por status code]    │
├─────────────────────────────────────────────┤
│  Row 5: Saturation (USE method)             │
│  [CPU] [Memory] [Disk] [Connections]        │
└─────────────────────────────────────────────┘
```

Colapsar rows 3-5 por defecto — el dashboard carga más rápido y muestra lo crítico primero.

---

## 3. Visualización correcta según el dato

| Dato | Visualización |
|---|---|
| Valor actual | Stat panel / Gauge |
| Valor en el tiempo | Time series |
| Distribución de latencia | **Heatmap** |
| Composición / breakdown | Stacked bar |
| Estado up/down | State timeline |
| Top-N ranking | Bar gauge / Table |
| Comparación vs threshold | Gauge con color zones |

**El heatmap es el más subestimado** — revela distribuciones bimodales que los percentiles ocultan. Si p50 y p95 parecen normales pero el heatmap muestra dos clusters, hay un endpoint específico lento que los promedios están enmascarando.

Anti-patterns a evitar:
- Pie charts con > 5 categorías
- Line charts con 20+ series → usar heatmap
- Tables para datos de tendencia → usar time series
- Stat panel para datos que varían mucho

---

## 4. Template variables y rows

```json
namespace  → dropdown dinámico desde label_values()
service    → dropdown filtrado por $namespace (cascading)
slo_target → dropdown fijo: 0.999 / 0.995 / 0.99 / 0.95
```

Un dashboard con variables bien configuradas reemplaza N dashboards por servicio.

**`$__interval`** — variable automática de Grafana que adapta la ventana del `rate()` al rango de tiempo seleccionado:

```promql
# Hardcodeado — siempre 5m
rate(http_requests_total[5m])

# Adaptativo — cambia según el zoom
rate(http_requests_total[$__interval])
```

| Rango seleccionado | `$__interval` |
|---|---|
| Last 15 min | ~10s |
| Last 1h | ~30s |
| Last 24h | ~2m |
| Last 7d | ~15m |

---

## 5. Alert quality metrics

| Métrica | Fórmula | Target |
|---|---|---|
| **Precision** | alertas accionables / alertas totales | > 80% |
| **Recall** | incidentes detectados / incidentes reales | > 95% |
| **Detection time** | inicio incidente → alerta | < 5 min |
| **Time to acknowledge** | alerta → respuesta humana | < 15 min |
| **Alerts per shift** | páginas por turno de 12h | **< 2** |

El límite de 2 páginas por turno es el más crítico — superarlo genera alert fatigue: los ingenieros empiezan a ignorar alertas y cuando llega el incidente real no lo tratan con urgencia.

---

## 6. Reducir alert fatigue

**El cambio más impactante: symptom-based vs cause-based**

```
✗ CPU > 80%          → causa interna, puede no afectar a nadie
✓ Error rate > 1%    → síntoma que el usuario está experimentando
```

Las 5 estrategias:

1. **Symptom-based alerting** — alertá sobre lo que el usuario vive
2. **Severidades correctas** — critical solo si requiere despertar a alguien ahora
3. **`for` duration suficiente** — mínimo 5 minutos para evitar spikes transitorios
4. **Agrupar alertas relacionadas** — `group_by` en Alertmanager
5. **Podar regularmente** — si nadie actuó en 30 días, eliminar o bajar a info

Los burn-rate alerts de la lección 401 son la implementación ideal de todos estos principios juntos.

---

## 7. Runbook-linked alerts

Anotaciones que toda alerta debería tener:

```yaml
annotations:
  summary: 'Error rate is {{ $value | humanizePercentage }} (threshold: 1%)'
  runbook_url: 'https://wiki/runbooks/high-error-rate'
  dashboard_url: 'https://grafana/d/overview?var-service={{ $labels.service }}'
  description: |
    Service {{ $labels.service }} en {{ $labels.namespace }}
    tiene error rate de {{ $value | humanizePercentage }}.
```

El `dashboard_url` con variables pre-llenadas es especialmente valioso — un click y el engineer ya está viendo el dashboard del servicio afectado.

Contenido mínimo de un runbook:
1. ¿Qué significa esta alerta?
2. Causas más comunes
3. Pasos de investigación en orden
4. Acciones de mitigación
5. Cuándo y a quién escalar

---

## 8. Testing de alertas

| Nivel | Qué valida |
|---|---|
| **Unit test** (`promtool check rules`) | Sintaxis y lógica PromQL — integrar en CI |
| **Integration test** | Pipeline completo Prometheus → Alertmanager → canal |
| **Chaos test** | Detection time real al matar un servicio |
| **Dead Man's Switch** | Que el sistema de alertas en sí está funcionando |

El Dead Man's Switch es una alerta que **siempre** está firing. Si el heartbeat se interrumpe, algo en el pipeline de alerting se rompió — antes de que un incidente real quede sin detectar.

```yaml
- alert: DeadMansSwitch
  expr: vector(1)   # siempre true
```

---

## 9. Dashboard-as-code

Los dashboards viven en Git, no solo en la base de datos de Grafana.

```
grafana/
  provisioning/
    dashboards/provider.yml     ← dónde buscar los JSON
    datasources/datasources.yml ← Prometheus, Loki, Tempo auto-configurados
  dashboards/
    overview/slo-overview.json
    services/api-service.json
```

**Flujo de trabajo:**
```
Editar en UI (editable: true)
→ Export JSON
→ Limpiar IDs auto-generados
→ Commitear a Git
→ docker compose up → disponible automáticamente
```

Sin provisioning, perder el volumen de Grafana significa perder todos los dashboards.

---

## 10. Checklist de revisión trimestral

```
□ ¿Responde "¿estamos sanos?" en < 5 segundos?
□ ¿Jerarquía clara overview → detalle?
□ ¿Time series con thresholds o líneas de SLO?
□ ¿Template variables para filtrar por servicio?
□ ¿Todos los paneles con nombres descriptivos?
□ ¿Unidades especificadas (s, bytes, %)?
□ ¿Anotaciones de deploys visibles?
□ ¿Time range default apropiado?
□ ¿Paneles agrupados en rows colapsables?
□ ¿Dashboard versionado en Git?
```

**Test de calidad real:** tomá un screenshot del dashboard durante un incidente. ¿Te ayudó a encontrar el problema o tuviste que ir a otro lado? Esa respuesta vale más que cualquier revisión en calma.
