import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from './config.js';

export interface WorkspaceEntry {
  alias: string;
  path: string;
}

export interface WorkspaceConfig {
  defaultAlias: string;
  workspaces: WorkspaceEntry[];
}

export const WORKSPACES_CONFIG_PATH = path.join(CTI_HOME, 'workspaces.json');

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function isWorkspaceRecord(value: unknown): value is { alias?: unknown; path?: unknown } {
  return typeof value === 'object' && value !== null;
}

export function loadWorkspaceConfig(): WorkspaceConfig | null {
  if (!fs.existsSync(WORKSPACES_CONFIG_PATH)) {
    return null;
  }

  const raw = readJson(WORKSPACES_CONFIG_PATH);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Workspace config must be a JSON object');
  }

  const defaultAlias = typeof (raw as { defaultAlias?: unknown }).defaultAlias === 'string'
    ? (raw as { defaultAlias: string }).defaultAlias.trim()
    : '';
  const workspacesValue = (raw as { workspaces?: unknown }).workspaces;

  if (!defaultAlias) {
    throw new Error('Workspace config is missing defaultAlias');
  }
  if (!Array.isArray(workspacesValue) || workspacesValue.length === 0) {
    throw new Error('Workspace config must contain at least one workspace');
  }

  const seenAliases = new Set<string>();
  const workspaces = workspacesValue.map((item) => {
    if (!isWorkspaceRecord(item)) {
      throw new Error('Each workspace must be an object');
    }

    const alias = typeof item.alias === 'string' ? item.alias.trim() : '';
    const workspacePath = typeof item.path === 'string' ? item.path.trim() : '';

    if (!alias) {
      throw new Error('Workspace alias cannot be empty');
    }
    if (!workspacePath) {
      throw new Error(`Workspace path cannot be empty for alias: ${alias}`);
    }
    if (seenAliases.has(alias)) {
      throw new Error(`Duplicate workspace alias: ${alias}`);
    }
    if (!path.isAbsolute(workspacePath)) {
      throw new Error(`Workspace path must be absolute for alias: ${alias}`);
    }
    if (!fs.existsSync(workspacePath)) {
      throw new Error(`Workspace path does not exist for alias: ${alias}`);
    }

    const stats = fs.statSync(workspacePath);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory for alias: ${alias}`);
    }

    seenAliases.add(alias);
    return {
      alias,
      path: fs.realpathSync(workspacePath),
    };
  });

  if (!workspaces.some((workspace) => workspace.alias === defaultAlias)) {
    throw new Error(`Default workspace alias not found: ${defaultAlias}`);
  }

  return {
    defaultAlias,
    workspaces,
  };
}

export function getWorkspaceByAlias(config: WorkspaceConfig, alias: string): WorkspaceEntry | undefined {
  return config.workspaces.find((workspace) => workspace.alias === alias);
}

export function getDefaultWorkspace(config: WorkspaceConfig): WorkspaceEntry {
  const workspace = getWorkspaceByAlias(config, config.defaultAlias);
  if (!workspace) {
    throw new Error(`Default workspace alias not found: ${config.defaultAlias}`);
  }
  return workspace;
}
