import path from 'node:path';
import { HOME } from '../config.js';
import { expandedAgents } from './expanded.js';

export type AgentKind = 'cli' | 'ide' | 'extension' | 'desktop' | 'mcp';

export interface AgentDef {
  id: string;
  name: string;
  vendor: string;
  kind: AgentKind;
  binNames?: string[];
  processNames?: string[];
  configPaths?: string[];
  logPaths?: string[];
  description?: string;
  costParser?: string;
  integration?: IntegrationDef;
}

export interface ConfigSource {
  file: string;
  format: 'json' | 'jsonc' | 'yaml';
  kind: 'mcp' | 'zed' | 'goose' | 'pi' | 'junie';
  shared?: boolean;
}

export interface IntegrationDef {
  platforms: NodeJS.Platform[];
  installPaths: string[];
  binDirs: string[];
  configs: ConfigSource[];
  sessionPaths?: string[];
  activity: 'pi' | 'unverified';
  notes: string;
}

const join = (...p: string[]) => path.join(HOME, ...p);

export const REGISTRY: AgentDef[] = [
  // ───────── CLIs ─────────
  {
    id: 'claude-cli',
    name: 'Claude Code',
    vendor: 'Anthropic',
    kind: 'cli',
    binNames: ['claude', 'claude.exe', 'claude.cmd'],
    processNames: ['claude', 'claude.exe'],
    configPaths: [join('.claude'), join('.config', 'claude')],
    logPaths: [
      join('.claude', 'logs'),
      join('.claude', 'projects'),
      // Xcode Claude integration writes transcripts here on macOS.
      join('Library', 'Developer', 'Xcode', 'CodingAssistant', 'ClaudeAgentConfig', 'projects'),
    ],
    costParser: 'claude',
    description: "Anthropic's terminal coding agent (Claude Code).",
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    vendor: 'GitHub',
    kind: 'cli',
    binNames: ['copilot', 'copilot.exe', 'copilot.cmd', 'gh'],
    processNames: ['copilot', 'copilot.exe', 'node'],
    configPaths: [join('.copilot'), join('.config', 'github-copilot')],
    logPaths: [join('.copilot', 'session-state'), join('.copilot', 'logs')],
    costParser: 'copilot',
    description: 'GitHub Copilot terminal agent.',
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    kind: 'cli',
    binNames: ['codex', 'codex.exe', 'codex.cmd'],
    processNames: ['codex', 'codex.exe'],
    configPaths: [join('.codex')],
    logPaths: [join('.codex', 'sessions'), join('.codex', 'log')],
    costParser: 'codex',
    description: "OpenAI's terminal coding agent.",
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    kind: 'desktop',
    processNames: ['Cursor.exe', 'Cursor', 'cursor'],
    configPaths: [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Cursor') : '',
      join('Library', 'Application Support', 'Cursor'),
      join('.config', 'Cursor'),
    ].filter(Boolean),
    costParser: 'cursor',
    description: 'AI-first code editor.',
  },
  {
    id: 'aider',
    name: 'Aider',
    vendor: 'paul-gauthier',
    kind: 'cli',
    binNames: ['aider', 'aider.exe'],
    processNames: ['aider', 'aider.exe', 'python.exe'],
    configPaths: [join('.aider')],
    logPaths: [join('.aider')],
    costParser: 'aider',
    description: 'Open-source pair programmer in your terminal.',
  },
  {
    id: 'continue',
    name: 'Continue',
    vendor: 'Continue.dev',
    kind: 'extension',
    configPaths: [join('.continue')],
    description: 'Open-source AI assistant for IDEs.',
  },
  {
    id: 'cline',
    name: 'Cline',
    vendor: 'Cline',
    kind: 'extension',
    configPaths: [
      join('.vscode', 'extensions'),
      join('AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    ],
    description: 'Autonomous coding agent in VS Code.',
  },
  {
    id: 'cody',
    name: 'Cody',
    vendor: 'Sourcegraph',
    kind: 'extension',
    configPaths: [join('.vscode', 'extensions')],
    description: 'Sourcegraph AI coding assistant.',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'opencode-ai',
    kind: 'cli',
    binNames: ['opencode', 'opencode.exe'],
    processNames: ['opencode', 'opencode.exe'],
    configPaths: [join('.config', 'opencode'), join('.opencode')],
    description: 'Open-source AI coding agent for the terminal.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    vendor: 'Codeium',
    kind: 'desktop',
    processNames: ['Windsurf.exe', 'Windsurf'],
    configPaths: [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Windsurf') : '',
    ].filter(Boolean),
    description: 'AI-powered code editor.',
  },

  // ───────── CLIs (new) ─────────
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    kind: 'cli',
    binNames: ['gemini', 'gemini.exe', 'gemini.cmd'],
    processNames: ['gemini', 'gemini.exe'],
    configPaths: [join('.gemini'), join('.config', 'gemini')],
    logPaths: [join('.gemini', 'logs'), join('.gemini', 'sessions')],
    costParser: 'gemini',
    description: "Google's terminal coding agent.",
  },
  {
    id: 'antigravity-cli',
    name: 'Antigravity CLI',
    vendor: 'Google',
    kind: 'cli',
    binNames: ['antigravity', 'antigravity.exe', 'antigravity.cmd', 'ag'],
    processNames: ['antigravity', 'antigravity.exe'],
    configPaths: [join('.antigravity'), join('.config', 'antigravity')],
    logPaths: [join('.antigravity', 'logs')],
    description: "Google's Antigravity terminal agent.",
  },

  // ───────── Desktop apps (new) ─────────
  {
    id: 'chatgpt-desktop',
    name: 'ChatGPT Desktop',
    vendor: 'OpenAI',
    kind: 'desktop',
    processNames: ['ChatGPT.exe', 'ChatGPT'],
    configPaths: [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'ChatGPT') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ChatGPT') : '',
      join('Library', 'Application Support', 'ChatGPT'),
      join('.config', 'ChatGPT'),
    ].filter(Boolean),
    description: "OpenAI's desktop ChatGPT app.",
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    vendor: 'Anthropic',
    kind: 'desktop',
    processNames: ['Claude.exe', 'Claude'],
    configPaths: [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude') : '',
      join('Library', 'Application Support', 'Claude'),
      join('.config', 'Claude'),
    ].filter(Boolean),
    description: "Anthropic's desktop Claude app.",
  },
  {
    id: 'codex-desktop',
    name: 'Codex Desktop',
    vendor: 'OpenAI',
    kind: 'desktop',
    processNames: ['Codex.exe', 'Codex'],
    configPaths: [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Codex') : '',
      join('Library', 'Application Support', 'Codex'),
      join('.config', 'Codex'),
    ].filter(Boolean),
    description: "OpenAI's desktop Codex app.",
  },
  {
    id: 'ollama-desktop',
    name: 'Ollama Desktop',
    vendor: 'Ollama',
    kind: 'desktop',
    binNames: ['ollama', 'ollama.exe'],
    processNames: ['ollama.exe', 'ollama', 'ollama app.exe', 'Ollama.exe'],
    configPaths: [
      join('.ollama'),
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Ollama') : '',
      join('Library', 'Application Support', 'Ollama'),
    ].filter(Boolean),
    description: 'Run local LLMs on your desktop.',
  },
  {
    id: 'poe-desktop',
    name: 'Poe Desktop',
    vendor: 'Quora',
    kind: 'desktop',
    processNames: ['Poe.exe', 'Poe'],
    configPaths: [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Poe') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Poe') : '',
      join('Library', 'Application Support', 'Poe'),
    ].filter(Boolean),
    description: "Quora's Poe desktop app.",
  },

  // ───────── IDEs / extensions (new) ─────────
  {
    id: 'antigravity-ide',
    name: 'Antigravity IDE',
    vendor: 'Google',
    kind: 'desktop',
    processNames: ['Antigravity.exe', 'Antigravity'],
    configPaths: [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Antigravity') : '',
      join('Library', 'Application Support', 'Antigravity'),
      join('.config', 'Antigravity'),
    ].filter(Boolean),
    description: "Google's Antigravity AI IDE.",
  },
  {
    id: 'gemini-code-assist',
    name: 'Gemini Code Assist',
    vendor: 'Google',
    kind: 'extension',
    configPaths: [
      join('.vscode', 'extensions'),
      join('.gemini'),
    ],
    description: "Google's IDE coding assistant (formerly Duet AI).",
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    vendor: 'GitHub',
    kind: 'extension',
    configPaths: [
      join('.vscode', 'extensions'),
      join('.config', 'github-copilot'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'github.copilot') : '',
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'github.copilot-chat') : '',
    ].filter(Boolean),
    description: 'GitHub Copilot IDE extension.',
  },
  {
    id: 'codex-extension',
    name: 'Codex (IDE)',
    vendor: 'OpenAI',
    kind: 'extension',
    configPaths: [
      join('.vscode', 'extensions'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'openai.chatgpt') : '',
    ].filter(Boolean),
    description: 'OpenAI Codex IDE extension.',
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    vendor: 'Roo Code',
    kind: 'extension',
    configPaths: [
      join('.vscode', 'extensions'),
      process.env.APPDATA ? path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline') : '',
    ].filter(Boolean),
    description: 'Autonomous AI coding agent in VS Code.',
  },

  // ───────── "Claw" family ─────────
  {
    id: 'openclaw',
    name: 'OpenClaw',
    vendor: 'OpenClaw',
    kind: 'cli',
    binNames: ['openclaw', 'openclaw.exe'],
    processNames: ['openclaw', 'openclaw.exe'],
    configPaths: [join('.openclaw'), join('.config', 'openclaw')],
    description: 'Open-source Claw coding agent.',
  },
  {
    id: 'clawpilot',
    name: 'Clawpilot',
    vendor: 'Clawpilot',
    kind: 'cli',
    binNames: ['clawpilot', 'clawpilot.exe'],
    processNames: ['clawpilot', 'clawpilot.exe'],
    configPaths: [join('.clawpilot'), join('.config', 'clawpilot')],
    description: 'Clawpilot AI coding agent.',
  },
  {
    id: 'claw-nanobot',
    name: 'Claw / Nanobot',
    vendor: 'Nanobot',
    kind: 'cli',
    binNames: ['claw', 'claw.exe', 'nanobot', 'nanobot.exe'],
    processNames: ['claw', 'claw.exe', 'nanobot', 'nanobot.exe'],
    configPaths: [join('.claw'), join('.nanobot'), join('.config', 'nanobot')],
    description: 'Claw / Nanobot coding agent.',
  },
  ...expandedAgents(process.platform, HOME, process.env),
];

export function findById(id: string): AgentDef | undefined {
  return REGISTRY.find((a) => a.id === id);
}
