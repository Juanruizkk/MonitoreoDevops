# Resumen — Lección 203: Structured Logging

## 1. Logs estructurados con Pino

Un log estructurado es una línea **JSON** con campos fijos en lugar de texto libre. Así las herramientas pueden filtrar y correlacionar sin parsear strings.

```json
{"level":"error","time":"2026-09-28T12:44:31.204Z","service":"demo-app","trace_id":"4bf92f...","span_id":"11a067...","error":"CONNECTION_TIMEOUT","db_host":"postgres-primary","duration_ms":5000,"msg":"Database query failed"}
```

### Configuración usada (`logging/pino-example.js`)
```javascript
const logger = pino({
  level: 'info',                                // nivel mínimo que se escribe
  timestamp: pino.stdTimeFunctions.isoTime,     // time en ISO 8601 en vez de epoch
  formatters: {
    level(label) { return { level: label }; }   // "level":"info" en vez de "level":30
  }
}, pino.destination(logPath));
```

### Quién decide el nivel
El nivel **lo decide el desarrollador** al elegir el método: `logger.info()`, `logger.warn()`, `logger.error()`. Nadie lo calcula automáticamente.

| Nivel | Cuándo | Ejemplo |
|-------|--------|---------|
| `debug` | Detalle para investigar, apagado en producción | "Query SQL: SELECT ..." |
| `info` | Algo normal que vale la pena registrar | "Server started", "Request received" |
| `warn` | Algo raro que no rompió nada | "Reintento 2/3", "Respuesta lenta" |
| `error` | La operación falló | "Database query failed" |

Pino por defecto usa números: `30` = info, `40` = warn, `50` = error. El `formatters.level` los convierte a texto.

---

## 2. Pipeline de logs con el OTel Collector

```
App (JSON logs a stdout)
    │
    ▼
Docker guarda stdout en un archivo
    │
    ▼
OTel Collector (filelog receiver)
    │
    ▼
Loki (almacenamiento + consultas)  ◄── Grafana
```

### `logging/otel-log-config.yml` bloque por bloque

| Bloque | Componente | Qué hace |
|--------|-----------|----------|
| receivers | `filelog` | Lee `/var/log/containers/*.log` (glob) |
| operator | `json_parser` | Convierte la línea JSON en atributos; usa `time` como timestamp oficial |
| operator | `severity_parser` | Traduce `level` a la severidad estándar de OTel |
| processors | `batch` | Envía en grupos (cada 5s o 1024 logs) para no saturar el backend |
| processors | `resource` | Copia `service` → `service.name` |
| exporters | `loki` | Envía a Loki; `service` y `level` se vuelven labels |
| service | `pipelines.logs` | Conecta receiver → processors → exporter. Si un componente no está acá, no se usa |

### Qué hace el `severity_parser`
**No decide** la gravedad, solo **traduce** lo que la app ya escribió al campo estándar de OTel. Hace falta porque cada librería lo escribe distinto (`30`, `"WARNING"`, `"warn"`, `"ERR"`...).

```yaml
mapping:
  error: error   # izquierda: nivel OTel  ←  derecha: valor que aparece en el log
  warn: warn
# Si el log usara números de pino:
#   error: 50
#   warn: 40
#   info: 30
```

### ⚠️ Problemas del YAML tal como está (para cuando se levante de verdad)
1. **El exporter `loki` fue removido** de `otelcol-contrib`. Hoy se usa `otlphttp` apuntando a `http://loki:3100/otlp` (Loki 3.x acepta OTLP nativo).
2. **Docker envuelve cada línea**: `{"log":"{\"level\":...}\n","stream":"stdout","time":"..."}`. Hay que agregar el operator `container` antes del `json_parser`.
3. **`from_attribute: service` no lo encuentra**: el processor `resource` busca en atributos del *recurso*, pero `json_parser` deja `service` como atributo del *log*. Hace falta un operator `move`.

---

## 3. Loki

Base de datos de logs de Grafana Labs. Centraliza los logs de todos los servicios en un solo lugar.

### La clave: solo indexa las labels
- **Labels** (`service`, `level`): indexadas → filtro instantáneo
- **Contenido** (`msg`, `trace_id`, `db_host`...): comprimido, sin indexar → se recorre al buscar

**Ventaja:** mucho más barato que Elasticsearch (que indexa todo el texto).
**Regla:** labels solo con **pocos valores posibles**. Nunca `trace_id`, `user_id` o `request_id` como label — cada valor distinto crea un stream nuevo y Loki se vuelve lento.

### LogQL
```logql
# Todos los logs del servicio
{service="demo-app"}

# Solo errores
{service="demo-app", level="error"}

# Errores que mencionan "Database"
{service="demo-app", level="error"} |= "Database"

# Parsear JSON y filtrar por trace
{service="demo-app"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"
```

### Los tres pilares
| Herramienta | Guarda | Responde |
|-------------|--------|----------|
| Prometheus | Métricas | "¿Cuántos errores por minuto?" |
| Loki | Logs | "¿Qué error fue y con qué detalle?" |
| Tempo / Jaeger | Trazas | "¿En qué servicio se trabó la request?" |
| Grafana | Nada, visualiza | Todo en un mismo lugar |

Flujo típico: **métrica alerta → Loki explica → `trace_id` lleva a la traza**.

---

## 4. Context propagation

### El problema
Pasar `trace_id` a mano en cada log no escala: habría que pasarlo como parámetro por controller → servicio → repositorio → cliente HTTP. Un log sin él queda huérfano.

### La simulación (`context-propagation.js`)
Un logger "fábrica" que recuerda el contexto y lo inyecta en cada línea:
```javascript
function createContextLogger(baseContext) {
  return {
    info: (fields, msg) => console.log(JSON.stringify({
      level: 'info', time: new Date().toISOString(), msg,
      trace_id: baseContext.traceId,   // ← automático
      span_id: baseContext.spanId,     // ← automático
      ...fields                         // ← campos propios (va último: puede pisar los anteriores)
    })),
  };
}
```

### Por qué una variable global no sirve
Node atiende muchas requests concurrentes en un solo hilo. Con una variable global, la request B pisa el contexto de A mientras A espera la DB → logs mezclados.

### AsyncLocalStorage
Una "mochila" pegada a cada request: todo el código asíncrono que se desprende de ella (`await`, callbacks, promesas) ve **su propio** contexto.
```javascript
const { AsyncLocalStorage } = require('async_hooks');
const storage = new AsyncLocalStorage();

storage.run({ traceId: 'aaa' }, async () => {
  await algoLento();
  storage.getStore().traceId; // → 'aaa', aunque en el medio corrió otra request
});
```
En Java/Go: thread-local storage o `context` explícito.

### ¿Es un middleware?
No exactamente, pero se combinan:
- **Middleware** = código en la *entrada* de la request → **crea** el contexto
- **Propagación** = mecanismo que lo hace **llegar** a todo el código posterior

```javascript
app.use((req, res, next) => {
  const traceId = randomBytes(16).toString('hex');
  storage.run({ traceId }, () => next());   // todo lo que corre dentro de next() lo ve
});
```
Con solo middleware (`req.traceId = ...`) habría que pasar `req` a todas las funciones → volvemos al problema original.

### En una app real
- La instrumentación HTTP de OTel actúa como middleware automático: crea el trace y lo guarda en `AsyncLocalStorage`
- `@opentelemetry/instrumentation-pino` lee ese contexto e inyecta `trace_id`/`span_id` en cada log
- `pino-opentelemetry-transport` sirve para **enviar** los logs por OTLP (no es lo mismo que la inyección)

---

## 5. Campos significativos en logs (`meaningful-fields.js`)

```json
// ❌ MAL — imposible de investigar
{ "level": "error", "msg": "Payment failed for user" }

// ✅ BIEN — se entiende sin buscar más
{
  "level": "error", "msg": "Payment processing failed",
  "user_id": "usr_12345", "order_id": "ord_67890",
  "amount_cents": 4999, "currency": "USD",
  "payment_provider": "stripe", "error_code": "card_declined",
  "duration_ms": 1230, "retry_count": 2,
  "trace_id": "abc123def456", "request_id": "req_xyz789"
}
```

| Categoría | Campos |
|-----------|--------|
| **Siempre** | `trace_id`, `request_id`, `user_id`, `service` |
| **Errores** | `error_code`, `duration_ms`, `retry_count` |
| **Requests** | `method`, `path`, `status_code`, `duration_ms` |
| **Nunca** | Passwords, tokens, PII (emails completos), tarjetas, payloads grandes |

- **Identificadores** (`user_id`, `order_id`, `trace_id`) → permiten filtrar y correlacionar
- **Métricas operativas** (`duration_ms`, `retry_count`, `status_code`) → cuantifican el problema
- Cada campo cuesta almacenamiento: ser intencional
- Usar una librería de *redaction* para eliminar datos sensibles automáticamente (pino tiene la opción `redact`)
- Stack traces solo en `error`, no en `info`

---

## 6. OTel Log Bridge API

### La idea
Para trazas y métricas OTel trae **su propia API** (`tracer.startSpan()`, `meter.createCounter()`). Para logs **no**: el logging ya estaba resuelto (pino, Winston, log4j, slog), así que OTel ofrece un **puente** que conecta tu logger existente con su pipeline. Seguís escribiendo `logger.info()` igual.

```
Pino / Winston / Bunyan           ← tu logger, no cambia
       │
OTel Log Bridge API               ← adaptador: log de pino → LogRecord de OTel
       │
OTel Log SDK                      ← dentro de la app
(BatchLogRecordProcessor)            (mismo concepto que el processor batch del Collector)
       │
OTel Collector → Loki
```

El código del bridge normalmente lo escribe el autor del paquete adaptador, no el desarrollador de la app.

### Dos formas de llevar logs al Collector

| | 1. Por archivo (filelog) | 2. OTLP directo (bridge) |
|---|---|---|
| Flujo | App → stdout → Collector lee archivo | App → Bridge → red (OTLP) → Collector |
| Cambios en la app | Ninguno | Instalar y configurar SDK |
| Lenguajes | Cualquiera | Los que tengan SDK/bridge |
| Parseo | El Collector hace todo (json, severity, container...) | Llegan ya estructurados |
| Correlación con trazas | Solo si la app escribe `trace_id` | Automática |
| Si el Collector cae | Los logs esperan en el archivo | Quedan en memoria, se pueden perder |
| `docker logs` | Sigue funcionando | Depende de si también se loguea a stdout |

Receiver para OTLP directo (sin operators, los datos llegan listos):
```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
```

**Recomendación:** empezar por archivo. Pasar a OTLP cuando las apps ya tengan el SDK de OTel para trazas. Es común combinar: OTLP para apps propias, filelog para terceros (nginx, bases de datos).

**Sobre "STABLE":** la *especificación* está estable, pero en JS `@opentelemetry/api-logs` y `@opentelemetry/sdk-logs` estuvieron mucho tiempo en `0.x` (experimental). Verificar con `npm view @opentelemetry/sdk-logs version`.

---

## 7. Verificación de logs estructurados (`verify-logs.js`)

Simula el ciclo de vida completo de una request (`POST /api/orders`) con 8 logs: request → validación → cache → pago → **warn por retry** → pago ok → orden creada → respuesta 201.

### Checklist
- [ ] Cada línea es JSON válido
- [ ] Cada línea tiene: `timestamp`, `level`, `service`, `msg`, `trace_id`, `span_id`
- [ ] Todos los logs comparten el mismo `trace_id` (una sola request)
- [ ] Cada log tiene un `span_id` único
- [ ] Los logs warn/error tienen contexto accionable (ej: `reason: 'timeout'`, `duration_ms: 3000`)
- [ ] Sin datos sensibles

### Tips con jq
```bash
node verify-logs.js | jq .                # pretty-print + valida que sea JSON
node verify-logs.js | jq -r .trace_id     # extraer trace IDs para buscar en Tempo
```

---

## 8. Archivos del lab (`logging/`)

| Archivo | Qué hace |
|---------|----------|
| `pino-example.js` | Escribe 3 logs con pino a `app/logs/app.log` |
| `otel-log-config.yml` | Config del Collector: filelog → batch/resource → Loki |
| `context-propagation.js` | Logger que inyecta `trace_id`/`span_id` automáticamente en 4 logs |
| `meaningful-fields.js` | Compara un log bueno vs uno malo + guía de campos |
| `verify-logs.js` | Simula una request completa y muestra el checklist |

### Correrlos en Windows (desde `app\`)
```powershell
node ..\logging\pino-example.js
Get-Content .\logs\app.log -Tail 5
node ..\logging\context-propagation.js
node ..\logging\meaningful-fields.js
node ..\logging\verify-logs.js
```

### ⚠️ Gotcha: rutas del curso en Windows
El curso usa `~/observability-lab/...` (Linux). En PowerShell:
- `~` **no se expande** al pasarlo a `node` → `Cannot find module '...\app\~\observability-lab\...'`
- `process.env.HOME` normalmente **no existe** en Windows

Solución: rutas relativas al script con `__dirname`:
```javascript
const appDir = path.join(__dirname, '..', 'app');
const pino = require(require.resolve('pino', { paths: [appDir] }));
const logPath = path.join(appDir, 'logs', 'app.log');
```
Y crear la carpeta antes: `mkdir app\logs`.
