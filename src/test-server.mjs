// Minimal MCP server - tests if Claude Desktop MCP integration works at all
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'attendease-test', version: '1.0.0' });

server.tool(
  'list_registered',
  'List all registered guardians',
  {},
  async () => ({
    content: [{ type: 'text', text: '✅ MCP is working! No guardians registered yet.' }]
  })
);

server.tool(
  'notify_guardian',
  'Notify a guardian',
  {
    studentId: z.string(),
    studentName: z.string(),
    status: z.enum(['absent', 'late', 'present']),
    className: z.string(),
    date: z.string(),
  },
  async ({ studentId, studentName, status, className, date }) => ({
    content: [{ type: 'text', text: `✅ Would notify guardian of ${studentName} (${status} in ${className} on ${date})` }]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
