"use client";

import { Code, ConnectError } from "@connectrpc/connect";
import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { boardClient } from "@/lib/client";

const BOARD_SIZE = 50;
const DEFAULT_COLOR = "#FFFFFF";
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const NOTICE_MS = 2_600;

/** 16 colores. */
const PALETTE: readonly string[] = [
  "#FFFFFF",
  "#D4D4D4",
  "#888888",
  "#222222",
  "#FF0000",
  "#FF8C00",
  "#FFD700",
  "#00AA00",
  "#00CED1",
  "#0000FF",
  "#8A2BE2",
  "#FF1493",
  "#8B4513",
  "#006400",
  "#FF69B4",
  "#00FFFF",
];

const FIRST_COLOR = PALETTE[0] ?? DEFAULT_COLOR;

type ConnectionStatus = "connecting" | "connected" | "reconnecting";

interface Cell {
  readonly x: number;
  readonly y: number;
}

/** Espera cancelable: al abortar se resuelve de inmediato. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export default function Board() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Colores de las 2500 celdas: la fuente de verdad en el cliente.
  const colorsRef = useRef<string[]>(
    new Array<string>(BOARD_SIZE * BOARD_SIZE).fill(DEFAULT_COLOR),
  );
  const activeColorRef = useRef<string>(FIRST_COLOR);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeColor, setActiveColor] = useState<string>(FIRST_COLOR);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [notice, setNotice] = useState<string>("");
  const [noticeVisible, setNoticeVisible] = useState<boolean>(false);
  const [hover, setHover] = useState<Cell | null>(null);

  const paintCell = useCallback((x: number, y: number, color: string): void => {
    const context = canvasRef.current?.getContext("2d");
    if (context === undefined || context === null) return;
    context.fillStyle = color;
    // 1 celda = 1 píxel del canvas: el canvas tiene 50x50 reales y el CSS lo escala.
    context.fillRect(x, y, 1, 1);
  }, []);

  const redrawAll = useCallback((): void => {
    const context = canvasRef.current?.getContext("2d");
    if (context === undefined || context === null) return;
    const cells = colorsRef.current;
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        context.fillStyle = cells[y * BOARD_SIZE + x] ?? DEFAULT_COLOR;
        context.fillRect(x, y, 1, 1);
      }
    }
  }, []);

  const applyRemotePixel = useCallback(
    (x: number, y: number, color: string): void => {
      if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) return;
      colorsRef.current[y * BOARD_SIZE + x] = color;
      paintCell(x, y, color);
    },
    [paintCell],
  );

  const showNotice = useCallback((message: string): void => {
    setNotice(message);
    setNoticeVisible(true);
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNoticeVisible(false), NOTICE_MS);
  }, []);

  /** Coordenadas de pantalla -> celda (el canvas se escala por CSS). */
  const cellFromEvent = useCallback((event: MouseEvent<HTMLCanvasElement>): Cell | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * BOARD_SIZE);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * BOARD_SIZE);
    if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) return null;
    return { x, y };
  }, []);

  useEffect(() => {
    activeColorRef.current = activeColor;
  }, [activeColor]);

  // Carga inicial + stream en vivo con reconexión y espera creciente.
  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let disposed = false;

    const run = async (): Promise<void> => {
      while (!disposed && !controller.signal.aborted) {
        setStatus(attempt === 0 ? "connecting" : "reconnecting");
        try {
          // 1) Estado inicial.
          const board = await boardClient.getBoard({}, { signal: controller.signal });
          for (const pixel of board.pixels) {
            if (pixel.x >= 0 && pixel.y >= 0 && pixel.x < BOARD_SIZE && pixel.y < BOARD_SIZE) {
              colorsRef.current[pixel.y * BOARD_SIZE + pixel.x] = pixel.color;
            }
          }
          redrawAll();
          setStatus("connected");

          // 2) Stream en vivo. Al abortar, Connect cancela el RPC en el servidor.
          const pixels = boardClient.watchBoard({}, { signal: controller.signal });
          for await (const pixel of pixels) {
            applyRemotePixel(pixel.x, pixel.y, pixel.color);
            setStatus("connected");
          }
          // El servidor cerró el stream: reconectamos.
          setStatus("reconnecting");
        } catch {
          if (controller.signal.aborted || disposed) return;
          setStatus("reconnecting");
        }

        attempt += 1;
        const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
        await sleep(delay, controller.signal);
      }
    };

    void run();

    return () => {
      disposed = true;
      controller.abort();
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    };
  }, [applyRemotePixel, redrawAll]);

  const handleCanvasClick = useCallback(
    async (event: MouseEvent<HTMLCanvasElement>): Promise<void> => {
      const cell = cellFromEvent(event);
      if (cell === null) return;

      const color = activeColorRef.current;
      const index = cell.y * BOARD_SIZE + cell.x;
      const previous = colorsRef.current[index] ?? DEFAULT_COLOR;

      // Pintado optimista: el stream confirmará el resultado.
      colorsRef.current[index] = color;
      paintCell(cell.x, cell.y, color);

      try {
        await boardClient.paintPixel({ pixel: { x: cell.x, y: cell.y, color } });
      } catch (error) {
        // Revertimos el píxel optimista.
        colorsRef.current[index] = previous;
        paintCell(cell.x, cell.y, previous);
        if (error instanceof ConnectError && error.code === Code.ResourceExhausted) {
          showNotice("Espera un momento antes de pintar de nuevo");
        } else {
          showNotice("No se pudo pintar. Comprueba la conexión.");
        }
      }
    },
    [cellFromEvent, paintCell, showNotice],
  );

  const handleCanvasMove = useCallback(
    (event: MouseEvent<HTMLCanvasElement>): void => {
      const cell = cellFromEvent(event);
      setHover((previous) =>
        previous !== null && cell !== null && previous.x === cell.x && previous.y === cell.y
          ? previous
          : cell,
      );
    },
    [cellFromEvent],
  );

  const statusLabel =
    status === "connected"
      ? "Conectado"
      : status === "connecting"
        ? "Conectando..."
        : "Reconectando...";

  const cursorStyle =
    hover !== null
      ? { transform: "translate(" + hover.x * 100 + "%, " + hover.y * 100 + "%)" }
      : undefined;

  return (
    <div className="board-card">
      <div className="board-card__bar">
        <span className={"pill pill--" + status}>
          <span className="pill__dot" />
          {statusLabel}
        </span>
        <span className={hover !== null ? "coords coords--on" : "coords"}>
          {hover !== null ? "x " + hover.x + " · y " + hover.y : "—"}
        </span>
      </div>

      <div className="board-frame">
        <canvas
          ref={canvasRef}
          className="board-frame__canvas"
          width={BOARD_SIZE}
          height={BOARD_SIZE}
          onClick={handleCanvasClick}
          onMouseMove={handleCanvasMove}
          onMouseLeave={() => setHover(null)}
          aria-label="Pizarra de píxeles de 50 por 50"
        />

        <div className="board-frame__grid" aria-hidden="true" />

        <div
          className={
            hover !== null ? "board-frame__cursor board-frame__cursor--on" : "board-frame__cursor"
          }
          style={cursorStyle}
          aria-hidden="true"
        />

        <div
          className={noticeVisible ? "toast toast--on" : "toast"}
          role="status"
          aria-live="polite"
        >
          <span className="toast__mark">!</span>
          <span>{notice}</span>
        </div>
      </div>

      <div className="board-card__foot">
        <div className="palette" role="listbox" aria-label="Paleta de colores">
          {PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              role="option"
              aria-selected={color === activeColor}
              aria-label={"Color " + color}
              className={color === activeColor ? "swatch swatch--active" : "swatch"}
              style={{ backgroundColor: color }}
              onClick={() => setActiveColor(color)}
            />
          ))}
        </div>

        <span className="hex">
          <span className="hex__chip" style={{ backgroundColor: activeColor }} />
          {activeColor}
        </span>
      </div>
    </div>
  );
}
