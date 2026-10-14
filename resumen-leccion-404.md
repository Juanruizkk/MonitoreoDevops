# Resumen — Lección 404: Incident Response with Observability

## 1. Incident response workflow — las cinco fases

```
┌──────────┐
│  DETECT   │  ← Alerta dispara o usuario reporta
└────┬─────┘
     ▼
┌──────────┐
│  TRIAGE   │  ← ¿Qué tan grave? ¿Quién está afectado? ¿Qué severidad?
└────┬─────┘
     ▼
┌─────────────┐
│ INVESTIGATE  │  ← Métricas → Logs → Trazas
└────┬────────┘
     ▼
┌──────────┐
│ MITIGATE  │  ← Rollback, scale up, feature flag off
└────┬─────┘
     ▼
┌──────────┐
│  REVIEW   │  ← Postmortem, action items, aprender
└──────────┘
```

**El error más común:** saltarse el triage e ir directo a investigar.

**El principio de mitigación:** el primer objetivo es parar el sangrado, no encontrar la causa raíz. Un rollback en 5 minutos es mejor que 2 horas investigando mientras los usuarios siguen caídos.

---

## 2. Triage con dashboards (< 2 minutos)

**Paso 1 — SLO dashboard → urgencia:**
```
Budget > 50% → investigá con calma
Budget < 20% → escalá ahora
Budget = 0%  → freeze de deploys, todos al incidente
```

**Paso 2 — Golden Signals → categoría del síntoma:**
```
Spike de latencia → saturación de recursos o dependencia lenta
Spike de errores  → bad deploy o falla downstream
Caída de tráfico  → load balancer, DNS, o problema de red
Saturación alta   → memory leak o disco lleno
```

**Paso 3 — Anotaciones de deploys:** más del 70% de los incidentes son causados por un cambio reciente. Verificar primero.

**Paso 4 — Blast radius:** si múltiples servicios se degradan simultáneamente, buscar la dependencia compartida (DB, cache, cloud provider), no investigar cada servicio por separado.

---

## 3. Drill-down: Métricas → Logs → Trazas

El patrón core de investigación:

```
MÉTRICAS → ¿QUÉ está pasando y DÓNDE?
  rate(http_requests_total{status=~"5.."}[5m])
  → Errores 5xx en /api/checkout

LOGS → ¿CUÁL es el error específico?
  {service="checkout"} |= "error" | json | status >= 500
  → "Database connection pool exhausted"

TRAZAS → ¿DÓNDE exactamente en la cadena de llamadas?
  {resource.service.name="checkout" && status=error}
  → Span de DB muestra timeout de 30s, pool agotado

ROOT CAUSE: pool de 20 conexiones insuficiente para 50 requests concurrentes
MITIGACIÓN: subir pool a 100, luego investigar por qué subió la carga
```

El `trace_id` en los logs permite saltar directamente de un log de error a la traza completa. Las tres señales correlacionadas reducen el tiempo de investigación de horas a minutos.

---

## 4. Patrones comunes de incidentes

| Patrón | Forma en el gráfico | Query diagnóstica | Mitigación |
|---|---|---|---|
| **Bad deploy** | Escalón vertical en deploy time | `rate(http_requests_total{status=~"5.."}[1m])` | Rollback inmediato |
| **Resource exhaustion** | Rampa gradual → cliff | `process_resident_memory_bytes` | Restart → investigar leak |
| **Downstream failure** | Errores correlacionan con un dependency | `rate(http_client_duration_seconds_bucket{host="db"}[5m])` | Circuit breaker + fallback |
| **Traffic spike** | Tráfico sube → latencia → errores en cascada | `sum(rate(http_requests_total[5m]))` vs baseline | Scale up + rate limiting |

**Regla de forma:**
```
Escalón vertical → buscá deploy o config change
Rampa gradual   → buscá resource leak
```

---

## 5 y 6. Postmortems efectivos

Estructura del template:

```markdown
# Incident Postmortem: [Título]
Fecha / Duración / Severidad / Autor / Estado

## Summary (2-3 oraciones)
## Impact
  - Usuarios afectados
  - Revenue impact
  - Error budget consumido: X%

## Timeline (UTC)
  14:00 - Deploy
  14:05 - Alerta dispara       (detection time: 5 min)
  14:07 - On-call acknowledges (TTAck: 2 min)
  14:15 - Root cause           (investigation: 8 min)
  14:25 - Servicio restaurado  (TTR: 25 min)

## Root Cause (mecanismo técnico, no síntoma)
## What Went Well
## What Went Poorly
## Action Items (owner + due date obligatorio)
```

**Reglas:**
- Escrito dentro de las **48 horas** del incidente
- Root cause = mecanismo real, no el síntoma (`"pool agotado por load inesperado"`, no `"DB falló"`)
- Todo action item sin owner y fecha → nunca se hace
- Sin follow-through de action items → el mismo incidente vuelve

---

## 7. Game Days (ensayos de incidentes)

**Framework de tres fases:**

```
PLANNING:
  - Elegir escenario (DB overload, disk full, memory leak)
  - Definir inyección de falla
  - Límites de seguridad (staging, auto-revert en 30 min)
  - No decirle al equipo cuál es la falla

EXECUTION:
  - Inyectar falla → equipo sigue proceso normal
  - Observar: detection time, efectividad del triage
  - Documentar gaps en dashboards, alertas, runbooks

REVIEW:
  - Debrief: ¿qué fue claro / confuso?
  - Actualizar dashboards, alertas y runbooks
  - Agendar próximo (mensual recomendado)
```

La regla de no decirles la causa fuerza a practicar el proceso completo, no solo la solución técnica.

---

## 8. Runbooks efectivos

Estructura de un runbook accionable:

```markdown
# Runbook: High Error Rate (> 1%)
Alert: HighErrorRate | Severity: Critical

## Quick Assessment (< 2 min)
1. Abrir SLO dashboard → ¿budget < 10%? → urgente
2. ¿Hubo deploy reciente? → sospechoso principal

## Investigation Steps (queries exactas)
# Endpoints afectados:
topk(5, sum by (endpoint)(rate(http_requests_total{status=~"5.."}[5m])))

# Logs de error:
{service="api"} |= "error" | json | status >= 500

# Fallas downstream:
rate(http_client_requests_total{status=~"5.."}[5m])

## Remediation (comandos listos)
Bad deploy     → kubectl rollout undo deployment/api
Downstream     → habilitar circuit breaker
Resource exh.  → kubectl scale deployment/api --replicas=5

## Escalation
Si no se resuelve en 15 min → page @team-platform
```

**La diferencia clave:** queries y comandos exactos, no instrucciones vagas. Un engineer que nunca vio esta alerta debe poder seguirlo a las 3am sin contexto previo.

---

## 9. Detección automatizada avanzada

Cuatro patrones que van más allá de thresholds simples:

**Anomaly detection** — desviación del histórico:
```promql
abs(rate(metric[5m]) - rate(metric[5m] offset 7d))
> 3 * stddev_over_time(rate(metric[5m])[7d:1h])
```

**Composite alerts** — múltiples señales:
```promql
rate(errors[5m]) / rate(total[5m]) > 0.01
AND rate(total[5m]) > 100   # evita falsos positivos con poco tráfico
```

**Absence detection** — el más crítico:
```promql
absent(up{job="critical-service"}) == 1
```
Un servicio completamente caído deja de enviar métricas → error rate = 0% → ningún threshold dispara. `absent()` detecta el silencio como señal.

**Rate of change** — cambios emergentes:
```promql
deriv(rate(http_requests_total{status=~"5.."}[5m])[15m:1m]) > 0.5
```
Detecta antes de que se supere el threshold absoluto.

---

## 10. Cultura blameless

Los cinco principios:

1. **Asumir buena intención** — las personas tomaron las mejores decisiones con la info que tenían
2. **Sistema, no individuo** — `"el proceso no tenía validación"`, no `"Alice pusheó algo roto"`
3. **"Cómo" en vez de "quién"** — `"¿cómo lo prevenimos?"`, no `"¿quién aprobó esto?"`
4. **Recompensar transparencia** — penalizar reportes = problemas ocultos = incidentes mayores
5. **Completar action items** — sin follow-through, los postmortems pierden credibilidad

**Métricas de salud cultural:**

| Métrica | Target |
|---|---|
| Tiempo hasta postmortem publicado | < 5 días |
| % de action items completados en deadline | > 80% |
| Near-misses reportados voluntariamente | Cuanto más, mejor |

---

## Flujo completo de un incidente

```
Alerta dispara (o usuario reporta)
        ↓
TRIAGE (< 2 min): SLO dashboard → Golden Signals → deploy annotations → blast radius
        ↓
INVESTIGATE: Métricas → Logs → Trazas (drill-down con queries del runbook)
        ↓
MITIGATE: Parar el sangrado primero (rollback / scale / circuit breaker)
        ↓
REVIEW: Postmortem en < 48hs → action items con owner y fecha
        ↓
FOLLOW-UP: Completar action items → actualizar runbook → game day para validar
```
