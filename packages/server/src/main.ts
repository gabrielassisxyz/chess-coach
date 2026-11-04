import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp();

app.listen({ port, host: "127.0.0.1" }).then((address) => {
  console.log(`chess-coach server listening on ${address}`);
});
