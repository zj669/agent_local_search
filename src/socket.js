import { connect } from "node:net";

export function openSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function socketIsLive(socketPath) {
  try {
    const socket = await openSocket(socketPath);
    socket.end();
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}
