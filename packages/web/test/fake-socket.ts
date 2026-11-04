import type { SocketLike } from "../src/hooks/useServer.js";

// A scriptable socket: the test decides when it opens, what arrives and when it drops.
export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static get latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error("no socket was created");
    return socket;
  }
}

export const createFakeSocket = (url: string): SocketLike => new FakeSocket(url);
