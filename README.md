# pixelboard-web — frontend de Pixelboard (Next.js + Connect)

Pizarra colaborativa de píxeles estilo r/place: una cuadrícula de **50×50** donde varios usuarios pintan a la vez y todos ven los cambios **en tiempo real**.

Este repositorio es **sólo el frontend**. Habla con un único servicio, el `gateway-service` del repo `pixelboard-api`, mediante el **protocolo Connect** sobre `fetch`.

## Arquitectura

~~~text
┌──────────────────────────────────────────────┐
│  pixelboard-web (este repo)                  │
│  Next.js App Router · Client Component       │
│  <canvas> 50×50 · paleta de 16 colores       │
└───────────────────┬──────────────────────────┘
                    │  Connect sobre HTTP/1.1 (fetch)
                    │  GetBoard / PaintPixel / WatchBoard
                    ▼
        [pxb-gateway]  (pixelboard-api)
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  [board-service]        [ratelimit-service]
~~~

El frontend **sólo conoce `board.proto`**. Los contratos internos (`state` y `ratelimit`) viven únicamente en el backend.

## Por qué Connect (y no gRPC-web)

El navegador no puede hablar gRPC nativo: necesita control de *trailers* HTTP/2 que `fetch` no expone. **Connect** es un protocolo POST + streaming que funciona sobre **HTTP/1.1 y HTTP/2**, así que:

- No hace falta **Envoy ni ningún proxy traductor** (gRPC-web sí lo necesitaría).
- **Server streaming** funciona con `fetch` streaming, que es justo lo que necesita `WatchBoard`.
- Los errores llegan como JSON con `code`/`message`, que es lo que usamos para detectar `resource_exhausted`.

Se usa `createConnectTransport` de `@connectrpc/connect-web`. Si algún día el gateway se sirviera siempre por HTTP/2 end-to-end, se puede cambiar a `createGrpcWebTransport` sin tocar nada más.

## Estructura

~~~text
pixelboard-web/
├── proto/board/v1/board.proto    # copia del contrato público
├── buf.yaml
├── buf.gen.yaml                  # genera sólo board.proto en src/gen
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── globals.css
│   ├── components/Board.tsx      # Client Component con <canvas>
│   ├── lib/client.ts             # transporte y cliente Connect
│   └── gen/                      # código generado por buf (se commitea)
├── next.config.mjs
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
~~~

## Requisitos

- **Node.js ≥ 20.6** (probado con Node 24).
- **npm ≥ 10** (con npm 11 ver la nota de `allowScripts`).
- El **backend `pixelboard-api`** en marcha (en local, `http://localhost:8080`).

## Instalación

~~~bash
git clone <url-de-pixelboard-web>
cd pixelboard-web
npm install
~~~

> **npm 11 — scripts de instalación.** npm 11 exige aprobar los `postinstall`. `@bufbuild/buf` necesita el suyo para descargar el binario. El `package.json` ya incluye el bloque `allowScripts`; si aparece el aviso:
>
> ~~~bash
> npm install-scripts approve @bufbuild/buf
> npm install
> ~~~

## Generación de código

~~~bash
npm run generate
~~~

`buf.gen.yaml` genera **sólo `board.proto`** con `protoc-gen-es` v2 en `src/gen`. En el frontend se omite `import_extension` (`import_extension=none`) porque Next.js resuelve los imports sin extensión con `moduleResolution: bundler`; el backend, en cambio, usa `.js` por ser ESM nativo.

**El código generado se commitea** (`src/gen`) para que Vercel pueda construir el proyecto sin necesidad de ejecutar `buf`.

## Configuración

Copia el ejemplo y ajusta la URL del gateway:

~~~bash
cp .env.example .env.local
~~~

| Variable | Por defecto | Descripción |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | URL base del `gateway-service` (el único servicio público). |

## Ejecución local

~~~bash
# 1) Levanta el backend (en el repo pixelboard-api)
npm run dev          # gateway en :8080

# 2) Levanta el frontend
npm run dev          # http://localhost:3000
~~~

Si usas `docker compose` para el backend, el gateway también queda en `http://localhost:8080` y no hay que cambiar nada. El `ALLOWED_ORIGIN` del gateway debe incluir `http://localhost:3000`.

### Otros scripts

~~~bash
npm run typecheck    # tsc --noEmit
npm run build        # next build
npm run start        # next start (requiere haber hecho build)
~~~

## Cómo funciona la UI

### El canvas
El `<canvas>` tiene un *backing store* de **50×50 píxeles reales** (`width={50} height={50}`) y el CSS lo escala a ~600 px con `image-rendering: pixelated`. Así **1 celda = 1 píxel** y dibujar es simplemente `ctx.fillRect(x, y, 1, 1)`: rapidísimo y sin difuminado.

El clic se convierte de coordenadas de pantalla a celda con `getBoundingClientRect()`, así que sigue funcionando si el canvas se escala en móvil.

### Carga inicial y tiempo real
1. Al montar, `GetBoard` y se pintan todos los píxeles.
2. Después se abre `WatchBoard` (server streaming) y se pinta cada `Pixel` que llega.

### Pintado optimista
Al hacer clic se pinta **de inmediato** en local y se envía `PaintPixel`. El stream confirma el resultado.

- Si el servidor responde `ResourceExhausted` (`429`): se **revierte** el píxel y aparece el aviso *"Espera un momento antes de pintar de nuevo"*.
- Cualquier otro error: se revierte y se avisa de que no se pudo pintar.

### Reconexión automática
Si el stream se cae, se reintenta con **espera exponencial** (500 ms → 1 s → 2 s … hasta 10 s) y se refresca el estado con `GetBoard` en cada intento. El indicador superior muestra **Conectado / Conectando… / Reconectando…**.

Al desmontar (`cleanup` del `useEffect`) se hace `AbortController.abort()`: Connect cancela el RPC en el servidor y el `board-service` elimina el suscriptor.

### Paleta
16 colores fijos y selector de color activo. Cada color se envía como `#RRGGBB` (el backend lo normaliza a mayúsculas).

## Despliegue en Vercel

1. Importa el repositorio `pixelboard-web` en Vercel (framework **Next.js**, sin configuración extra).
2. Añade la variable de entorno de producción:
   - `NEXT_PUBLIC_API_URL` = `https://pixelboard-gateway-xxxxx.a.run.app` (la URL del gateway).
3. Deploy.
4. **Último paso:** actualiza el `ALLOWED_ORIGIN` del gateway con el dominio de Vercel:

~~~bash
gcloud run services update pixelboard-gateway --region us-central1 \
  --update-env-vars ALLOWED_ORIGIN=https://tu-app.vercel.app
~~~

> `NEXT_PUBLIC_*` se incrusta en el bundle en **tiempo de build**: si cambias la URL del gateway, hay que **volver a desplegar** en Vercel (no basta con editar la variable).

## Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| `blocked by CORS policy` en la consola del navegador | `ALLOWED_ORIGIN` del gateway no incluye el origen exacto (con `https://` y sin barra final) | Añadir el dominio en `ALLOWED_ORIGIN` del gateway. Ojo: `localhost:3000` y `127.0.0.1:3000` son orígenes distintos. |
| `Failed to fetch` / `ERR_CONNECTION_REFUSED` | `NEXT_PUBLIC_API_URL` mal o el backend no está levantado | Comprobar `curl http://localhost:8080/health`. |
| El indicador se queda en "Reconectando…" | El stream se corta (proxy, cold start, backend caído) | Es esperado: el cliente reintenta solo. Si es permanente, revisar el gateway. |
| `El stream se corta a los 30–60 s` | Un proxy intermedio cierra conexiones inactivas | El backoff reconecta; subir el timeout del proxy/balanceador. |
| Cambio `NEXT_PUBLIC_API_URL` y no surte efecto | Es build-time, no runtime | Volver a desplegar en Vercel. |
| `Cannot find module '@/gen/board/v1/board_pb'` | Falta el código generado | `npm run generate`. |
| `npm error … install-scripts` | npm 11 no ha aprobado el `postinstall` de `@bufbuild/buf` | `npm install-scripts approve @bufbuild/buf` y reinstalar. |
| Los píxeles de otros usuarios no aparecen | `board-service` desplegado con >1 instancia | `--max-instances=1` (el estado vive en memoria). |

## Ideas futuras

- Usuarios y autenticación (hoy el `client_id` es la IP).
- Zoom/pan del canvas y vista de coordenadas bajo el cursor.
- Historial de píxeles y "time-lapse" de la cuadrícula.
- Optimistic updates con cola local cuando el rate limit bloquea, en vez de revertir.
- Web Workers para repintar tableros grandes (1000×1000).
- Tests end-to-end con Playwright contra el gateway real.
