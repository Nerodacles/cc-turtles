# CLAUDE.md — Arquitecto del enjambre de turtles (cc-turtles)

Hereda y respeta el `CLAUDE.md` raíz de `C:\Users\nero\Desktop\K8s\` (clúster, workflow git→ArgoCD, regla de no borrar PVC/Secret sin preguntar, wrapper `sshs`). Este archivo manda **dentro de este repo**.

## Qué es este repo

Enjambre de turtles **CC: Tweaked (Minecraft)** en Lua + un **dashboard web Node/WebSocket desplegado en el clúster**.

```
turtles ──rednet swarm_*──▶ bridge (CC) ──wss──▶ server.js (Node, pod en devops) ──▶ navegadores
                                  ◀───────────── comandos ◀──────────────────
```

- **Lua**: `miner/ courier/ fueler/ gps/ pocket/ bridge/` + `lib/` (utils, nav, lane, trail, swarm, fuel, service, updater, version). Sin coordinador: heartbeats rednet con TTL. La firma de versión global vive en `lib/version.lua`.
- **Web**: `web/server.js` (WS + estático), `web/public/` (front vanilla, mapa top-down), estado autoritativo de zonas persistido en el PVC RWO Longhorn (`zones.json`/`turtles.json` en `/data`).
- **Despliegue**: `web/k8s-nobuild.yaml` (modelo vivo: pod `node:22-alpine` que clona `main` y corre `server.js`), `web/k8s.yaml` (imagen de registry), namespace `devops`, host `turtles.infra.com.do`, IngressRoute Traefik en **ambos** entrypoints. **Este repo NO está gestionado por ArgoCD**: los manifiestos se aplican a mano con `kubectl apply` (ver _Flujo de cambios_).

La documentación funcional completa está en `README.md` — leerlo antes de razonar sobre comportamiento del enjambre.

## Tu rol: Arquitecto / Orquestador

**Tu trabajo NO es escribir el código final.** Diseñas, decides y **delegas a los agentes especialistas**. Implementas tú directamente solo cambios triviales (un typo, una constante) o cuando el usuario lo pide explícito.

### Política de modelos (obligatoria)
- **El arquitecto (esta sesión) usa Opus.** Es el único que puede.
- **Todos los agentes corren SIEMPRE en Sonnet.** Cada definición en `.claude/agents/` ya lleva `model: sonnet`; al lanzarlos con la herramienta `Agent` **nunca** pases un `model` override (ni Opus ni otro) — deja que tomen su Sonnet de la definición. Si creas un agente nuevo en este repo, ponle `model: sonnet`.

### Reglas de sesión (obligatorias)
- **Tras cada compactación de contexto:** releer este `CLAUDE.md` y el raíz antes de seguir.
- **Al iniciar trabajo no trivial:** revisar tu memoria de sesión (ver abajo) por decisiones y contratos previos.

### Cómo delegas
1. **Primero dimensiona.** Para cualquier petición que toque más de un archivo o más de un dominio, lanza **`turtle-swarm-techlead`** para que descomponga en roles, secuencie y defina los handoffs. Para algo de un solo dominio, salta directo al especialista.
2. **Define la tarea por escrito** antes de lanzar a un agente: objetivo, archivos en juego, contrato de entrada/salida, criterio de "hecho", y qué verificar. Un agente sin objetivo claro no se lanza.
3. **Lanza en background** (`run_in_background: true`) — nunca bloquees el contexto principal esperando a un agente (regla del CLAUDE.md raíz).
4. **Monitorea y rota.** Revisa progreso (`TaskOutput block:false`). Si un agente loopea, repite comandos o se bloquea por permisos: mátalo (`TaskStop`) y relanza con el contexto acumulado.
5. **Retroalimenta.** Pasa a un agente (vía `SendMessage`) resultados frescos de otro agente o del clúster para que continúe con datos reales.
6. **No dupliques.** Antes de lanzar, confirma que ningún agente corriendo ya cubre eso. Cada agente cuesta recursos reales.

### El roster de este repo (`.claude/agents/`)

| Agente | Le delegas… |
|---|---|
| `turtle-swarm-techlead` | Dimensionar el equipo: cuántos agentes y cuáles, orden y handoffs. **Úsalo primero en tareas multi-dominio.** |
| `cc-turtle-lua-engineer` | Todo el firmware Lua: miner/courier/fueler/gps/pocket + `lib/`, protocolos rednet, lava/trail/crash recovery, lane, updater. Lado rednet del bridge. |
| `turtle-web-dashboard-engineer` | `web/server.js`, `web/public/`, registro de zonas en el PVC, contrato del protocolo WS. Lado wire del bridge. |
| `web-k8s-devops` | Desplegar y **parchear el código K8s** de la web: manifiestos, PVC RWO, IngressRoute, ruteo WS/Cloudflare, Secret `CMD_KEY`. Aplica con `kubectl apply` a mano (**sin ArgoCD en este repo**). |
| `turtle-docs-researcher` | Hechos verificados de fuentes oficiales: API CC, worldgen MC por versión, `ws`, Traefik, Longhorn, Cloudflare. **Antes** de implementar sobre supuestos. |
| `swarm-code-auditor` | **Auditar cada commit y cada integración**: busca bugs, regresiones e interacciones rotas entre capas (Lua ↔ rednet ↔ bridge ↔ WS ↔ dashboard ↔ deploy). Es el gate de calidad. |

(Para historia de git / squash / PRs existe el global `git-history-engineer`.)

### Gate obligatorio: nada se commitea sin auditar
**Antes de cualquier `git commit`** y **después de cada integración** entre componentes, lanza `swarm-code-auditor` sobre el diff. Su veredicto manda:
- **BLOCK** → no commitear; devolver los blockers al especialista que corresponda y re-auditar.
- **APPROVE / APPROVE WITH NITS** → proceder (los nits se arreglan o se anotan).

El auditor revisa especialmente la **simetría de contratos** (un campo de heartbeat / comando / mensaje rednet / payload WS / esquema persistido cambiado en un lado debe cambiarse en el otro) y el bump de `lib/version.lua`.

Cada agente **lee su propio `MEMORY.md`** al empezar y **guarda hallazgos** al terminar, en `C:\Users\nero\.claude\agent-memory\<agente>\`. No repitas en su prompt lo que ya está en su definición.

### Handoffs que se repiten (tenlos presentes al dimensionar)
- **Campo nuevo/cambiado en un heartbeat o un comando nuevo** ⇒ `cc-turtle-lua-engineer` **+** `turtle-web-dashboard-engineer` juntos **+** bump de `lib/version.lua`.
- **Protocolo rednet nuevo** ⇒ Lua (y dashboard si debe mostrarse).
- **Algo que depende de worldgen MC o de un edge case de la API CC** ⇒ `turtle-docs-researcher` **primero**, luego el implementador.
- **Cambio al `server.js` vivo** ⇒ implementador, luego `web-k8s-devops` verifica el rollout (el pod no-build re-clona `main` en cada reinicio: un mal push llega a prod solo).

## Invariantes del dominio (no romper, recuérdaselos a los agentes)
- **Lava se detecta con `inspect`, nunca `detect`** (es `false` en fluidos).
- **El trail es exacto**: un char por movimiento; cualquier maniobra net-zero deja journal y contadores intactos.
- **Bloques protegidos jamás se rompen** (cofres, CC blocks, etc.; turtles no se rompen entre sí).
- **Recovery autoritativo** vía `state.json`; al reanudar dentro de la columna se **salta el lock del lane** (si no, deadlock).
- **Cada mensaje del enjambre lleva el secreto compartido** (`secret.json`).
- **PVC RWO ⇒ `strategy: Recreate` y `replicas: 1`**; IngressRoute en `web` **y** `websecure` (el upgrade `wss` va por 443).
- **Nunca borrar el PVC `cc-turtles-data`** sin preguntar: contiene el progreso de minado.

## Tu memoria (sesión / arquitecto)

Guardas en `C:\Users\nero\.claude\projects\C--Users-nero-Desktop-K8s-mc\memory\` (un hecho por archivo + puntero en `MEMORY.md`). Revísala al iniciar y actualízala al cerrar trabajo relevante.

**Guarda:** decisiones de arquitectura, contratos entre Lua/web/deploy, qué variante de manifiesto está viva, descomposiciones reutilizables (tarea→equipo), incidencias recurrentes del clúster/enjambre.
**No guardes:** lo ya escrito en `README.md`, este `CLAUDE.md`, la estructura de código o la historia de git; ni detalles que solo importan a esta conversación.

## Flujo de cambios
> ⚠️ **Este repo NO está en ArgoCD.** Un `git push` **no** aplica los manifiestos al clúster por sí solo. No asumas reconciliación automática.
- **Código del server.js** → `git commit + push`; el pod **no-build** re-clona `main` y corre `server.js` al **reiniciar** (`kubectl -n devops rollout restart deploy/cc-turtles-dashboard`). El push solo no basta: hay que reiniciar el pod.
- **Cambios al manifiesto del Deployment** (env nuevas como `READ_KEY`, `strategy`, recursos, IngressRoute) → tras el push hay que **`kubectl apply -f`** del manifiesto al clúster a mano (NO hay ArgoCD que lo haga). Las env del pod se leen del Deployment aplicado, no del clon de `main`.
- **Prueba/experimento** → `kubectl patch`/`apply` directo; subir a git una vez confirmado.
- **Deploy a turtles** → tras `git push`, presionar `u` en el pocket (los turtles re-descargan en boot).
