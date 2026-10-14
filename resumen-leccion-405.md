# Resumen — Lección 405: Observability as Code

## 1. Por qué versionar la config de monitoring

**Sin version control:**
```
Dashboard editado en UI       → sin historial de cambios
Alerta tweakeada manualmente  → otro engineer la revierte sin saberlo
Grafana DB corrupta           → todos los dashboards perdidos
Nuevo entorno                 → recrear todo manualmente
```

**Con version control:**
```
Audit trail completo  → quién cambió qué y por qué
Code review           → alertas revisadas antes de deployar
Rollback              → git revert para un dashboard roto
Reproducible          → stack idéntico en nuevo entorno con un comando
CI validation         → errores detectados antes de llegar a producción
```

**Estructura de directorios recomendada:**
```
monitoring/
  grafana/
    provisioning/
      datasources/datasources.yml
      dashboards/provider.yml
    dashboards/
      overview/*.json
      services/*.json
  prometheus/
    prometheus.yml
    rules/
      sli-recording.yml
      error-budget.yml
      slo-alerts.yml
      service-alerts.yml
  alertmanager/
    alertmanager.yml
  otel-collector/
    config.yml
  terraform/
    main.tf
  .github/workflows/
    validate-monitoring.yml
```

---

## 2. Grafana datasource provisioning

Un único YAML reemplaza toda la configuración manual de datasources. Lo más valioso es el **cableado de correlación entre señales**:

```yaml
# Prometheus → Tempo (exemplars clickeables)
exemplarTraceIdDestinations:
  - name: traceID
    datasourceUid: tempo

# Loki → Tempo (trace_id extraído de logs)
derivedFields:
  - datasourceUid: tempo
    matcherRegex: '"trace_id":"(\w+)"'
    name: TraceID

# Tempo → Loki y Prometheus (navegación inversa)
tracesToLogs:
  datasourceUid: loki
tracesToMetrics:
  datasourceUid: prometheus
```

`editable: false` evita drift entre el código y lo que está corriendo.

**El loop completo de correlación:**
```
Métrica → click en exemplar → Traza en Tempo
Traza   → tracesToLogs      → Logs en Loki
Log     → derived field     → Traza en Tempo
```

---

## 3. Grafana dashboard provisioning

```yaml
providers:
  - name: 'overview'
    folder: 'Overview'
    editable: true
    updateIntervalSeconds: 30
    options:
      path: /var/lib/grafana/dashboards/overview
```

**Workflow de exportación:**
```
1. Editar en la UI
2. Share > Export > Save to file
3. Limpiar el JSON:
   - Eliminar campo "id"    → es instance-specific
   - Fijar "uid" estable    → "slo-overview" (no "abc123xyz")
4. Guardar en grafana/dashboards/<folder>/<name>.json
5. Commit → Grafana recarga en < 30 segundos
```

UID estable es crítico — los links entre dashboards usan el UID. Si cambia, todos los links se rompen.

---

## 4. Prometheus config as code

```yaml
rule_files:
  - '/etc/prometheus/rules/*.yml'   # wildcard: agregar archivo = nueva categoría
```

Reglas separadas por propósito:
```
rules/
  sli-recording.yml   ← SLIs de la lección 401
  error-budget.yml    ← burn rate y budget remaining
  slo-alerts.yml      ← alertas 14.4x y 3x
  service-alerts.yml  ← alertas específicas del servicio
```

**Aplicar cambios sin restart:**
```bash
curl -X POST http://localhost:9090/-/reload
# o
docker compose kill -s SIGHUP prometheus
```

---

## 5. Alertmanager config as code

```yaml
route:
  receiver: 'default-slack'
  routes:
    - match: {severity: critical} → pagerduty (repeat: 15m)
    - match: {severity: warning}  → slack      (repeat: 4h)

inhibit_rules:
  - source_match: {severity: critical}
    target_match: {severity: warning}
    equal: ['alertname', 'service']   # critical suprime warnings del mismo servicio
```

**Secrets — nunca commitear valores reales:**
```bash
# Alertmanager NO soporta env vars nativas
# Usar envsubst, Helm templates, o Vault antes de deployar

envsubst < alertmanager.yml.tpl > alertmanager.yml
```

El archivo en Git tiene `${SLACK_WEBHOOK_URL}`, nunca el valor real.

---

## 6. OTel Collector config patterns

```yaml
processors:
  memory_limiter:          # siempre primero — safety net de producción
    limit_mib: 1000
    spike_limit_mib: 200

  batch:                   # eficiencia: bufferear antes de exportar
    timeout: 5s

service:
  pipelines:
    traces:   receivers: [otlp]              → exporters: [otlp/tempo]
    metrics:  receivers: [otlp, prometheus]  → exporters: [prometheusremotewrite]
    logs:     receivers: [otlp]              → exporters: [loki]
```

`memory_limiter` va **primero siempre** — dropea datos antes de crashear el Collector.

Pipelines separados por señal: si el exporter de Loki falla, traces y métricas siguen funcionando.

Naming de exporters: `otlp/tempo`, `otlp/jaeger` permite múltiples destinos del mismo tipo.

---

## 7. Terraform para Grafana

Terraform gestiona el ciclo de vida completo (crear, actualizar, eliminar) con preview de cambios:

```hcl
resource "grafana_folder" "overview" {
  title = "Overview"
}

resource "grafana_dashboard" "slo_overview" {
  folder      = grafana_folder.overview.id
  config_json = file("../grafana/dashboards/overview/slo-overview.json")
}

resource "grafana_notification_policy" "default" {
  group_by      = ["alertname", "service"]
  contact_point = "team-slack"
  policy {
    matcher { label = "severity", match = "=", value = "critical" }
    contact_point = "pagerduty"
  }
}
```

| Caso de uso | Herramienta |
|---|---|
| Dashboards y datasources simples | Provisioning (YAML + JSON) |
| Alert rules con dependencias | Terraform |
| Notification policies | Terraform |
| Folders y permisos | Terraform |

State remoto obligatorio en equipos: S3, GCS o Terraform Cloud.

---

## 8 y 9. CI validation + herramientas de validación

**GitHub Actions — corre en cada PR que toca `monitoring/**`:**

```yaml
- name: Validate Prometheus config
  run: promtool check config prometheus.yml

- name: Validate Prometheus rules
  run: promtool check rules rules/*.yml

- name: Validate Alertmanager config
  run: amtool check-config alertmanager.yml

- name: Validate OTel Collector config
  run: otelcol validate --config config.yml

- name: Validate dashboard JSON
  run: python3 -m json.tool dashboard.json > /dev/null
```

**Validación de routing de Alertmanager:**
```bash
amtool config routes test \
  --config.file=alertmanager.yml \
  severity=critical service=api
# → pagerduty-critical ✓
```

**Unit tests de alertas con datos de ejemplo:**
```bash
promtool test rules tests/slo-alerts-test.yml
# Verifica que la alerta REALMENTE dispara con los valores esperados
# no solo que el YAML tiene sintaxis válida
```

**Pre-commit hook — errores en segundos antes del commit:**
```bash
# .git/hooks/pre-commit
promtool check rules prometheus/rules/*.yml || exit 1
```

**Jerarquía de validación:**
```
pre-commit hook     → sintaxis (segundos, local)
CI en PR            → sintaxis + routing + lógica (minutos, antes de merge)
promtool test rules → regresiones en comportamiento (en CI)
```

---

## 10. GitOps workflow completo

```
1. git checkout -b monitoring/add-checkout-slo-alert

2. Editar prometheus/rules/slo-alerts.yml
   Editar grafana/dashboards/overview/slo-overview.json

3. Validar localmente
   promtool check rules prometheus/rules/*.yml

4. git commit + push

5. Pull Request
   CI valida automáticamente
   Teammate revisa threshold y lógica
   Aprobación requerida

6. Merge → deploy automático
   ArgoCD / Flux / scripts recargan servicios

7. Verificar
   Prometheus targets → healthy
   Grafana → paneles cargan
   Alertmanager status → nueva ruta visible
```

**Principio central:** Git es la única fuente de verdad. Nadie edita configs directamente en el servidor.

**Branch protection obligatoria:**
```
✓ CI checks deben pasar
✓ Mínimo 1 aprobación
✓ Sin pushes directos a main
```

---

## Evolución del lab a lo largo del curso

```
Lecciones 101-403 → configuraste todo el stack manualmente
Lección 404       → aprendiste a usar el stack en incidentes reales
Lección 405       → formalizaste todo bajo version control con CI/CD
```

El stack de observabilidad ahora tiene el mismo nivel de rigor de ingeniería que el código de producción que monitorea.
