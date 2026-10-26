import type { z } from 'zod';
import { mcpServerSchema, type McpServerConfig } from './mcp.js';

export interface PresetDefinition {
  description: string;
  config: z.input<typeof mcpServerSchema>;
}

export const OFFICIAL_PRESETS: Record<string, PresetDefinition> = {
  memory: {
    description: 'Knowledge graph memory with persistent entity and relation tracking',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      readOnlyTools: [],
      timeoutMs: 30_000,
      disableSampling: false,
    },
  },
  sequentialthinking: {
    description: 'Dynamic multi-step reasoning scratchpad with revisions and branching',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      readOnlyTools: ['sequentialthinking'],
      timeoutMs: 30_000,
      disableSampling: false,
    },
  },
  fetch: {
    description: 'Web content fetching and HTML-to-markdown conversion with robots.txt compliance',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
      readOnlyTools: ['fetch'],
      timeoutMs: 30_000,
      disableSampling: false,
    },
  },
  git: {
    description: 'Git repository operations (diff, status, log, commit)',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git'],
      readOnlyTools: ['git_status', 'git_diff', 'git_log'],
      timeoutMs: 30_000,
      disableSampling: false,
    },
  },
  filesystem: {
    description: 'Secure directory and file access restricted to specified paths',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      readOnlyTools: ['read_file', 'list_directory'],
      timeoutMs: 30_000,
      disableSampling: false,
    },
  },
  time: {
    description: 'Time queries and timezone conversions',
    config: {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      readOnlyTools: ['get_current_time'],
      timeoutMs: 30_000,
      disableSampling: false,
    },
  },
  everything: {
    description: 'Reference MCP server demonstrating tools, resources, and prompts',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      readOnlyTools: ['echo'],
      timeoutMs: 30_000,
      disableSampling: false,
    },
  },
};

export function resolvePreset(name: string): McpServerConfig {
  const normalized = name.toLowerCase().replace(/[-_]/g, '');
  const key = Object.keys(OFFICIAL_PRESETS).find(k => k.toLowerCase().replace(/[-_]/g, '') === normalized);
  if (!key || !OFFICIAL_PRESETS[key]) {
    const available = Object.keys(OFFICIAL_PRESETS).join(', ');
    throw new Error(`Unknown MCP preset: "${name}". Available presets: ${available}`);
  }
  return mcpServerSchema.parse(OFFICIAL_PRESETS[key].config);
}

export function listPresets(): Array<{ name: string; description: string }> {
  return Object.entries(OFFICIAL_PRESETS).map(([name, def]) => ({
    name,
    description: def.description,
  }));
}
