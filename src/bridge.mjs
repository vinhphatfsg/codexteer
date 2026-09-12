import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import WebSocket from "ws";

const MAX_MESSAGE = 64 * 1024 * 1024;

// Desktop owns initialization and every server-initiated approval/tool response.
// The subscription adapter may consume its own thread/resume response; all other
// responses and every notification/request are forwarded to Desktop unchanged.
export async function relay(input, output, socket, { onDesktopMessage = () => {}, onServerMessage = () => {} } = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let outputQueue = Promise.resolve();
  let outputBytes = 0;
  let fail;
  let finished = false;
  const failure = new Promise((_, reject) => { fail = reject; });
  // Attach before asynchronous iteration starts; errors must also break blocked reads.
  const onError = () => fail(new Error("Desktop relay connection failed."));
  const onClose = () => { if (!finished) fail(new Error("Desktop relay connection closed.")); };
  const onMessage = (buffer, binary) => {
    try {
      if (binary) throw new Error("Unexpected binary App Server frame.");
      const text = buffer.toString();
      const parsed = JSON.parse(text);
      if (onServerMessage(parsed) === false) return;
      // JSON.parse is only for routing. Preserve number literals (including
      // integers above JS's safe range), escaping and unknown fields on the wire.
      // Actual CR/LF in valid JSON can only be whitespace outside strings.
      const line = text.replace(/[\r\n]/g, "") + "\n";
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > MAX_MESSAGE * 2) throw new Error("Desktop relay output buffer limit exceeded.");
      socket.pause();
      outputQueue = outputQueue.then(async () => {
        if (!output.write(line)) await once(output, "drain");
        outputBytes -= Buffer.byteLength(line);
        if (outputBytes === 0 && socket.readyState === WebSocket.OPEN) socket.resume();
      });
      outputQueue.catch(fail);
    } catch { fail(new Error("Invalid or oversized App Server relay message.")); }
  };
  socket.on("message", onMessage);
  socket.on("error", onError);
  socket.on("close", onClose);
  output.on("error", onError);
  const send = async line => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_MESSAGE) throw new Error("Desktop relay input limit exceeded.");
    let parsed;
    try { parsed = JSON.parse(line); } catch { throw new Error("Invalid Desktop protocol message."); }
    onDesktopMessage(parsed);
    await new Promise((resolve, reject) => socket.send(line, error => error ? reject(new Error("Desktop relay send failed.")) : resolve()));
  };
  const copyInput = async () => {
    for await (const chunk of input) {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        await send(line);
      }
      if (Buffer.byteLength(pending) > MAX_MESSAGE) throw new Error("Desktop relay input limit exceeded.");
    }
    pending += decoder.end();
    if (pending.trim()) await send(pending);
    await outputQueue;
  };
  try { await Promise.race([copyInput(), failure]); } finally {
    finished = true;
    socket.off("message", onMessage);
    socket.off("error", onError);
    socket.off("close", onClose);
    output.off("error", onError);
    socket.terminate();
    // Unblock a pending stdin read when the server dies.
    input.destroy();
  }
}
