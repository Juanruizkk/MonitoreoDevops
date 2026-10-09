# Resumen — Lección 204: Alerting with Alertmanager

## 1. Arquitectura del sistema de alertas

Prometheus y Alertmanager tienen responsabilidades separadas:

```
Prometheus              Alertmanager           Receivers
+-----------+          +---------------+      +--------+
| Alert     |  fires   | Route         |      | Slack  |
| Rules     | -------> | Group         | ---> | Email  |
| (PromQL)  |          | Deduplicate   |      | PagerD |
+-----------+          | Silence       |      | Webhook|
                       | Inhibit       |      +--------+
                       +---------------+
```

| Componente | Responsabilidad |
|---|---|
| **Prometheus** | Evalúa reglas PromQL → decide cuándo una alerta está `pending` o `firing` |
| **Alertmanager** | Recibe alertas `firing` → enruta, agrupa, deduplica, silencia, inhibe |
| **Receivers** | Slack, Email, PagerDuty, Webhook — destino final de la notificación |

### Estados de una alerta
- `inactive` → la condición PromQL es falsa
- `pending` → la condición es verdadera, pero no cumplió el tiempo del `for:`
- `firing` → estuvo verdadera todo el `for:` → se envía a Alertmanager

La separación permite reiniciar uno sin afectar al otro. Prometheus puede tener múltiples Alertmanagers para alta disponibilidad.

---

## 2. Configuración del stack

### Archivos modificados
| Archivo | Cambio |
|---|---|
| `alertmanager.yml` | Creado — define routes, receivers, inhibit_rules |
| `docker-compose.yml` | Agregado servicio `alertmanager` en puerto `:9093` |
| `config/prometheus.yml` | Agregada sección `alerting:` + scrape job de alertmanager |

### Conexión Prometheus → Alertmanager (`config/prometheus.yml`)
```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]
```
Prometheus **pushea** alertas a Alertmanager (no pull) cada `evaluation_interval` (15s).

Alertmanager también se agrega como scrape target para meta-monitoreo — si Alertmanager se cae, querés saberlo.

---

## 3. Anatomía de una alerting rule

```yaml
- alert: HighErrorRate           # nombre (aparece en Alertmanager y notificaciones)
  expr: <PromQL> > 0.05          # condición — cuando es true → pending
  for: 2m                        # debe ser true 2 min continuos → firing
  labels:
    severity: critical           # usado por Alertmanager para enrutar
    team: backend
  annotations:
    summary: "..."               # título corto para la notificación
    description: "{{ $value | humanizePercentage }}"  # Go template con el valor actual
    runbook_url: "..."           # link al runbook — lo primero que mira on-call
```

El `for:` previene flapping — un pico momentáneo no dispara la alerta.

### Reglas creadas (`rules/alerting-rules.yml`)

**Grupo `http_alerts`:**
| Alerta | Threshold | `for` | Severity |
|---|---|---|---|
| `HighErrorRate` | error rate > 5% | 2m | critical |
| `ElevatedErrorRate` | error rate > 1% | 5m | warning |
| `NoRequestsReceived` | rate == 0 | 5m | critical |

**Grupo `latency_alerts`:**
| Alerta | Threshold | `for` | Severity |
|---|---|---|---|
| `HighP99Latency` | P99 > 1s | 3m | critical |
| `ElevatedP50Latency` | P50 > 500ms | 5m | warning |

**Grupo `endpoint_alerts`:**
| Alerta | Condition | `for` | Severity |
|---|---|---|---|
| `EndpointDown` | `probe_success == 0` | 1m | critical |
| `SSLCertExpiringSoon` | cert expiry < 30 días | 1h | warning |

### Go templates en annotations
- `{{ $value | humanizePercentage }}` → muestra el valor actual como porcentaje
- `{{ $value | humanizeDuration }}` → muestra el valor como duración legible
- `{{ $labels.instance }}` → incluye dinámicamente qué endpoint (o lo que sea) disparó la alerta

### ¿Por qué dos alertas para error rate?
`ElevatedErrorRate` (warning, 1%) avisa antes de llegar al nivel crítico. Da tiempo de investigar sin urgencia — y puede llegar solo a Slack en vez de despertar a alguien.

---

## 4. Routing en Alertmanager

El routing es un árbol. Las alertas caen al primer match y paran (`continue: false`). Si ninguna sub-ruta matchea, van al receiver del nivel raíz (top-level route).

```yaml
route:
  receiver: "default-webhook"         # top-level: catch-all si nada matchea
  group_by: ["alertname", "job"]
  group_wait: 10s
  group_interval: 30s
  repeat_interval: 4h
  routes:
    - match:
        severity: critical
      receiver: "critical-webhook"
      group_wait: 5s                  # críticas: menos espera
      repeat_interval: 1h             # críticas: re-notifica más seguido
      continue: false
    - match:
        severity: warning
      receiver: "warning-webhook"
      continue: false
    - match:
        team: platform
      receiver: "platform-webhook"
      continue: false
```

### Parámetros de timing
| Parámetro | Significado |
|---|---|
| `group_wait` | Espera antes de enviar la primera notificación (agrupa alertas que llegan juntas) |
| `group_interval` | Mínimo entre notificaciones del mismo grupo cuando llegan alertas nuevas |
| `repeat_interval` | Cada cuánto re-notifica una alerta que sigue en `firing` |

### `continue: false` vs `continue: true`
- `continue: false` → matchea la primera ruta y para
- `continue: true` → sigue evaluando las siguientes rutas — útil para notificar a múltiples receivers a la vez

---

## 5. Inhibition rules

Suprimen alertas menores cuando una mayor ya notificó — reduce ruido en cascada.

```yaml
inhibit_rules:
  # Si HighErrorRate está firing, suprime ElevatedErrorRate del mismo job
  - source_match:
      alertname: HighErrorRate
    target_match:
      alertname: ElevatedErrorRate
    equal: ["job"]

  # Si EndpointDown está firing, suprime alertas de latencia para ese endpoint
  - source_match:
      alertname: EndpointDown
    target_match_re:
      alertname: ".*Latency.*"
    equal: ["instance"]
```

`equal: ["job"]` significa "solo inhibe si ambas alertas tienen el mismo valor en esa label". Evita que una alerta de un servicio suprima alertas de otro.

---

## 6. Silences y Grouping

### Silences
Suprimen notificaciones para alertas que matcheen ciertos labels, durante una ventana de tiempo. La alerta sigue `firing` en Prometheus — solo se bloquea la notificación.

Usos: mantenimientos programados, incidentes conocidos donde ya se está trabajando.

```bash
# Crear via API (o desde la UI en http://localhost:9093/#/silences)
curl -X POST 'http://localhost:9093/api/v2/silences' \
  -H 'Content-Type: application/json' \
  -d '{
    "matchers": [{"name": "severity", "value": "warning", "isRegex": false}],
    "startsAt": "...",
    "endsAt": "...",
    "createdBy": "admin",
    "comment": "Planned maintenance window"
  }'
```

Siempre agregar un `comment` — explica por qué existe el silence.

### Grouping
Sin grouping, una cascada de 100 endpoints caídos genera 100 notificaciones separadas. Con `group_by`, Alertmanager espera `group_wait` y manda una sola notificación con todos listados.

```
Sin grouping:                    Con grouping:
📱 EndpointDown: endpoint-1      📱 EndpointDown (x100)
📱 EndpointDown: endpoint-2          endpoint-1, endpoint-2 ... endpoint-100
...100 mensajes
```

### Resumen de los tres mecanismos de reducción de ruido

| Mecanismo | Dónde se configura | Cuándo aplica |
|---|---|---|
| **Grouping** | `alertmanager.yml` — permanente | Múltiples alertas similares disparan juntas |
| **Inhibition** | `alertmanager.yml` — permanente | Alerta mayor suprime menor relacionada |
| **Silence** | UI o API — temporal | Mantenimiento planificado, incidente conocido |

---

## 7. Symptom-based vs cause-based alerting

El concepto más importante del módulo.

| | Symptom-based | Cause-based |
|---|---|---|
| **Pregunta** | ¿El usuario está sufriendo ahora? | ¿Algo interno está fuera de rango? |
| **Ejemplo** | Error rate > 5% | CPU > 80% |
| **Problema** | Ninguno — es una buena alerta | CPU alto puede significar que todo va bien |
| **Ruido** | Bajo | Alto |

CPU > 80% es útil como señal de diagnóstico *después* de que dispara una alerta de síntoma. No como alerta por sí sola.

### Framework para decidir
```
¿Un usuario está afectado AHORA?
  ├── Sí      → alerta crítica, pagear (critical)
  ├── Tal vez → warning (ticket, no página)
  └── No      → solo dashboard, sin alerta (info)
```

Viene del SRE Book de Google: *"Every page should be actionable and urgent."*

---

## 8. Alert fatigue y best practices

Alert fatigue es el mayor riesgo operativo en monitoring. Cuando el equipo recibe demasiadas alertas de bajo valor, aprende a ignorarlas todas — incluyendo las críticas.

### Síntomas de alert fatigue
- Ingenieros mutan notificaciones "temporalmente" (permanentemente)
- Más de 2 páginas por turno de on-call por semana
- On-call es paginado fuera de hora por no-incidentes
- Nadie revisa las alertas

### Las tres reglas (de Google SRE)
1. **Accionable** — si no podés hacer nada al respecto, no pages
2. **Requiere inteligencia humana** — si se puede automatizar, automatizalo
3. **Urgente** — si puede esperar hasta mañana, es un ticket, no una página

### Guía de severidades
| Nivel | Cuándo pagear | Tiempo de respuesta |
|---|---|---|
| `critical` | Impacto real en usuarios AHORA | Humano en 5 minutos |
| `warning` | Se volverá crítico si no se atiende en horas | Ticket, no página |
| `info` | Interesante pero no accionable | Solo dashboard |

### Mantenimiento de alertas
- Revisión trimestral: ¿cuáles alertas dispararon? ¿Eran accionables?
- Borrar alertas que no dispararon útilmente
- Ajustar thresholds en alertas que disparan demasiado seguido
- Toda alerta crítica debe tener runbook antes de ir a producción

---

## 9. Runbooks

Documento que le dice al ingeniero de on-call exactamente qué hacer cuando esa alerta dispara.

Contenido típico:
- Qué significa la alerta
- Qué queries correr, qué dashboards mirar
- Pasos de remediación
- Cuándo escalar y a quién

Se linkea desde la alerta con `runbook_url:` — aparece clickeable en la notificación de Slack/PagerDuty.

```yaml
annotations:
  runbook_url: "https://wiki.internal/runbooks/high-error-rate"
```

Sin runbook → el on-call entra en modo pánico. Con runbook → entra con un plan.

---

## 10. Archivos del lab

| Archivo | Qué hace |
|---|---|
| `alertmanager.yml` | Config completa: routes, receivers, inhibit_rules |
| `rules/alerting-rules.yml` | 7 alertas en 3 grupos: http, latency, endpoint |
| `config/prometheus.yml` | Sección `alerting:` + scrape job de alertmanager |
| `docker-compose.yml` | Servicio `alertmanager` en `:9093` |

### UIs disponibles
- `http://localhost:9090/alerts` → estado de alertas en Prometheus (inactive/pending/firing)
- `http://localhost:9093` → Alertmanager UI — alertas activas, silences, routing
- `http://localhost:9093/#/silences` → crear y gestionar silences

### Comandos útiles
```bash
# Generar errores para disparar HighErrorRate
for i in $(seq 1 50); do curl -s -o /dev/null -w '%{http_code} ' http://localhost:4000/error; done

# Verificar alertas en Prometheus
curl -s 'http://localhost:9090/api/v1/alerts' | python3 -m json.tool

# Verificar alertas en Alertmanager
curl -s 'http://localhost:9093/api/v2/alerts' | python3 -m json.tool
```
