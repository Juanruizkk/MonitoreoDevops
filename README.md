# Observability Lab

Lab de observabilidad con Prometheus, Grafana y OpenTelemetry Collector corriendo en Docker Compose.

---

## ¿Qué es la observabilidad?

Observabilidad es la capacidad de entender qué está pasando **dentro** de un sistema mirando sus salidas externas. Se basa en tres señales:

| Señal | ¿Qué es? | Ejemplo |
|-------|----------|---------|
| **Métricas** | Números que cambian en el tiempo | CPU al 80%, 200 requests/seg |
| **Trazas** | El recorrido completo de un request | `/checkout` llamó a `stock-service` que tardó 300ms |
| **Logs** | Eventos con texto libre | `ERROR: pago fallido para user 42` |

---

## Servicios

### Prometheus

**¿Qué es?**
Base de datos de series temporales diseñada para métricas. Guarda números en el tiempo y permite consultarlos con su lenguaje propio llamado PromQL.

**¿Cómo funciona?**
Usa un modelo **pull**: cada cierto intervalo, Prometheus visita activamente los endpoints `/metrics` de cada servicio y extrae los datos. A esto se le llama *scraping*.

**¿Para qué sirve en este lab?**
Almacena todas las métricas que exporta el OTEL Collector, y también monitorea su propio estado interno.

**URL:** `http://localhost:9090`

---

### Grafana

**¿Qué es?**
Herramienta de visualización. No almacena datos por sí sola — se conecta a fuentes de datos como Prometheus y construye dashboards con gráficos, tablas y alertas.

**¿Cómo funciona?**
Conectás Prometheus como *data source*, escribís consultas PromQL, y Grafana las convierte en visualizaciones. También podés importar dashboards prediseñados desde grafana.com.

**¿Para qué sirve en este lab?**
Visualizar las métricas que Prometheus recolecta del OTEL Collector y de tus aplicaciones.

**URL:** `http://localhost:3001`
**Usuario:** `admin` | **Contraseña:** `admin`

---

### OpenTelemetry Collector (OTEL)

**¿Qué es?**
Un intermediario universal para telemetría. Recibe datos de tus aplicaciones y los enruta hacia uno o varios backends (Prometheus, Jaeger, Loki, etc.).

**¿Por qué existe?**
Sin OTEL, cada app necesita librerías distintas para cada backend. Con OTEL, tu app habla un solo protocolo (**OTLP**) y el Collector se encarga de distribuir los datos:

```
Tu App  ──OTLP──►  OTEL Collector  ──►  Prometheus (métricas)
                                    ──►  Jaeger     (trazas)
                                    ──►  Loki       (logs)
```

Si mañana cambiás de Jaeger a Zipkin, solo cambiás la config del Collector — el código de tu app no se toca.

**Puertos:**
- `4317` — recibe datos via gRPC (OTLP)
- `4318` — recibe datos via HTTP (OTLP)
- `8889` — expone métricas propias del Collector para que Prometheus las raspe

---

## Flujo completo

```
Tu App
  │
  │  SDK de OpenTelemetry (una sola librería)
  │  protocolo: OTLP
  ▼
OTEL Collector  (:4317 / :4318)
  │
  │  exporta métricas en formato Prometheus
  ▼
Prometheus  (:9090)
  │
  │  fuente de datos
  ▼
Grafana  (:3001)
```

---

## Estructura de archivos

```
observability-lab/
├── docker-compose.yml          # Define y conecta todos los servicios
└── config/
    ├── prometheus.yml          # Configuración de Prometheus
    └── otel-collector.yml      # Configuración del OTEL Collector
```

---

## Archivos de configuración

### `docker-compose.yml`

Define los tres servicios y los conecta en una red interna de Docker llamada `observability`.

Dentro de esa red, los servicios se comunican por nombre (ej: `otel-collector` como hostname), no por `localhost`. Cada uno expone sus puertos al host para que puedas acceder desde el navegador.

---

### `config/prometheus.yml`

```yaml
global:
  scrape_interval: 15s       # raspa métricas cada 15 segundos
  evaluation_interval: 15s   # evalúa reglas de alerta cada 15 segundos

scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]   # Prometheus se monitorea a sí mismo

  - job_name: "otel-collector"
    static_configs:
      - targets: ["otel-collector:8889"]  # métricas del OTEL Collector
```

**`scrape_interval`**: cada cuánto Prometheus visita los targets y les pide sus métricas.

**`evaluation_interval`**: cada cuánto evalúa si alguna regla de alerta se disparó (ej: "CPU > 90% por más de 2 minutos").

**`scrape_configs`**: lista de targets. Cada `job_name` agrupa un conjunto de servicios a monitorear. Se usa el nombre del servicio Docker (`otel-collector`) en lugar de `localhost` porque dentro de la red de Docker cada contenedor tiene su propio hostname.

---

### `config/otel-collector.yml`

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317   # escucha datos via gRPC
      http:
        endpoint: 0.0.0.0:4318   # escucha datos via HTTP

processors:
  batch:
    timeout: 5s              # espera hasta 5s antes de enviar un lote
    send_batch_size: 1024    # o hasta 1024 items, lo que ocurra primero

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889   # expone métricas para que Prometheus las raspe
  debug:
    verbosity: basic          # imprime en consola lo que pasa (útil para desarrollo)

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus, debug]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
```

El Collector tiene tres etapas encadenadas en **pipelines**:

1. **Receivers** — la puerta de entrada. Recibe datos de tus apps via OTLP (gRPC o HTTP).
2. **Processors** — transforma los datos antes de reenviarlos. El processor `batch` agrupa los datos para enviarlos en lotes en lugar de uno por uno, lo que es más eficiente.
3. **Exporters** — la salida. `prometheus` convierte las métricas al formato que Prometheus entiende y las expone en el puerto 8889. `debug` imprime en los logs del contenedor para que puedas ver qué está llegando.

Hay dos pipelines configurados:
- **metrics**: recibe métricas → las agrupa → las exporta a Prometheus y a la consola
- **traces**: recibe trazas → las agrupa → las imprime en consola (no hay backend de trazas aún)

---

## Levantar el lab

```bash
docker compose up -d
```

Verificar que los servicios están corriendo:

```bash
docker compose ps
```

Ver logs de un servicio específico:

```bash
docker compose logs otel-collector
docker compose logs prometheus
docker compose logs grafana
```

Bajar todo:

```bash
docker compose down
```

---

## Próximos pasos

- Conectar Prometheus como data source en Grafana
- Importar un dashboard para el OTEL Collector
- Instrumentar una aplicación con el SDK de OpenTelemetry y apuntarla al Collector en `localhost:4317`
