import { Chat } from "./components/Chat.js";
import { useServer } from "./hooks/useServer.js";

export function App() {
  const server = useServer();
  return <Chat server={server} />;
}
