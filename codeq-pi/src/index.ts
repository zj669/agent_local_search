/**
 * Pi coding-agent extension: same-name grep / find / graph over the codeq daemon.
 * Do not start the daemon here — queryDaemon autostarts on first execute.
 */
import { queryDaemon } from "@zj669/codeq/src/client.js";
import { formatMcpToolResult } from "@zj669/codeq/src/mcp-format.js";
import { maybeRerank } from "@zj669/codeq/src/jev.js";
import { createCodeqExtension } from "./extension.js";

export { createCodeqExtension };

export default createCodeqExtension({
  query: queryDaemon,
  format: formatMcpToolResult,
  rerank: maybeRerank,
});
