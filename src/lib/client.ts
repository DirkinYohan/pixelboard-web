import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { BoardService } from "@/gen/board/v1/board_pb";

/**
 * URL del gateway (único servicio público). Se configura con NEXT_PUBLIC_API_URL.
 */
export const gatewayUrl: string =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

/**
 * PROTOCOLO: **Connect** (no grpc-web) sobre HTTP/1.1 usando `fetch`.
 *
 * Por qué:
 *  - El navegador no puede hablar gRPC nativo (necesita control de trailers HTTP/2
 *    que fetch no expone). Connect es un protocolo POST + streaming compatible con
 *    HTTP/1.1 y HTTP/2, así que funciona con cualquier CDN/plataforma sin Envoy ni
 *    proxies adicionales (grpc-web obligaría a un proxy traductor).
 *  - Connect soporta server streaming con `fetch` streaming, que es justo lo que
 *    necesita WatchBoard para recibir los píxeles en vivo.
 *  - Los errores viajan como JSON con `code`/mensaje, que es lo que leemos para
 *    detectar ResourceExhausted (límite de 1 píxel/s).
 *
 * Si en el futuro el gateway se sirve siempre por HTTP/2 end-to-end se puede pasar
 * a `createGrpcWebTransport` sin tocar el resto del código.
 */
export const transport = createConnectTransport({
  baseUrl: gatewayUrl,
});

export const boardClient = createClient(BoardService, transport);
