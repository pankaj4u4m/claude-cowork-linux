/**
 * Claude Desktop Linux - IPC Handler Setup
 * 
 * Handles the electron-ipc wrapper pattern:
 *   $eipc_message$_<uuid>_$_<namespace>_$_<handler>
 * 
 * CRITICAL: Some handlers are SYNC (sendSync) not async (invoke)!
 * - Sync handlers need ipcMain.on() with event.returnValue = ...
 * - Async handlers need ipcMain.handle() with return value
 */

const { ipcMain, app, dialog, webContents } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_PREFIX = '[ipc-setup]';

// SDK bridge for Cowork sessions — spawns Claude Code subprocess
let sdkBridge = null;
try {
  process.stderr.write(`${LOG_PREFIX} loading SDK bridge...\n`);
  const { CoworkSDKBridge } = require('../cowork/sdk_bridge');
  sdkBridge = new CoworkSDKBridge();
  process.stderr.write(`${LOG_PREFIX} SDK bridge loaded: ${sdkBridge._claudeCmd}\n`);
} catch (e) {
  process.stderr.write(`${LOG_PREFIX} SDK bridge FAILED: ${e.message}\n${e.stack}\n`);
}

const APP_SUPPORT_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
const LOCAL_AGENT_STATE_DIR = path.join(APP_SUPPORT_ROOT, 'LocalAgentModeSessions');
const LOCAL_AGENT_STATE_FILE = path.join(LOCAL_AGENT_STATE_DIR, 'sessions.json');
const LEGACY_STATE_DIR = path.join(os.homedir(), '.local', 'share', 'claude-cowork', 'LocalAgentModeSessions');
const LEGACY_STATE_FILE = path.join(LEGACY_STATE_DIR, 'sessions.json');
const LEGACY_STATE_FILE_ALT = path.join(os.homedir(), '.local', 'share', 'claude-cowork', 'sessions.json');

// The UUID used in channel names - discovered from first IPC call
let discoveredUUID = null;

const MAIN_PROCESS_UUID = 'c42e5915-d1f8-48a1-a373-fe793971fdbd';
const MAIN_VIEW_UUID = '5fdd886a-1e8d-42a1-8970-2f5b612dd244';

// Known UUIDs from preload scripts - mainView uses a different UUID than main process
const KNOWN_UUIDS = [
  MAIN_VIEW_UUID, // mainView.js preload (for webview/claude.ai)
  MAIN_PROCESS_UUID, // main process preload
  // More UUIDs will be discovered dynamically
];

// Track registered channels
const registeredChannels = new Set();

function syncOk(result) {
  return { result, error: null };
}

function getUpdaterState() {
  return { status: 'idle' };
}

function getNavigationState() {
  return { canGoBack: false, canGoForward: false };
}

function getDefaultPreferences() {
  return {
    menuBarEnabled: false,
    legacyQuickEntryEnabled: false,
    chromeExtensionEnabled: false,
    quickEntryShortcut: 'off',
    quickEntryDictationShortcut: 'off',
    plushRaccoonEnabled: false,
    quietPenguinEnabled: false,
    louderPenguinEnabled: false,
    plushRaccoonOption1: 'off',
    plushRaccoonOption2: 'off',
    plushRaccoonOption3: 'off',
    sparkleHedgehogAppearance: 'default',
    sparkleHedgehogScale: 1,
    chillingSlothLocation: 'default',
    secureVmFeaturesEnabled: true,
    localAgentModeTrustedFolders: [],
  };
}

const localAgentState = {
  sessions: new Map(),
  trustedFolders: new Set(),
  focusedSessionId: null,
  envVars: {},
  sessionCounter: 0,
};

// Discover the asar's session storage dir for .claude/projects directory creation
const ASAR_SESSIONS_BASE = path.join(os.homedir(), '.config', 'Claude', 'local-agent-mode-sessions');

function discoverAsarSessionStorageDir() {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    if (!fs.existsSync(ASAR_SESSIONS_BASE)) return null;
    for (const userId of fs.readdirSync(ASAR_SESSIONS_BASE)) {
      if (!uuidRe.test(userId)) continue;
      const userDir = path.join(ASAR_SESSIONS_BASE, userId);
      if (!fs.statSync(userDir).isDirectory()) continue;
      for (const orgId of fs.readdirSync(userDir)) {
        if (!uuidRe.test(orgId)) continue;
        const orgDir = path.join(userDir, orgId);
        if (fs.statSync(orgDir).isDirectory()) return orgDir;
      }
    }
  } catch (_) {}
  return null;
}

const asarSessionStorageDir = discoverAsarSessionStorageDir();

function ensureAsarClaudeConfigDir(sessionId) {
  if (!asarSessionStorageDir) return null;
  const sessionDir = path.join(asarSessionStorageDir, sessionId);
  const claudeDir = path.join(sessionDir, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  try { fs.mkdirSync(projectsDir, { recursive: true, mode: 0o700 }); } catch (_) {}
  return claudeDir;
}

let localAgentStateLoaded = false;
let localAgentStateSaveTimer = null;
const LOCAL_AGENT_STATE_VERSION = 1;

const CLAUDE_VM_DOWNLOAD_STATUS = {
  notDownloaded: 'not_downloaded',
  downloading: 'downloading',
  ready: 'ready',
};

const CLAUDE_VM_RUNNING_STATUS = {
  offline: 'offline',
  booting: 'booting',
  ready: 'ready',
};

// Generate a proper UUID v4
function generateUUID() {
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(16);

  // Set version (4) and variant bits as per RFC 4122
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10

  const hex = bytes.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to create directory ${dirPath}:`, e.message);
  }
}

function normalizeLocalSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return `local_${generateUUID()}`;
  }
  if (sessionId.startsWith('local_')) {
    return sessionId;
  }
  return `local_${sessionId}`;
}

function serializeLocalAgentState() {
  return {
    version: LOCAL_AGENT_STATE_VERSION,
    savedAt: new Date().toISOString(),
    sessions: Array.from(localAgentState.sessions.values()),
    trustedFolders: Array.from(localAgentState.trustedFolders.values()),
    focusedSessionId: localAgentState.focusedSessionId,
  };
}

function hydrateLocalAgentState(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const sessionList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.sessions)
      ? payload.sessions
      : [];

  if (sessionList.length > 0) {
    localAgentState.sessions = new Map();
    for (const rawSession of sessionList) {
      if (!rawSession || typeof rawSession !== 'object') {
        continue;
      }
      const sessionId = normalizeLocalSessionId(
        rawSession.sessionId || rawSession.uuid || rawSession.conversationUuid
      );
      // Ensure .claude/projects dir exists for the asar's transcript recovery
      const claudeConfigDir = ensureAsarClaudeConfigDir(sessionId);

      const session = {
        ...rawSession,
        sessionId,
        uuid: sessionId,
        conversationUuid: (rawSession.conversationUuid && !rawSession.conversationUuid.startsWith('local_'))
          ? rawSession.conversationUuid
          : sessionId.replace(/^local_/, ''),
        ...(claudeConfigDir ? { claudeConfigDir } : {}),
      };
      localAgentState.sessions.set(sessionId, session);
    }
  }

  if (Array.isArray(payload.trustedFolders)) {
    localAgentState.trustedFolders = new Set(
      payload.trustedFolders.filter((folder) => typeof folder === 'string' && folder.length > 0)
    );
  }

  if (typeof payload.focusedSessionId === 'string') {
    localAgentState.focusedSessionId = normalizeLocalSessionId(payload.focusedSessionId);
  }

  return sessionList.length > 0 || Array.isArray(payload.trustedFolders);
}

function persistLocalAgentState(reason) {
  try {
    ensureDir(LOCAL_AGENT_STATE_DIR);
    const payload = serializeLocalAgentState();
    fs.writeFileSync(LOCAL_AGENT_STATE_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
    if (reason) {
      console.log(`${LOG_PREFIX} LocalAgent state saved (${reason})`);
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to save LocalAgent state:`, e.message);
  }
}

function scheduleLocalAgentStateSave(reason) {
  if (localAgentStateSaveTimer) {
    clearTimeout(localAgentStateSaveTimer);
  }
  localAgentStateSaveTimer = setTimeout(() => {
    localAgentStateSaveTimer = null;
    persistLocalAgentState(reason);
  }, 250);
}

function loadLocalAgentState() {
  if (localAgentStateLoaded) {
    return;
  }
  localAgentStateLoaded = true;

  const candidates = [LOCAL_AGENT_STATE_FILE, LEGACY_STATE_FILE, LEGACY_STATE_FILE_ALT];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const raw = fs.readFileSync(candidate, 'utf8');
      const payload = JSON.parse(raw);
      const hydrated = hydrateLocalAgentState(payload);
      console.log(`${LOG_PREFIX} Loaded LocalAgent state from ${candidate} (hydrated=${hydrated})`);
      if (candidate !== LOCAL_AGENT_STATE_FILE && hydrated) {
        persistLocalAgentState('migrate');
      }
      return;
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to load LocalAgent state from ${candidate}:`, e.message);
    }
  }
}

function emitLocalAgentEvent(payload) {
  console.log(`${LOG_PREFIX} EMIT event:`, JSON.stringify(payload).slice(0, 300));
  try {
    const uuids = new Set([...KNOWN_UUIDS, discoveredUUID].filter(Boolean));
    const namespaces = ['claude.web', 'claude.hybrid'];
    const channels = [];
    for (const uuid of uuids) {
      for (const ns of namespaces) {
        channels.push(`$eipc_message$_${uuid}_$_${ns}_$_LocalAgentModeSessions_$_onEvent`);
      }
    }
    const allContents = typeof webContents?.getAllWebContents === 'function'
      ? webContents.getAllWebContents()
      : [];
    for (const contents of allContents) {
      for (const channel of channels) {
        try {
          contents.send(channel, payload);
        } catch (e) {
          // Ignore per-webContents errors
        }
      }
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to emit LocalAgent event:`, e.message);
  }
}

function buildLocalAgentSession(info = {}) {
  const sessionId = normalizeLocalSessionId(info.sessionId);
  const cwd = typeof info.sharedCwdPath === 'string' && info.sharedCwdPath.length > 0
    ? path.isAbsolute(info.sharedCwdPath)
      ? info.sharedCwdPath
      : path.join(os.homedir(), info.sharedCwdPath)
    : process.cwd();
  const now = Date.now();

  return {
    sessionId,
    uuid: sessionId,
    conversationUuid: sessionId.replace(/^local_/, ''),
    cwd,
    originCwd: cwd,
    userSelectedFolders: Array.isArray(info.userSelectedFolders)
      ? info.userSelectedFolders
      : [],
    userSelectedProjectUuids: Array.isArray(info.userSelectedProjectUuids)
      ? info.userSelectedProjectUuids
      : [],
    isRunning: true,
    model: typeof info.model === 'string' ? info.model : undefined,
    title: typeof info.title === 'string' ? info.title : undefined,
    createdAt: now,
    lastActivityAt: now,
    isArchived: false,
    homePath: os.homedir(),
    folderExists: true,
    initialMessage: typeof info.message === 'string' ? info.message : undefined,
    transcript: [],
    name: typeof info.title === 'string' ? info.title : 'New Task',  // Add name field
    created_at: new Date(now).toISOString(),  // Add ISO timestamp
    updated_at: new Date(now).toISOString(),  // Add ISO timestamp
  };
}

function getLocalAgentSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return null;
  }
  const direct = localAgentState.sessions.get(sessionId);
  if (direct) {
    return direct;
  }
  const normalized = sessionId.startsWith('local_') ? sessionId : `local_${sessionId}`;
  return localAgentState.sessions.get(normalized) || null;
}

function updateLocalAgentSession(sessionId, updates) {
  const session = getLocalAgentSession(sessionId);
  if (!session || !updates || typeof updates !== 'object') {
    return session;
  }
  Object.assign(session, updates);
  session.lastActivityAt = Date.now();
  return session;
}

// ============================================================
// Handler implementations
// ============================================================

const handlers = {
  // AutoUpdater - called MANY times
  'AutoUpdater_$_updaterState_$store$_getState': {
    sync: false, // This appears to be async based on logs
    handler: async () => getUpdaterState(),
  },

  'AutoUpdater_$_updaterState_$store$_getStateSync': {
    sync: true,
    handler: () => syncOk(getUpdaterState()),
  },

  'AutoUpdater_$_restartToUpdate': {
    sync: false,
    handler: async () => false,
  },
  
  'AutoUpdater_$_updaterState_$store$_update': {
    sync: false,
    handler: async () => ({ success: true }),
  },
  
  // WindowControl
  'WindowControl_$_setThemeMode': {
    sync: false,
    handler: async (event, mode) => {
      console.log(`${LOG_PREFIX} setThemeMode:`, mode);
      return { success: true };
    },
  },
  

  'WindowControl_$_resize': {
    sync: false,
    handler: async (event, size) => {
      try {
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getFocusedWindow();
        if (win) {
          let width = null;
          let height = null;
          if (Array.isArray(size) && size.length >= 2) {
            width = Number(size[0]);
            height = Number(size[1]);
          } else if (size && typeof size === 'object') {
            width = Number(size.width ?? size.w);
            height = Number(size.height ?? size.h);
          }
          if (Number.isFinite(width) && Number.isFinite(height)) {
            win.setSize(Math.max(1, width), Math.max(1, height));
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} WindowControl.resize error:`, e.message);
      }
      return { success: true };
    },
  },

  'WindowControl_$_focus': {
    sync: false,
    handler: async () => {
      try {
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getFocusedWindow();
        if (win) {
          win.focus();
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} WindowControl.focus error:`, e.message);
      }
      return { success: true };
    },
  },

  // LocalPlugins
  'LocalPlugins_$_getPlugins': {
    sync: false,
    handler: async () => [],
  },
  
  // DesktopIntl - NOTE: getInitialLocale is SYNC!
  'DesktopIntl_$_getInitialLocale': {
    sync: true, // This is called with sendSync!
    handler: () => {
      const locale = process.env.LANG?.split('.')[0]?.replace('_', '-') || 'en-US';
      console.log(`${LOG_PREFIX} getInitialLocale (sync):`, locale);
      return syncOk({ messages: {}, locale });
    },
  },
  
  'DesktopIntl_$_requestLocaleChange': {
    sync: false,
    handler: async (event, locale) => {
      console.log(`${LOG_PREFIX} requestLocaleChange:`, locale);
      return { success: true };
    },
  },
  
  // Account
  'Account_$_setAccountDetails': {
    sync: false,
    handler: async (event, details) => {
      console.log(`${LOG_PREFIX} setAccountDetails`);
      return { success: true };
    },
  },
  
  // QuickEntry
  'QuickEntry_$_setRecentChats': {
    sync: false,
    handler: async (event, chats) => {
      console.log(`${LOG_PREFIX} setRecentChats, count:`, chats?.length || 0);
      return { success: true };
    },
  },
  
  // MCP Servers - simple channel name (no eipc prefix)
  'list-mcp-servers': {
    sync: false,
    simple: true, // Not namespaced
    handler: async () => {
      const configPath = path.join(APP_SUPPORT_ROOT, 'claude_desktop_config.json');
      
      try {
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          console.log(`${LOG_PREFIX} list-mcp-servers: found config`);
          return config.mcpServers || {};
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} Error reading MCP config:`, e.message);
      }
      return {};
    },
  },
  
  'connect-to-mcp-server': {
    sync: false,
    simple: true,
    handler: async (event, serverName) => {
      console.log(`${LOG_PREFIX} connect-to-mcp-server:`, serverName);
      return { connected: false, error: 'Not implemented in Linux stub' };
    },
  },
  
  'request-open-mcp-settings': {
    sync: false,
    simple: true,
    handler: async () => {
      console.log(`${LOG_PREFIX} request-open-mcp-settings`);
      // Could open the config file in an editor
      return { success: true };
    },
  },
  
  // Claude VM handlers
  'ClaudeVM_$_download': {
    sync: false,
    handler: async () => ({ success: true }),
  },
  
  'ClaudeVM_$_getDownloadStatus': {
    sync: false,
    handler: async () => CLAUDE_VM_DOWNLOAD_STATUS.ready,
  },
  
  'ClaudeVM_$_getRunningStatus': {
    sync: false,
    handler: async () => CLAUDE_VM_RUNNING_STATUS.ready,
  },
  
  'ClaudeVM_$_startVM': {
    sync: false,
    handler: async () => ({ success: true }),
  },

  'ClaudeVM_$_setYukonSilverConfig': {
    sync: false,
    handler: async (event, config) => {
      console.log(`${LOG_PREFIX} setYukonSilverConfig:`, config);
    },
  },

  'ClaudeVM_$_deleteAndReinstall': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} deleteAndReinstall (noop)`);
    },
  },
  
  // Claude Code
  'ClaudeCode_$_prepare': {
    sync: false,
    handler: async () => ({ ready: true }),
  },

  'ClaudeCode_$_getStatus': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} ClaudeCode.getStatus called`);
      return { ready: true, running: true, connected: true };
    },
  },

  // CustomPlugins: stub to prevent "Unexpected command: claude" VM spawn errors on Linux
  'CustomPlugins_$_listMarketplaces': {
    sync: false,
    handler: async () => [],
  },

  'CustomPlugins_$_listAvailablePlugins': {
    sync: false,
    handler: async () => {
      const { execFile } = require('child_process');
      const claudeBin = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude');
      return new Promise((resolve) => {
        execFile(claudeBin, ['plugin', 'list', '--available', '--json'], { timeout: 30000 }, (err, stdout) => {
          if (err || !stdout) {
            console.log(`${LOG_PREFIX} CustomPlugins listAvailablePlugins: CLI error, returning empty list`);
            return resolve([]);
          }
          try {
            const { available = [], installed = [] } = JSON.parse(stdout);
            const installedIds = new Set(installed.map(p => p.id));
            resolve(available.map(p => ({
              id: p.pluginId,
              name: p.name,
              description: p.description,
              marketplaceName: p.marketplaceName,
              isInstalled: installedIds.has(p.pluginId),
            })));
          } catch (e) {
            console.log(`${LOG_PREFIX} CustomPlugins listAvailablePlugins: parse error:`, e.message);
            resolve([]);
          }
        });
      });
    },
  },

  // Window State
  'WindowState_$_getFullscreen': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} WindowState.getFullscreen called`);
      return false;
    },
  },

  // Local Sessions (different from LocalAgentModeSessions!)
  'LocalSessions_$_getAll': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} LocalSessions.getAll called`);
      return [];
    },
  },

  'LocalSessions_$_getGitInfo': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} LocalSessions.getGitInfo called`);
      return { branches: [], currentBranch: null, remotes: [] };
    },
  },

  // Local Knowledge Bases
  'LocalKBs_$_list': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} LocalKBs.list called`);
      return [];
    },
  },

  // FileSystem handlers (needed for Cowork folder selection)
  'FileSystem_$_browseFolder': {
    sync: false,
    handler: async (event) => {
      console.log(`${LOG_PREFIX} FileSystem.browseFolder called`);
      try {
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getFocusedWindow();
        const result = await dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Select Folder',
        });
        if (result.canceled || !result.filePaths.length) {
          return null;
        }
        return result.filePaths[0];
      } catch (e) {
        console.error(`${LOG_PREFIX} browseFolder error:`, e.message);
        return null;
      }
    },
  },


  'FileSystem_$_getSystemPath': {
    sync: false,
    handler: async (event, key) => {
      try {
        const { app } = require('electron');
        if (!key) {
          return app.getPath('home');
        }
        const normalized = String(key);
        const normalizedLower = normalized.toLowerCase();
        const lookup = {
          home: 'home',
          appdata: 'appData',
          userdata: 'userData',
          temp: 'temp',
          desktop: 'desktop',
          documents: 'documents',
          downloads: 'downloads',
          music: 'music',
          pictures: 'pictures',
          videos: 'videos',
          logs: 'logs',
          cache: 'cache',
        }[normalizedLower];
        if (lookup) {
          return app.getPath(lookup);
        }
        return app.getPath(normalized);
      } catch (e) {
        console.error(`${LOG_PREFIX} FileSystem.getSystemPath error:`, e.message);
        return os.homedir();
      }
    },
  },

  'FileSystem_$_whichApplication': {
    sync: false,
    handler: async (event, appName) => {
      console.log(`${LOG_PREFIX} FileSystem.whichApplication called:`, appName);
      return null;
    },
  },

  'FileSystem_$_readFile': {
    sync: false,
    handler: async (event, filePath) => {
      const fs = require('fs');
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        console.error(`${LOG_PREFIX} readFile error:`, e.message);
        return null;
      }
    },
  },

  'FileSystem_$_writeFile': {
    sync: false,
    handler: async (event, filePath, content) => {
      const fs = require('fs');
      try {
        fs.writeFileSync(filePath, content, 'utf8');
        return { success: true };
      } catch (e) {
        console.error(`${LOG_PREFIX} writeFile error:`, e.message);
        return { success: false, error: e.message };
      }
    },
  },

  'FileSystem_$_exists': {
    sync: false,
    handler: async (event, filePath) => {
      const fs = require('fs');
      return fs.existsSync(filePath);
    },
  },

  /**
   * Read local file for Cowork sessions.
   * Called by webapp to load files from session mount points for preview.
   * Returns: { content: string, mimeType?: string, encoding?: 'base64'|'utf8' }
   */
  'FileSystem_$_readLocalFile': {
    sync: false,
    handler: async (event, filePath) => {
      const fs = require('fs');
      const path = require('path');
      console.log(`${LOG_PREFIX} FileSystem_$_readLocalFile:`, filePath);
      try {
        // Resolve symlinks to get the real path
        let resolvedPath = filePath;
        try {
          resolvedPath = fs.realpathSync(filePath);
        } catch (_) {
          // If realpath fails, try the original path
        }

        // Check if file exists
        if (!fs.existsSync(resolvedPath)) {
          console.error(`${LOG_PREFIX} FileSystem_$_readLocalFile: file not found:`, resolvedPath);
          throw new Error(`File not found: ${filePath}`);
        }

        const stats = fs.statSync(resolvedPath);

        // Check if it's a directory
        if (stats.isDirectory()) {
          console.log(`${LOG_PREFIX} FileSystem_$_readLocalFile: path is a directory`);
          // For directories, return a listing
          const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
          const listing = entries.map(e => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
          }));
          return {
            content: JSON.stringify(listing, null, 2),
            mimeType: 'application/json',
            encoding: 'utf8',
            isDirectory: true,
          };
        }

        // Determine if file is likely binary
        const ext = path.extname(resolvedPath).toLowerCase();
        const textExtensions = [
          '.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.html', '.css',
          '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
          '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.sh', '.bash',
          '.zsh', '.fish', '.sql', '.graphql', '.env', '.gitignore', '.dockerfile',
          '.makefile', '.cmake', '.gradle', '.properties', '.log', '.csv',
        ];
        const isTextFile = textExtensions.includes(ext) || stats.size < 1024 * 100;

        // Read file content
        const content = fs.readFileSync(resolvedPath);

        // Check if content appears to be binary
        const isBinary = !isTextFile || content.includes(0);

        // Determine MIME type
        const mimeTypes = {
          '.txt': 'text/plain',
          '.md': 'text/markdown',
          '.json': 'application/json',
          '.js': 'text/javascript',
          '.ts': 'text/typescript',
          '.html': 'text/html',
          '.css': 'text/css',
          '.py': 'text/x-python',
          '.go': 'text/x-go',
          '.rs': 'text/x-rust',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.pdf': 'application/pdf',
        };
        const mimeType = mimeTypes[ext] || (isBinary ? 'application/octet-stream' : 'text/plain');

        if (isBinary) {
          return {
            content: content.toString('base64'),
            mimeType,
            encoding: 'base64',
            size: stats.size,
          };
        } else {
          return {
            content: content.toString('utf8'),
            mimeType,
            encoding: 'utf8',
            size: stats.size,
          };
        }
      } catch (e) {
        console.error(`${LOG_PREFIX} FileSystem_$_readLocalFile error:`, e.message);
        throw e;
      }
    },
  },

  // Local Agent Mode
  'LocalAgentModeSessions_$_start': {
    sync: false,
    handler: async (event, info) => {
      const session = buildLocalAgentSession(info);
      localAgentState.sessions.set(session.sessionId, session);
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.start:`, session.sessionId);

      // Ensure .claude/projects dir exists for asar's transcript recovery
      const claudeConfigDir = ensureAsarClaudeConfigDir(session.sessionId);
      if (claudeConfigDir) session.claudeConfigDir = claudeConfigDir;

      // Launch Claude Code subprocess via SDK bridge
      if (sdkBridge) {
        await sdkBridge.startSession(session.sessionId, session, emitLocalAgentEvent, {
          onConversationId: (sid, ccId) => {
            const s = getLocalAgentSession(sid);
            if (s) { s.ccConversationId = ccId; scheduleLocalAgentStateSave('ccConversationId'); }
          },
        });
      }

      scheduleLocalAgentStateSave('start');
      emitLocalAgentEvent({ type: 'sessionsUpdated', sessionId: session.sessionId });
      return { sessionId: session.sessionId, conversationUuid: session.conversationUuid };
    },
  },

  'LocalAgentModeSessions_$_sendMessage': {
    sync: false,
    handler: async (event, sessionId, message, images, files) => {
      const session = getLocalAgentSession(sessionId);
      if (session) {
        // Re-init bridge for sessions loaded from disk (no live bridge state)
        if (sdkBridge && !sdkBridge.hasSession(session.sessionId)) {
          console.log(`${LOG_PREFIX} Re-initializing bridge for rehydrated session:`, session.sessionId);
          // Ensure .claude/projects dir exists and set config dir for the bridge
          if (!session.claudeConfigDir) {
            const claudeConfigDir = ensureAsarClaudeConfigDir(session.sessionId);
            if (claudeConfigDir) session.claudeConfigDir = claudeConfigDir;
          }
          await sdkBridge.startSession(session.sessionId, session, emitLocalAgentEvent, {
            onConversationId: (sid, ccId) => {
              const s = getLocalAgentSession(sid);
              if (s) { s.ccConversationId = ccId; scheduleLocalAgentStateSave('ccConversationId'); }
            },
          });
          session.isRunning = true;
        }

        const entry = {
          type: 'user',
          message,
          images: images || [],
          files: files || [],
          timestamp: Date.now(),
        };
        session.transcript.push(entry);
        session.lastActivityAt = Date.now();
        scheduleLocalAgentStateSave('sendMessage');
        emitLocalAgentEvent({ type: 'data', sessionId, data: JSON.stringify(entry) });

        // Forward message to Claude Code subprocess
        try {
          if (sdkBridge) await sdkBridge.sendMessage(session.sessionId, message);
        } catch (e) {
          console.error(`${LOG_PREFIX} sendMessage bridge error:`, e.message);
        }
      }
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.sendMessage:`, sessionId);
    },
  },

  'LocalAgentModeSessions_$_stop': {
    sync: false,
    handler: async (event, sessionId) => {
      const session = updateLocalAgentSession(sessionId, { isRunning: false });
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.stop:`, sessionId);

      // Stop the Claude Code subprocess
      if (sdkBridge) await sdkBridge.stopSession(sessionId);

      scheduleLocalAgentStateSave('stop');
      emitLocalAgentEvent({ type: 'sessionsUpdated', sessionId });
      return session ? { success: true } : { success: false };
    },
  },

  'LocalAgentModeSessions_$_archive': {
    sync: false,
    handler: async (event, sessionId) => {
      updateLocalAgentSession(sessionId, { isArchived: true, isRunning: false });
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.archive:`, sessionId);
      if (sdkBridge) await sdkBridge.stopSession(sessionId);
      scheduleLocalAgentStateSave('archive');
      emitLocalAgentEvent({ type: 'sessionsUpdated', sessionId });
    },
  },

  'LocalAgentModeSessions_$_updateSession': {
    sync: false,
    handler: async (event, sessionId, updates) => {
      updateLocalAgentSession(sessionId, updates);
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.updateSession:`, sessionId);
      scheduleLocalAgentStateSave('updateSession');
      emitLocalAgentEvent({ type: 'sessionsUpdated', sessionId });
    },
  },

  'LocalAgentModeSessions_$_getSession': {
    sync: false,
    handler: async (event, sessionId) => {
      return getLocalAgentSession(sessionId);
    },
  },

  'LocalAgentModeSessions_$_getAll': {
    sync: false,
    handler: async () => {
      const sessions = Array.from(localAgentState.sessions.values());
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.getAll called, returning ${sessions.length} sessions`);
      return sessions;
    },
  },

  'LocalAgentModeSessions_$_getTranscript': {
    sync: false,
    handler: async (event, sessionId) => {
      // Prefer SDK transcript (has full message history from Claude Code)
      if (sdkBridge) {
        const sdkTranscript = sdkBridge.getTranscript(sessionId);
        if (sdkTranscript.length > 0) return sdkTranscript;
      }
      const session = getLocalAgentSession(sessionId);
      return session?.transcript ?? [];
    },
  },

  'LocalAgentModeSessions_$_respondToToolPermission': {
    sync: false,
    handler: async (event, requestId, decision, updatedInput) => {
      console.log(
        `${LOG_PREFIX} LocalAgentModeSessions.respondToToolPermission:`,
        requestId,
        decision,
        Boolean(updatedInput)
      );
    },
  },

  'LocalAgentModeSessions_$_openOutputsDir': {
    sync: false,
    handler: async (event, sessionId) => {
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.openOutputsDir:`, sessionId);
    },
  },

  'LocalAgentModeSessions_$_shareSession': {
    sync: false,
    handler: async (event, sessionId) => {
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.shareSession:`, sessionId);
      return { success: false, error: 'Not implemented in Linux stub' };
    },
  },

  'LocalAgentModeSessions_$_setDraftSessionFolders': {
    sync: false,
    handler: async (event, folders) => {
      console.log(
        `${LOG_PREFIX} LocalAgentModeSessions.setDraftSessionFolders:`,
        folders?.length ?? 0
      );
    },
  },

  'LocalAgentModeSessions_$_getSupportedCommands': {
    sync: false,
    handler: async () => [],
  },

  'LocalAgentModeSessions_$_getTrustedFolders': {
    sync: false,
    handler: async () => Array.from(localAgentState.trustedFolders.values()),
  },

  'LocalAgentModeSessions_$_addTrustedFolder': {
    sync: false,
    handler: async (event, folder) => {
      if (typeof folder === 'string' && folder.length > 0) {
        localAgentState.trustedFolders.add(folder);
      }
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.addTrustedFolder:`, folder);
      scheduleLocalAgentStateSave('addTrustedFolder');
    },
  },

  'LocalAgentModeSessions_$_removeTrustedFolder': {
    sync: false,
    handler: async (event, folder) => {
      localAgentState.trustedFolders.delete(folder);
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.removeTrustedFolder:`, folder);
      scheduleLocalAgentStateSave('removeTrustedFolder');
    },
  },

  'LocalAgentModeSessions_$_isFolderTrusted': {
    sync: false,
    handler: async (event, folder) => localAgentState.trustedFolders.has(folder),
  },

  'LocalAgentModeSessions_$_setMcpServers': {
    sync: false,
    handler: async () => ({ added: [], removed: [] }),
  },

  'LocalAgentModeSessions_$_setFirstPartyConnectors': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.setFirstPartyConnectors`);
    },
  },

  'LocalAgentModeSessions_$_setFocusedSession': {
    sync: false,
    handler: async (event, sessionId) => {
      localAgentState.focusedSessionId = sessionId ?? null;
      scheduleLocalAgentStateSave('setFocusedSession');
    },
  },

  'LocalAgentModeSessions_$_respondDirectoryServers': {
    sync: false,
    handler: async (event, requestId) => {
      console.log(`${LOG_PREFIX} LocalAgentModeSessions.respondDirectoryServers:`, requestId);
    },
  },

  'LocalAgentModeSessions_$_mcpCallTool': {
    sync: false,
    handler: async () => ({
      content: [{ type: 'text', text: 'MCP tool calls not supported in Linux stub' }],
      isError: true,
    }),
  },

  'LocalAgentModeSessions_$_mcpReadResource': {
    sync: false,
    handler: async () => ({ contents: [] }),
  },

  'LocalAgentModeSessions_$_mcpListResources': {
    sync: false,
    handler: async () => [],
  },

  // Local Session Environment
  'LocalSessionEnvironment_$_get': {
    sync: false,
    handler: async () => ({ ...localAgentState.envVars }),
  },

  'LocalSessionEnvironment_$_save': {
    sync: false,
    handler: async (event, envVars) => {
      if (envVars && typeof envVars === 'object') {
        localAgentState.envVars = { ...envVars };
      }
      return { success: true };
    },
  },

  // BrowserNavigation
  'BrowserNavigation_$_navigationState_$store$_getState': {
    sync: false,
    handler: async () => getNavigationState(),
  },

  'BrowserNavigation_$_navigationState_$store$_getStateSync': {
    sync: true,
    handler: () => syncOk(getNavigationState()),
  },

  'BrowserNavigation_$_reportNavigationState': {
    sync: false,
    handler: async (event, state) => {
      console.log(`${LOG_PREFIX} reportNavigationState:`, state);
    },
  },

  'BrowserNavigation_$_goBack': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} goBack (noop)`);
    },
  },

  'BrowserNavigation_$_goForward': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} goForward (noop)`);
    },
  },

  'BrowserNavigation_$_requestMainMenuPopup': {
    sync: false,
    handler: async () => {
      console.log(`${LOG_PREFIX} requestMainMenuPopup (noop)`);
    },
  },

  // AppConfig (claude.settings)
  'AppConfig_$_getAppConfig': {
    sync: false,
    handler: async () => ({
      claudeAiUrl: 'https://claude.ai',
      globalShortcut: 'off',
      mcpServers: {},
      features: {
        isSwiftEnabled: true,    // Enable Swift for Cowork
        isStudioEnabled: false,
        isDxtEnabled: false,
        isDxtDirectoryEnabled: false,
        isLocalDevMcpEnabled: false,
      },
      isHardwareAccelerationDisabled: false,
      isUsingBuiltInNodeForMcp: false,
      isDxtAutoUpdatesEnabled: false,
      secureVmFeaturesEnabled: true,  // Enable Cowork/Yukon Silver
    }),
  },

  'AppConfig_$_setAppFeature': {
    sync: false,
    handler: async (event, feature, enabled) => {
      console.log(`${LOG_PREFIX} setAppFeature:`, feature, enabled);
    },
  },

  'AppConfig_$_setIsUsingBuiltInNodeForMcp': {
    sync: false,
    handler: async (event, enabled) => {
      console.log(`${LOG_PREFIX} setIsUsingBuiltInNodeForMcp:`, enabled);
    },
  },

  'AppConfig_$_setIsDxtAutoUpdatesEnabled': {
    sync: false,
    handler: async (event, enabled) => {
      console.log(`${LOG_PREFIX} setIsDxtAutoUpdatesEnabled:`, enabled);
    },
  },

  // AppFeatures (claude.settings)
  'AppFeatures_$_getSupportedFeatures': {
    sync: false,
    handler: async () => {
      const features = {
        nativeQuickEntry: { status: 'supported' },
        quickEntryDictation: { status: 'supported' },
        customQuickEntryDictationShortcut: { status: 'supported' },
        plushRaccoon: { status: 'supported' },
        quietPenguin: { status: 'supported' },
        louderPenguin: { status: 'supported' },
        chillingSlothEnterprise: { status: 'supported' },
        chillingSlothFeat: { status: 'supported' },
        chillingSlothLocal: { status: 'supported' },
        yukonSilver: { status: 'supported' },
        yukonSilverGems: { status: 'supported' },
        secureVmFeatures: { status: 'supported' },
        cowork: { status: 'supported' },
        localAgentMode: { status: 'supported' },
        desktopTopBar: { status: 'supported' },
      };
      console.log('[ipc-setup] getSupportedFeatures CALLED - returning:', JSON.stringify(features));
      return features;
    },
  },

  // DesktopInfo (claude.settings)
  'DesktopInfo_$_getSystemInfo': {
    sync: false,
    handler: async () => ({
      app_version: app?.getVersion ? app.getVersion() : '0.0.0',
      os_version: '14.0.0', // Spoof macOS version
      cpu_model: os.cpus()?.[0]?.model || null,
      platform: 'darwin', // Spoof as macOS
      arch: 'arm64', // Spoof as Apple Silicon
    }),
  },

  // AppPreferences (claude.settings)
  'AppPreferences_$_getPreferences': {
    sync: false,
    handler: async () => {
      const prefs = getDefaultPreferences();
      console.log('[ipc-setup] getPreferences returning secureVmFeaturesEnabled:', prefs.secureVmFeaturesEnabled);
      return prefs;
    },
  },

  'AppPreferences_$_setPreference': {
    sync: false,
    handler: async (event, key, value) => {
      console.log(`${LOG_PREFIX} setPreference:`, key, value);
    },
  },

  // Startup (claude.settings)
  'Startup_$_isStartupOnLoginEnabled': {
    sync: false,
    handler: async () => false,
  },

  'Startup_$_setStartupOnLoginEnabled': {
    sync: false,
    handler: async (event, enabled) => {
      console.log(`${LOG_PREFIX} setStartupOnLoginEnabled:`, enabled);
    },
  },

  'Startup_$_isMenuBarEnabled': {
    sync: false,
    handler: async () => false,
  },

  'Startup_$_setMenuBarEnabled': {
    sync: false,
    handler: async (event, enabled) => {
      console.log(`${LOG_PREFIX} setMenuBarEnabled:`, enabled);
    },
  },
};

// ============================================================
// Registration functions
// ============================================================

/**
 * Register a handler for a specific channel
 */
function registerChannel(channel, config) {
  if (registeredChannels.has(channel)) {
    return; // Already registered
  }
  
  try {
    // For critical handlers, REMOVE existing handler first to override bundled code
    const criticalHandlers = ['AppFeatures_$_getSupportedFeatures', 'DesktopInfo_$_getSystemInfo', 'list-mcp-servers'];
    const isCritical = criticalHandlers.some(h => channel.includes(h));

    const hasInvokeHandler = ipcMain?._invokeHandlers?.has?.(channel);
    if (hasInvokeHandler && !config.sync && !isCritical) {
      console.log(`${LOG_PREFIX} Handler already exists for ${channel}, skipping`);
      registeredChannels.add(channel);
      return;
    }
    if (config.sync && ipcMain.listenerCount(channel) > 0 && !isCritical) {
      console.log(`${LOG_PREFIX} Sync handler already exists for ${channel}, skipping`);
      registeredChannels.add(channel);
      return;
    }


    if (config.sync) {
      // Sync handler - use ipcMain.on with event.returnValue
      ipcMain.on(channel, (event, ...args) => {
        try {
          event.returnValue = config.handler(event, ...args);
        } catch (e) {
          console.error(`${LOG_PREFIX} Sync handler error for ${channel}:`, e.message);
          event.returnValue = null;
        }
      });
      console.log(`${LOG_PREFIX} Registered SYNC: ${channel}`);
    } else {
      // Async handler - for critical handlers, remove existing first
      if (isCritical) {
        try {
          ipcMain.removeHandler(channel);
          console.log(`${LOG_PREFIX} Removed existing handler: ${channel}`);
        } catch (e) {
          // Handler didn't exist, that's OK
        }
      }
      ipcMain.handle(channel, config.handler);
      console.log(`${LOG_PREFIX} Registered ASYNC: ${channel}`);
    }
    registeredChannels.add(channel);
  } catch (e) {
    if (!e.message.includes('second handler') && !e.message.includes('already registered')) {
      console.error(`${LOG_PREFIX} Error registering ${channel}:`, e.message);
    }
  }
}

/**
 * Register all handlers with a specific UUID
 */
function registerAllWithUUID(uuid) {
  console.log(`${LOG_PREFIX} Registering all handlers with UUID: ${uuid}`);
  discoveredUUID = uuid;
  
  const namespaces = ['claude.web', 'claude.hybrid', 'claude.settings'];
  
  for (const [handlerName, config] of Object.entries(handlers)) {
    if (config.simple) {
      // Simple channel - no namespace prefix
      registerChannel(handlerName, config);
    } else {
      // Namespaced channel - register for each namespace
      for (const ns of namespaces) {
        const fullChannel = `$eipc_message$_${uuid}_$_${ns}_$_${handlerName}`;
        registerChannel(fullChannel, config);
      }
      
      // Also register the simple name as fallback
      registerChannel(handlerName, config);
    }
  }
}

/**
 * Extract UUID from a channel name
 */
function extractUUID(channel) {
  const match = channel.match(/\$eipc_message\$_([a-f0-9-]+)_\$/);
  return match ? match[1] : null;
}

/**
 * Parse an eipc channel into parts
 */
function parseEipcChannel(channel) {
  if (typeof channel !== 'string') {
    return null;
  }
  const match = channel.match(
    /^\$eipc_message\$_([a-f0-9-]+)_\$_(claude\.(?:web|hybrid|settings))_\$_(.+)$/
  );
  if (!match) {
    return null;
  }
  return {
    uuid: match[1],
    namespace: match[2],
    handlerName: match[3],
  };
}

/**
 * Set up monitoring to discover UUID from first IPC call
 */
// Critical handlers that we MUST intercept - these control feature availability
// ClaudeCode handlers are critical because the bundled code's getHostPlatform()
// rejects linux-x64; our handlers bypass platform checks entirely
const CRITICAL_HANDLERS = [
  'AppFeatures_$_getSupportedFeatures',
  'DesktopInfo_$_getSystemInfo',
  'AppFeatures_$_checkFeatureSupport',
  'ClaudeCode_$_prepare',
  'ClaudeCode_$_getStatus',
];

function setupUUIDDiscovery() {
  // Patch ipcMain to watch for the first eipc channel
  const originalOn = ipcMain.on.bind(ipcMain);
  const originalHandle = ipcMain.handle.bind(ipcMain);

  // CRITICAL: Patch ipcMain.handle to intercept when bundled app registers critical handlers
  ipcMain.handle = (channel, handler) => {
    // Log ALL handle registrations that involve features
    if (typeof channel === 'string' && (channel.includes('Features') || channel.includes('SystemInfo') || channel.includes('ClaudeCode'))) {
      console.log(`${LOG_PREFIX} ipcMain.handle called with channel: ${channel}`);
    }

    const parsed = parseEipcChannel(channel);

    if (parsed) {
      // Register all our handlers for newly seen UUIDs before the asar can register its own
      if (!discoveredUUID || discoveredUUID !== parsed.uuid) {
        const isNewUUID = parsed.uuid !== MAIN_PROCESS_UUID && parsed.uuid !== MAIN_VIEW_UUID && parsed.uuid !== discoveredUUID;
        if (isNewUUID) {
          console.log(`${LOG_PREFIX} Discovered new eipc UUID: ${parsed.uuid} — pre-registering all handlers`);
          registerAllWithUUID(parsed.uuid);
        }
      }

      // Check if this is a critical handler we want to override
      const isCritical = CRITICAL_HANDLERS.some(c => parsed.handlerName.includes(c.split('_$_').pop()));

      if (channel.includes('Features')) {
        console.log(`${LOG_PREFIX}   parsed.handlerName=${parsed.handlerName}, isCritical=${isCritical}`);
      }

      if (isCritical) {
        console.log(`${LOG_PREFIX} INTERCEPTING ipcMain.handle for critical channel: ${channel}`);
        console.log(`${LOG_PREFIX}   -> Using OUR handler instead of bundled app's handler`);

        // Get our handler for this channel
        const config = handlers[parsed.handlerName];
        if (config) {
          // Register OUR handler, not the bundled app's
          return originalHandle(channel, async (event, ...args) => {
            console.log(`${LOG_PREFIX} EXECUTING INTERCEPTED: ${parsed.handlerName}`);
            try {
              return await config.handler(event, ...args);
            } catch (e) {
              console.error(`${LOG_PREFIX} Intercepted handler error:`, e.message);
              throw e;
            }
          });
        }
      }

      // Discover UUID from the channel
      if (!discoveredUUID) {
        discoveredUUID = parsed.uuid;
        console.log(`${LOG_PREFIX} Discovered UUID from handle: ${parsed.uuid}`);
      }
    }

    // For simple (non-eipc) channels we already registered, skip re-registration
    // This prevents "Attempted to register a second handler" errors when the
    // bundled app tries to register handlers we already own (e.g. list-mcp-servers)
    if (registeredChannels.has(channel)) {
      console.log(`${LOG_PREFIX} Channel already registered by us: ${channel}, skipping bundled handler`);
      return;
    }

    // For non-critical handlers, use original behavior
    return originalHandle(channel, handler);
  };

  console.log(`${LOG_PREFIX} Patched ipcMain.handle for critical handler interception`);

  // Also need to catch when the app tries to call a handler that doesn't exist
  // This happens through Session's invoke-handler event

  // Watch for errors about missing handlers to discover the UUID
  process.on('uncaughtException', (err) => {
    if (err.message.includes('No handler registered for')) {
      const match = err.message.match(/\$eipc_message\$_([a-f0-9-]+)_\$/);
      if (match && !discoveredUUID) {
        console.log(`${LOG_PREFIX} Discovered UUID from error: ${match[1]}`);
        registerAllWithUUID(match[1]);
      }
    }
    // Don't re-throw - let the app continue
  });
}

/**
 * Patch ipcMain invoke handling to dynamically serve eipc channels
 */
function patchInvokeHandlersFallback() {
  const invokeMap = ipcMain._invokeHandlers;
  if (!invokeMap || typeof invokeMap.has !== 'function' || typeof invokeMap.get !== 'function') {
    console.warn(`${LOG_PREFIX} ipcMain._invokeHandlers not available for patching`);
    return;
  }

  if (invokeMap.__claudeCoworkPatched) {
    return;
  }

  const originalHas = invokeMap.has.bind(invokeMap);
  const originalGet = invokeMap.get.bind(invokeMap);

  invokeMap.has = (channel) => {
    if (originalHas(channel)) {
      return true;
    }
    const parsed = parseEipcChannel(channel);
    if (!parsed) {
      return false;
    }
    const hasHandler = Boolean(handlers[parsed.handlerName]);
    if (parsed.handlerName.includes('SupportedFeatures') || parsed.handlerName.includes('Preferences')) {
      console.log(`${LOG_PREFIX} invokeMap.has check: ${channel} -> handler=${parsed.handlerName} found=${hasHandler}`);
    }
    return hasHandler;
  };

  // Critical handlers that we MUST override - these control feature availability
  const criticalOverrides = [
    'AppFeatures_$_getSupportedFeatures',
    'DesktopInfo_$_getSystemInfo',
    'AppFeatures_$_checkFeatureSupport',
  ];

  invokeMap.get = (channel) => {
    // Debug: Log ALL get calls for interesting channels
    if (typeof channel === 'string' && (channel.includes('SupportedFeatures') || channel.includes('getSystemInfo'))) {
      console.log(`${LOG_PREFIX} invokeMap.get CALLED: ${channel}`);
    }

    const parsed = parseEipcChannel(channel);

    // For critical handlers, ALWAYS return our handler regardless of original
    if (parsed) {
      const fullHandlerName = `${parsed.namespace}_$_${parsed.handlerName}`;
      const isCritical = criticalOverrides.some(c => fullHandlerName.includes(c) || channel.includes(c.split('_$_')[1]));
      const hasOurHandler = Boolean(handlers[parsed.handlerName]);

      if (channel.includes('SupportedFeatures')) {
        console.log(`${LOG_PREFIX} invokeMap.get: fullHandlerName=${fullHandlerName}, isCritical=${isCritical}, hasOurHandler=${hasOurHandler}`);
      }

      if (isCritical && hasOurHandler) {
        console.log(`${LOG_PREFIX} invokeMap.get: ${channel} - CRITICAL OVERRIDE (returning OUR handler)`);

        if (!discoveredUUID) {
          discoveredUUID = parsed.uuid;
          console.log(`${LOG_PREFIX} Discovered UUID from critical override: ${parsed.uuid}`);
        }

        const config = handlers[parsed.handlerName];
        return async (event, ...args) => {
          try {
            console.log(`${LOG_PREFIX} EXECUTING CRITICAL: ${parsed.handlerName}`);
            return await config.handler(event, ...args);
          } catch (e) {
            console.error(`${LOG_PREFIX} Critical handler error for ${channel}:`, e.message);
            throw e;
          }
        };
      }
    }

    // Check if original app already registered this handler (non-critical)
    if (originalHas(channel)) {
      if (channel.includes('SupportedFeatures') || channel.includes('Preferences')) {
        console.log(`${LOG_PREFIX} invokeMap.get: ${channel} - using ORIGINAL handler`);
      }
      return originalGet(channel);
    }

    if (!parsed) {
      return undefined;
    }

    const config = handlers[parsed.handlerName];
    if (!config) {
      return undefined;
    }

    if (!discoveredUUID) {
      discoveredUUID = parsed.uuid;
      console.log(`${LOG_PREFIX} Discovered UUID from invoke map: ${parsed.uuid}`);
    }

    if (parsed.handlerName.includes('SupportedFeatures') || parsed.handlerName.includes('Preferences')) {
      console.log(`${LOG_PREFIX} invokeMap.get: ${channel} - using OUR handler`);
    }

    return async (event, ...args) => {
      try {
        console.log(`${LOG_PREFIX} EXECUTING: ${parsed.handlerName}`);
        return await config.handler(event, ...args);
      } catch (e) {
        console.error(`${LOG_PREFIX} Invoke handler error for ${channel}:`, e.message);
        throw e;
      }
    };
  };

  Object.defineProperty(invokeMap, '__claudeCoworkPatched', { value: true });
  console.log(`${LOG_PREFIX} Patched ipcMain._invokeHandlers for dynamic eipc`);
}

/**
 * Patch ipcMain emit to handle sync eipc channels without a registered listener
 */
function patchEmitFallback() {
  if (ipcMain.__claudeCoworkEmitPatched) {
    return;
  }

  const originalEmit = ipcMain.emit.bind(ipcMain);

  ipcMain.emit = function (eventName, ...args) {
    try {
      if (typeof eventName === 'string' && ipcMain.listenerCount(eventName) === 0) {
        const parsed = parseEipcChannel(eventName);
        if (parsed) {
          const config = handlers[parsed.handlerName];
          if (config && config.sync) {
            if (!discoveredUUID) {
              discoveredUUID = parsed.uuid;
              console.log(`${LOG_PREFIX} Discovered UUID from emit: ${parsed.uuid}`);
            }
            const event = args[0];
            try {
              event.returnValue = config.handler(event, ...args.slice(1));
            } catch (e) {
              console.error(`${LOG_PREFIX} Sync handler error for ${eventName}:`, e.message);
              event.returnValue = null;
            }
            return true;
          }
        }
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} Emit fallback error:`, e.message);
    }
    return originalEmit(eventName, ...args);
  };

  Object.defineProperty(ipcMain, '__claudeCoworkEmitPatched', { value: true });
  console.log(`${LOG_PREFIX} Patched ipcMain.emit for dynamic eipc`);
}

/**
 * Main setup function - call this from your loader
 */
function setup() {
  console.log(`${LOG_PREFIX} Setting up IPC handlers...`);

  // Increase listener limit — handlers register across multiple namespaces/UUIDs
  ipcMain.setMaxListeners(50);

  loadLocalAgentState();

  // Flush corrected UUIDs back to disk immediately so any other code that
  // reads sessions.json independently gets clean conversationUuid values.
  if (localAgentState.sessions.size > 0) {
    let needsSave = false;
    for (const session of localAgentState.sessions.values()) {
      if (session.conversationUuid && session.conversationUuid.startsWith('local_')) {
        session.conversationUuid = session.sessionId.replace(/^local_/, '');
        needsSave = true;
      }
    }
    if (needsSave) {
      persistLocalAgentState('startup-uuid-fixup');
    }
  }

  patchInvokeHandlersFallback();
  patchEmitFallback();

  // Register simple handlers immediately
  for (const [handlerName, config] of Object.entries(handlers)) {
    if (config.simple) {
      registerChannel(handlerName, config);
    } else {
      // Also register without prefix as fallback (for non-simple handlers only)
      registerChannel(handlerName, config);
    }
  }

  // Known UUIDs from different preload scripts
  // - Main process preloads use one UUID
  // - mainView.js (webview/claude.ai preload) uses a different UUID
  // Pre-register with both known UUIDs
  console.log(`${LOG_PREFIX} Registering handlers with main process UUID: ${MAIN_PROCESS_UUID}`);
  registerAllWithUUID(MAIN_PROCESS_UUID);

  console.log(`${LOG_PREFIX} Registering handlers with mainView UUID: ${MAIN_VIEW_UUID}`);
  registerAllWithUUID(MAIN_VIEW_UUID);

  // Also set up discovery in case UUID changes
  setupUUIDDiscovery();

  console.log(`${LOG_PREFIX} IPC handler setup complete`);

  // CRITICAL: Override bundled handlers by directly manipulating _invokeHandlers map
  // The bundled code registers handlers during app initialization. removeHandler doesn't
  // work reliably, so we directly replace the handler function in the internal map.
  const criticalHandlers = [
    'AppFeatures_$_getSupportedFeatures',
    'DesktopInfo_$_getSystemInfo',
    'ClaudeCode_$_prepare',
    'ClaudeCode_$_getStatus',
  ];
  const knownUUIDs = [MAIN_PROCESS_UUID, MAIN_VIEW_UUID];
  const namespaces = ['claude.web', 'claude.hybrid', 'claude.settings'];

  setTimeout(() => {
    console.log(`${LOG_PREFIX} Overriding critical handlers in internal map...`);
    const invokeMap = ipcMain._invokeHandlers;

    if (!invokeMap) {
      console.log(`${LOG_PREFIX} WARNING: _invokeHandlers map not available!`);
      return;
    }

    for (const handlerName of criticalHandlers) {
      const config = handlers[handlerName];
      if (!config) continue;

      // Directly replace handlers in the internal map
      for (const uuid of knownUUIDs) {
        for (const ns of namespaces) {
          const fullChannel = `$eipc_message$_${uuid}_$_${ns}_$_${handlerName}`;
          if (invokeMap.has(fullChannel)) {
            const newHandler = async (event, ...args) => {
              console.log(`${LOG_PREFIX} OVERRIDE handler called: ${handlerName}`);
              return config.handler(event, ...args);
            };
            invokeMap.set(fullChannel, newHandler);
            console.log(`${LOG_PREFIX} Overrode: ${fullChannel}`);
          } else {
            console.log(`${LOG_PREFIX} Not in map: ${fullChannel}`);
          }
        }
      }
    }
  }, 50); // Very short delay - must happen before page loads

  // Also override at 200ms and 500ms for safety
  [200, 500, 1000].forEach(delay => {
    setTimeout(() => {
      const invokeMap = ipcMain._invokeHandlers;
      if (!invokeMap) return;
      for (const handlerName of criticalHandlers) {
        const config = handlers[handlerName];
        if (!config) continue;
        for (const uuid of knownUUIDs) {
          for (const ns of namespaces) {
            const fullChannel = `$eipc_message$_${uuid}_$_${ns}_$_${handlerName}`;
            if (invokeMap.has(fullChannel)) {
              const newHandler = async (event, ...args) => {
                return config.handler(event, ...args);
              };
              invokeMap.set(fullChannel, newHandler);
            }
          }
        }
      }
    }, delay);
  });
}

/**
 * Register additional handlers dynamically
 */
function addHandler(name, config) {
  handlers[name] = config;
  
  if (discoveredUUID) {
    const namespaces = ['claude.web', 'claude.hybrid', 'claude.settings'];
    for (const ns of namespaces) {
      const fullChannel = `$eipc_message$_${discoveredUUID}_$_${ns}_$_${name}`;
      registerChannel(fullChannel, config);
    }
  }
  
  registerChannel(name, config);
}

module.exports = {
  setup,
  addHandler,
  registerAllWithUUID,
  extractUUID,
  handlers,
};
