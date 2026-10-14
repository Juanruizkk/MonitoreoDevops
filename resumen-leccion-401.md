# Resumen — Lección 401: SLIs, SLOs y Error Budgets

## 1. Service Level Indicator (SLI)

Un SLI es una medida cuantitativa de la calidad del servicio **desde la perspectiva del usuario**, expresada siempre como proporción:

```
SLI = (eventos buenos / eventos totales) × 100%
```

Tipos principales:

| Tipo | Fórmula |
|---|---|
| Availability | requests exitosos / total |
| Latency | requests bajo umbral / total |
| Correctness | respuestas correctas / total |
| Throughput | requests servidos / capacidad esperada |

**Regla:** medí en el load balancer o API gateway, no en la app. Así capturás también fallas de red y timeouts que el servidor nunca ve.

---

## 2. Service Level Objective (SLO)

Un SLO es el target del SLI sobre una ventana de tiempo:

```
SLO = target del SLI + ventana temporal
Ejemplo: "99.9% de requests exitosos en 30 días"
```

Lo que significa en la práctica:

| SLO | Downtime permitido/mes |
|---|---|
| 99% | 7h 12min |
| 99.9% | 43min |
| 99.95% | 21min |
| 99.99% | 4min |

**Nunca pongas 100%** — cualquier deploy o restart lo rompe. Empezá bajo (99.5%) y ajustá con datos reales.

---

## 3. Error Budget

```
Error Budget = 100% - SLO target
```

Es la confiabilidad como **recurso consumible**:

- Budget disponible → deployá, experimentá, tomá riesgos
- Budget casi agotado → priorizá reliability sobre features
- Budget en cero → freeze de deploys, todo el esfuerzo en estabilidad

El concepto más poderoso: convierte "¿podemos deployar?" en una pregunta objetiva con respuesta en un número. Alinea producto y engineering en el mismo indicador.

---

## 4. Elegir los SLIs correctos

Máximo **3 a 5 SLIs por servicio**. Filtros para elegirlos:
- ¿Qué haría que mis usuarios se quejen? → esa es tu SLI
- ¿Si esta SLI se pone en rojo, hacemos algo? → si no, sacala

Por tipo de servicio:

| Servicio | SLIs recomendados |
|---|---|
| API / Web app | Availability + Latency |
| Data pipeline | Freshness + Correctness |
| Storage / DB | Durability + Availability + Latency |

---

## 5. Recording Rules en Prometheus

Pre-computan los SLIs cada 30s para que dashboards y alertas no recalculen desde datos crudos:

```yaml
# Availability SLI
sli:http_availability:ratio_rate5m =
  sum(rate(requests{status!~"5.."}[5m])) / sum(rate(requests[5m]))

# Latency SLI (requests < 300ms)
sli:http_latency:ratio_rate5m =
  sum(rate(duration_bucket{le="0.3"}[5m])) / sum(rate(duration_count[5m]))
```

Convención de nombres: `sli:<señal>:<agregación>`

---

## 6. Error Budget Remaining y Burn Rate

**Budget remaining** (1 = lleno, 0 = agotado):
```
1 - (error_rate_actual / error_rate_permitida)
```

**Burn rate** (velocidad relativa de consumo):
```
burn_rate = error_rate_actual / (1 - SLO_target)

burn_rate = 1  → consumo sostenible
burn_rate = 10 → agotás el budget 10x más rápido de lo normal
```

Se calculan en múltiples ventanas (5m, 30m, 1h, 6h) para detectar diferentes tipos de incidentes.

---

## 7. Multi-window Multi-burn-rate Alerting

Estrategia de Google SRE Workbook. Cada alerta usa **dos ventanas con AND**:

```yaml
# CRITICAL: budget agotado en ~2 días
sli:burn_rate:ratio_1h > 14.4 AND sli:burn_rate:ratio_5m > 14.4
for: 2m → page inmediato

# WARNING: budget agotado en ~10 días
sli:burn_rate:ratio_6h > 3 AND sli:burn_rate:ratio_30m > 3
for: 5m → ticket / investigar
```

Ventana larga confirma que el problema es real. Ventana corta confirma que sigue activo. Las dos juntas eliminan falsas alarmas.

---

## 8. SLO Dashboard en Grafana

Cuatro paneles que responden las tres preguntas clave:

| Panel | Tipo | Pregunta que responde |
|---|---|---|
| Availability SLI | Gauge | ¿Cumplimos el SLO ahora? |
| Error Budget Remaining | Gauge | ¿Cuánto budget queda? |
| Burn Rate 1h | Timeseries | ¿Se consume más rápido de lo normal? |
| SLI Over Time 30d | Timeseries | ¿Cuál es la tendencia? |

Tip: añadí anotaciones de deploys para correlacionar caídas de SLI con releases.

---

## 9. Framework de decisiones basado en SLO

| Budget restante | Acción |
|---|---|
| > 50% | Deploy libre, experimentos, riesgos |
| 20–50% | Deploy con canary, balance features/reliability |
| < 20% | Reducí deploys, priorizá reliability |
| 0% | Freeze, todo el esfuerzo en estabilidad + incident review |

El SLO despersonaliza las decisiones: el dato decide, no las opiniones.

---

## 10. Ejemplos reales

El SLO refleja el impacto de negocio, no el máximo técnico alcanzable:

| Servicio | SLO | Budget |
|---|---|---|
| Checkout API | 99.95% / 30d | 21.6 min |
| Auth service | 99.9% / 30d | 43 min |
| Data pipeline | 99.5% / 7d | ~50 min/semana |
| Dashboard interno | 99% / 30d | 7.2 horas |

---

## Flujo completo de implementación

```
Observar SLI real (2 semanas)
        ↓
Fijar SLO ligeramente por debajo del baseline observado
        ↓
Recording rules en Prometheus (SLI + burn rate + budget remaining)
        ↓
Alertas multi-window (critical 14.4x / warning 3x)
        ↓
Dashboard en Grafana (4 paneles)
        ↓
Política de equipo basada en budget (>50% / 20-50% / <20% / 0%)
        ↓
Revisión semanal + ajuste trimestral del SLO
```
