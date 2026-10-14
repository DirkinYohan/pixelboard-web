import Board from "@/components/Board";

export default function HomePage() {
  return (
    <main className="page">
      <header className="hero">
        <h1 className="hero__title">Pixelboard</h1>
      </header>
      <Board />
      <p className="hint">Haz clic en una celda para pintar</p>
    </main>
  );
}
