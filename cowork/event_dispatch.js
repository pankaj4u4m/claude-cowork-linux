/**
 * Event dispatch for Cowork LocalAgentModeSessions
 *
 * Sends events to the renderer process via eipc channels matching the pattern:
 *   $eipc_message$_<uuid>_$_<namespace>_$_LocalAgentModeSessions_$_onEvent
 *
 * Uses known UUIDs from preload scripts + dynamically discovered ones.
 */

const { webContents } = require('electron');

const LOG_PREFIX = '[event-dispatch]';

// Known UUIDs from the preload scripts
const MAIN_VIEW_UUID = '5fdd886a-1e8d-42a1-8970-2f5b612dd244';
const MAIN_PROCESS_UUID = 'c42e5915-d1f8-48a1-a373-fe793971fdbd';

// Set of all known UUIDs (known + discovered at runtime)
const knownUUIDs = new Set([MAIN_VIEW_UUID, MAIN_PROCESS_UUID]);

// Namespaces used by the LocalAgentModeSessions events
const EVENT_NAMESPACES = ['claude.web', 'claude.hybrid'];

/**
 * Register a dynamically discovered UUID (extracted from incoming eipc channel names).
 */
function addDiscoveredUUID(uuid) {
  if (uuid && !knownUUIDs.has(uuid)) {
    knownUUIDs.add(uuid);
    console.log(`${LOG_PREFIX} Discovered new UUID: ${uuid}`);
  }
}

/**
 * Extract UUID from an eipc channel name.
 * Channel format: $eipc_message$_<uuid>_$_<namespace>_$_<handler>
 */
function extractUUID(channel) {
  if (typeof channel !== 'string') return null;
  const match = channel.match(/\$eipc_message\$_([a-f0-9-]+)_\$/);
  return match ? match[1] : null;
}

/**
 * Build the list of eipc channels to dispatch an event on.
 */
function buildEventChannels() {
  const channels = [];
  for (const uuid of knownUUIDs) {
    for (const ns of EVENT_NAMESPACES) {
      channels.push(`$eipc_message$_${uuid}_$_${ns}_$_LocalAgentModeSessions_$_onEvent`);
    }
  }
  return channels;
}

/**
 * Emit a LocalAgentModeSessions event to all renderer webContents.
 * @param {object} payload - The event payload (must include type and sessionId)
 * @returns {number} - Number of successful dispatches
 */
function emitLocalAgentEvent(payload) {
  try {
    const channels = buildEventChannels();
    const allContents = typeof webContents?.getAllWebContents === 'function'
      ? webContents.getAllWebContents()
      : [];

    if (allContents.length === 0) {
      console.warn(`${LOG_PREFIX} No webContents available for event dispatch`);
      return 0;
    }

    let dispatched = 0;
    for (const contents of allContents) {
      if (contents.isDestroyed()) continue;
      for (const channel of channels) {
        try {
          contents.send(channel, payload);
          dispatched++;
        } catch (_) {
          // Ignore per-webContents errors (window may be closing)
        }
      }
    }

    // Log when all dispatches fail
    if (dispatched === 0) {
      console.warn(`${LOG_PREFIX} Failed to dispatch ${payload.type} for ${payload.sessionId || '?'} to any target`);
    }

    // Only log non-spammy events at info level
    const isSpammy = payload.type === 'streamEvent' || payload.type === 'toolProgress';
    if (!isSpammy && dispatched > 0) {
      console.log(
        `${LOG_PREFIX} Emitted ${payload.type} for ${payload.sessionId || '?'} to ${dispatched} targets`
      );
    }

    return dispatched;
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to emit event:`, e.message);
    return 0;
  }
}

module.exports = {
  emitLocalAgentEvent,
  addDiscoveredUUID,
  extractUUID,
  MAIN_VIEW_UUID,
  MAIN_PROCESS_UUID,
};
