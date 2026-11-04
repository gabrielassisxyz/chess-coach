import type { HealthResponse } from "@chess-coach/shared";
import { useEffect, useState } from "react";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <main>
      <h1>chess-coach</h1>
      <p>server: {health ? `${health.status} (${health.version})` : "unreachable"}</p>
    </main>
  );
}
