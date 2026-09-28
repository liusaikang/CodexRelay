import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const {values} = parseArgs({options:{question:{type:'string'},session:{type:'string'}}});
if (!process.env.CODEX_MCP_TOKEN) throw new Error('Set CODEX_MCP_TOKEN');
const client = new Client({name:'codexrelay-example',version:'1.0.0'});
async function call(name,args) {
  const response = await client.callTool({name,arguments:args});
  if (response.isError) throw new Error(JSON.stringify(response.content));
  return response.structuredContent.data;
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',process.env.CODEX_MCP_URL || 'http://127.0.0.1:8787'), {
    requestInit:{headers:{Authorization:`Bearer ${process.env.CODEX_MCP_TOKEN}`}},
  }));
  if (!values.question) console.log((await client.listTools()).tools.map(tool => tool.name).join('\n'));
  else {
    let task = await call('codex_submit_task',{question:values.question,...(values.session ? {sessionId:values.session} : {}),idempotencyKey:randomUUID()});
    console.log(`Accepted ${task.taskId}; session ${task.sessionId}`);
    const deadline = Date.now()+15*60*1000;
    while (['running','queued'].includes(task.status)) {
      if (Date.now() >= deadline) throw new Error(`Client wait expired; task ${task.taskId} continues on the server.`);
      await delay(2000);
      task = await call('codex_get_task',{taskId:task.taskId});
    }
    console.log(task.status,task.result?.markdown || task.error?.message || 'No result');
  }
} finally { await client.close(); }
