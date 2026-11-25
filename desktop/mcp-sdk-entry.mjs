// Narrow entrypoint bundled into desktop/build/app/mcp-sdk.cjs by desktop/prepare.mjs
// so the packaged Electron app stays dependency-free while using the official MCP SDK.
export { Server } from '@modelcontextprotocol/sdk/server/index.js';
export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
export {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
