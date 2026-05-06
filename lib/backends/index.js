// Chat data-source backends.
//
// A backend encapsulates the DATA tools the agent has access to
// (list_properties, list_units, search_tenants, list_work_orders, etc.)
// and how those tools are actually executed. Orchestration tools like
// notify_team and make_call live in lib/breezeAgent.js because they
// work identically across every data source.
//
// Each backend module exports a single object shaped like:
//
//   {
//     name: 'appfolio' | 'rm-demo' | ...,
//     displayName: string,
//     description: string,       // shown in the toggle UI
//     getTools(): Promise<Tool[]>,        // Anthropic tool definitions
//     executeTool(name, input): Promise<result>,
//     systemPromptAddendum: string,       // appended to SYSTEM_PROMPT
//   }

import * as appfolio from './appfolio.js';
import * as rmDemo from './rmDemo.js';
import * as breezePostgres from './breezePostgres.js';
import * as zohoMcp from './zohoMcp.js';

const BACKENDS = {
  'appfolio': appfolio,
  'rm-demo': rmDemo,
  'breeze': breezePostgres,
  'zoho-mcp': zohoMcp,
};

export const DEFAULT_BACKEND = 'appfolio';

export function getChatBackend(name) {
  const key = name || DEFAULT_BACKEND;
  const backend = BACKENDS[key];
  if (!backend) {
    throw new Error(
      `Unknown chat backend "${key}". Valid options: ${Object.keys(BACKENDS).join(', ')}`,
    );
  }
  return backend;
}

export function listBackends() {
  return Object.entries(BACKENDS).map(([name, b]) => ({
    name,
    displayName: b.displayName,
    description: b.description,
  }));
}

