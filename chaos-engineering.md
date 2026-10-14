# Chaos Engineering

## ¿Qué es?

Práctica de introducir fallas controladas en un sistema para descubrir debilidades antes de que las encuentre un incidente real.

**Origen:** Google descubrió que Chubby (su servicio de locks distribuidos) tenía uptime tan alto que los servicios dependientes nunca habían manejado su falla. Cuando ocurrió una caída real pequeña, generó una cascada masiva. La solución fue bajar Chubby *intencionalmente* cada ciertos meses para forzar a los equipos a construir resiliencia.

Netflix popularizó el concepto con **Chaos Monkey** (2011) — un proceso que mata instancias aleatorias en producción durante horario laboral.

**La lógica:** si tu sistema va a fallar eventualmente, es mejor que falle cuando vos elegís y hay ingenieros disponibles para responder.

---

## Principios básicos

1. **Hipótesis primero** — definí qué esperás que pase antes de inyectar la falla
2. **Empezá pequeño** — una instancia, un servicio, no todo el sistema
3. **Durante el día** — nunca a las 3am, siempre con ingenieros disponibles
4. **Radio de explosión controlado** — podé detener el experimento en cualquier momento
5. **Medí el impacto** — necesitás observabilidad para ver qué pasó

---

## Herramientas

### Chaos Monkey (Netflix)
La original. Mata instancias EC2 aleatorias.
- Repo: https://github.com/Netflix/chaosmonkey
- Requiere Spinnaker como dependency

### Chaos Toolkit
Más flexible, funciona con cualquier infraestructura.
```bash
pip install chaostoolkit
```
Define experimentos en JSON/YAML.

### Litmus Chaos (Kubernetes)
Chaos engineering nativo para K8s.
```bash
# Instalar via Helm
helm install litmuschaos litmuschaos/litmus
```

### Pumba (Docker)
**El más simple para empezar — funciona directo con Docker Compose.**
```bash
# Matar contenedores random cada 30 segundos
pumba --random kill --interval 30s re2:^observability

# Simular latencia de red en un contenedor
pumba netem --duration 1m delay --time 500 observability-lab-app-1

# Limitar ancho de banda
pumba netem --duration 1m rate --rate 100kbit observability-lab-app-1
```

---

## Experimentos básicos para este lab

### 1. ¿Qué pasa si Prometheus se cae?

```bash
# Parar Prometheus
docker stop observability-lab-prometheus-1

# Observar:
# - ¿Grafana muestra "No data" o error?
# - ¿Las alertas dejan de dispararse?
# - ¿La app Node.js sigue sirviendo requests?
# - ¿Cuánto tarda en recuperarse cuando lo levantás?

docker start observability-lab-prometheus-1
```

**Hipótesis:** Grafana pierde datos pero la app sigue funcionando. Las alertas se silencian.

### 2. ¿Qué pasa si Loki se cae?

```bash
docker stop observability-lab-loki-1

# Observar:
# - ¿La app sigue logueando? (los logs se pierden o se acumulan?)
# - ¿El OTel Collector reporta errores?
# - ¿Se recupera solo cuando Loki vuelve?
```

### 3. ¿Qué pasa si hay latencia de red?

```bash
# Con Pumba (si lo instalás)
pumba netem --duration 2m delay --time 1000 --jitter 500 observability-lab-app-1

# Sin Pumba — desde dentro del contenedor con tc (traffic control)
docker exec -it observability-lab-app-1 sh
tc qdisc add dev eth0 root netem delay 500ms
```

**Observar:** ¿Los SLIs de latencia se disparan? ¿Las alertas de burn rate se activan?

### 4. Simular errores en la app

```bash
# Endpoint que genera errores 5xx — podés agregar uno temporal a la app
curl http://localhost:4000/chaos/errors?rate=0.5  # 50% de requests fallan

# Observar:
# - ¿El SLI de availability cae?
# - ¿La burn rate sube?
# - ¿La alerta SLOBurnRateCritical se dispara?
```

---

## Cómo estructurar un experimento

```
1. Estado estable
   "El SLI de availability está en 99.9% y el burn rate es < 1"

2. Hipótesis
   "Si bajo Prometheus por 5 minutos, la app sigue sirviendo requests
    pero Grafana pierde visibilidad temporalmente"

3. Inyectar la falla
   docker stop observability-lab-prometheus-1

4. Observar
   - Métricas, logs, traces durante la falla
   - Tiempo de detección
   - Comportamiento de la app

5. Recuperar
   docker start observability-lab-prometheus-1

6. Análisis
   - ¿La hipótesis se cumplió?
   - ¿Qué no esperabas?
   - ¿Qué hay que mejorar?
```

---

## Relación con SLOs

Chaos engineering y SLOs se complementan:

- Los SLOs te dicen **cuánto podés fallar** (error budget)
- Chaos engineering te dice **cómo fallás** cuando algo sale mal

Un experimento de chaos consume error budget — por eso se hace con budget disponible (> 50% restante) y nunca cuando el budget está casi agotado.

---

## Por dónde empezar

1. **Primero:** asegurate de tener buena observabilidad (métricas, logs, traces) — sin eso no podés medir el impacto
2. **Segundo:** empezá en staging, no en producción
3. **Tercero:** el experimento más simple es parar un contenedor y ver qué pasa
4. **Después:** avanzar a latencia de red, pérdida de paquetes, corrupción de datos

Para este lab, el orden natural sería:
```
Parar Prometheus → Parar Loki → Simular latencia → Simular errores en la app
```
