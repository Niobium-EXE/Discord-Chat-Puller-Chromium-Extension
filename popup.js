const start = document.getElementById('start');
const stop = document.getElementById('stop');
const status = document.getElementById('status');
const previousFile = document.getElementById('previousFile');
const previousStatus = document.getElementById('previousStatus');
const clearPrevious = document.getElementById('clearPrevious');
const mainTab = document.getElementById('mainTab');
const advancedTab = document.getElementById('advancedTab');
const mainPanel = document.getElementById('mainPanel');
const advancedPanel = document.getElementById('advancedPanel');
const videos = document.getElementById('videos');
const files = document.getElementById('files');
const threads = document.getElementById('threads');

let previousSnapshot = null;
let previousParseToken = 0;

function selectSettingsTab(which) {
  const advanced = which === 'advanced';
  mainTab?.classList.toggle('active', !advanced);
  advancedTab?.classList.toggle('active', advanced);
  mainTab?.setAttribute('aria-selected', String(!advanced));
  advancedTab?.setAttribute('aria-selected', String(advanced));
  if (mainPanel) mainPanel.hidden = advanced;
  if (advancedPanel) advancedPanel.hidden = !advanced;
}

mainTab?.addEventListener('click', () => selectSettingsTab('main'));
advancedTab?.addEventListener('click', () => selectSettingsTab('advanced'));

// Tooltips use fixed positioning so they can be clamped to the visible popup/sidebar
// instead of overflowing when an info icon is close to an edge.
function positionInfoTooltip(info) {
  const tooltip = info?.querySelector?.('.tooltip');
  if (!tooltip) return;

  const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth || 1);
  const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight || 1);
  const margin = viewportWidth <= 310 ? 10 : 12;
  const gap = 7;
  const preferredWidth = 284;
  const width = Math.max(120, Math.min(preferredWidth, viewportWidth - (margin * 2)));

  tooltip.style.width = `${width}px`;
  tooltip.style.maxWidth = `${width}px`;

  const iconRect = info.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const tooltipHeight = Math.min(tooltipRect.height || 0, Math.max(0, viewportHeight - margin * 2));

  let left = iconRect.left + (iconRect.width / 2) - (width / 2);
  left = Math.max(margin, Math.min(left, viewportWidth - width - margin));

  let top = iconRect.bottom + gap;
  if (tooltipHeight && top + tooltipHeight > viewportHeight - margin) {
    const above = iconRect.top - gap - tooltipHeight;
    if (above >= margin) top = above;
    else top = Math.max(margin, viewportHeight - tooltipHeight - margin);
  }

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.right = 'auto';
  tooltip.style.top = `${Math.round(top)}px`;
}

const infoIcons = [...document.querySelectorAll('.info')];
for (const info of infoIcons) {
  info.addEventListener('mouseenter', () => positionInfoTooltip(info));
  info.addEventListener('focus', () => positionInfoTooltip(info));
}
window.addEventListener('resize', () => {
  const active = infoIcons.find(info => info.matches(':hover') || info === document.activeElement);
  if (active) positionInfoTooltip(active);
});

function setStatus(text) {
  status.textContent = text;
}

function setPreviousStatus(text, state = '') {
  previousStatus.textContent = text;
  previousStatus.dataset.state = state;
}

function setRunState({ running = false, canStop = false } = {}) {
  start.disabled = running;
  stop.disabled = !canStop;
  stop.classList.toggle('stop-active', Boolean(running));
  previousFile.disabled = running;
  clearPrevious.disabled = running || !previousSnapshot;
  for (const id of ['format', 'images', 'videos', 'files', 'threads', 'delay', 'stagnant']) {
    const control = document.getElementById(id);
    if (control) control.disabled = running;
  }
}

async function activeDiscordTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://discord.com/channels/')) return null;
  return tab;
}

async function refreshStatus() {
  const tab = await activeDiscordTab();
  if (!tab) {
    setStatus('Open a Discord channel or DM at discord.com first.');
    setRunState({ running: false, canStop: false });
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'DHE_GET_STATUS' });
    if (response?.ok) {
      setStatus(response.text || (response.running ? 'Export running.' : 'Ready.'));
      setRunState({ running: Boolean(response.running), canStop: Boolean(response.canStop) });
    }
  } catch (_) {
    setRunState({ running: false, canStop: false });
  }
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function parseMaybeJson(value, fallback) {
  const text = cleanString(value);
  if (!text) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  return /^(true|1|yes)$/i.test(cleanString(value));
}

function safeComparisonUrl(value) {
  const raw = cleanString(value);
  if (!raw) return '';
  if (raw.startsWith('data:image/')) return raw.length <= 750000 ? raw : '';
  if (raw.length > 8192) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function compactAssets(value) {
  const arr = Array.isArray(value) ? value : [];
  return arr.slice(0, 100).map(item => {
    if (typeof item === 'string') return safeComparisonUrl(item);
    if (!item || typeof item !== 'object') return null;
    const copy = { ...item };
    if ('url' in copy) copy.url = safeComparisonUrl(copy.url);
    if ('src' in copy) copy.src = safeComparisonUrl(copy.src);
    return copy;
  }).filter(item => item && (typeof item !== 'string' || item));
}

function compactMessage(message = {}) {
  const editHistory = Array.isArray(message.editHistory)
    ? message.editHistory.slice(0, 100).map(edit => ({
        timestamp: cleanString(edit?.timestamp),
        localTimestamp: cleanString(edit?.localTimestamp),
        content: String(edit?.content ?? ''),
        contentParts: Array.isArray(edit?.contentParts)
          ? edit.contentParts.slice(0, 500).map(part => {
              if (!part || typeof part !== 'object') return part;
              if (part.type === 'emoji') return { ...part, url: safeComparisonUrl(part.url) };
              return part;
            })
          : []
      }))
    : [];

  return {
    id: cleanString(message.id),
    channelId: cleanString(message.channelId),
    timestamp: cleanString(message.timestamp),
    localTimestamp: cleanString(message.localTimestamp),
    author: cleanString(message.author),
    authorKey: cleanString(message.authorKey),
    avatar: safeComparisonUrl(message.avatar),
    groupStart: boolValue(message.groupStart),
    deleted: boolValue(message.deleted),
    deletedSource: cleanString(message.deletedSource),
    edited: boolValue(message.edited),
    editedSource: cleanString(message.editedSource),
    editHistory,
    content: String(message.content ?? ''),
    contentParts: Array.isArray(message.contentParts)
      ? message.contentParts.slice(0, 1000).map(part => {
          if (!part || typeof part !== 'object') return part;
          if (part.type === 'emoji') return { ...part, url: safeComparisonUrl(part.url) };
          return part;
        })
      : [],
    reply: String(message.reply ?? ''),
    attachments: compactAssets(message.attachments),
    embeds: compactAssets(message.embeds),
    images: compactAssets(message.images),
    emojis: compactAssets(message.emojis),
    stickers: compactAssets(message.stickers),
    reactionEmojis: compactAssets(message.reactionEmojis),
    reactions: Array.isArray(message.reactions) ? message.reactions.slice(0, 100).map(String) : [],
    deletedBetweenExports: boolValue(message.deletedBetweenExports),
    deletedBetweenExportsSource: cleanString(message.deletedBetweenExportsSource),
    deletedBetweenExportsNote: cleanString(message.deletedBetweenExportsNote),
    comparisonStatus: cleanString(message.comparisonStatus),
    previousExportedAt: cleanString(message.previousExportedAt),
    comparisonDetectedAt: cleanString(message.comparisonDetectedAt),
    isThreadMessage: boolValue(message.isThreadMessage),
    threadId: cleanString(message.threadId),
    threadName: cleanString(message.threadName),
    threadParentMessageId: cleanString(message.threadParentMessageId),
    threadSourceUrl: cleanString(message.threadSourceUrl)
  };
}

function exportTimestampFromFilename(filename) {
  const name = String(filename || '');
  const match = name.match(/-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(?:html|json|csv))?\.(?:zip|mhtml|mht|html?|json|csv)$/i);
  if (!match) return '';
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function finalizeSnapshot(raw, file) {
  const messages = (Array.isArray(raw?.messages) ? raw.messages : [])
    .map(compactMessage)
    .filter(message => /^\d{15,}$/.test(message.id));
  if (!messages.length) throw new Error('No Discord message IDs were found in that export.');
  return {
    source: cleanString(raw?.source),
    exportedAt: cleanString(raw?.exportedAt) || exportTimestampFromFilename(file?.name) || (file?.lastModified ? new Date(file.lastModified).toISOString() : ''),
    filename: file?.name || cleanString(raw?.filename) || 'previous export',
    format: cleanString(raw?.format),
    messages
  };
}

function parseJsonText(text, file) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) return finalizeSnapshot({ messages: data, format: 'json' }, file);
  return finalizeSnapshot({ ...data, format: data.format || 'json' }, file);
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function parseCsvArray(text) {
  if (!cleanString(text)) return [];
  const direct = parseMaybeJson(text, null);
  if (Array.isArray(direct)) return direct;
  return String(text).split(' | ').map(v => v.trim()).filter(Boolean).map(value => parseMaybeJson(value, value));
}

function parseCsvText(text, file) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('The CSV does not contain any message rows.');
  const headers = rows[0];
  const messages = rows.slice(1).filter(row => row.some(Boolean)).map(row => {
    const obj = {};
    headers.forEach((key, i) => { obj[key] = row[i] ?? ''; });
    for (const key of ['attachments', 'embeds', 'images', 'emojis', 'stickers', 'reactionEmojis', 'reactions', 'contentParts', 'editHistory']) {
      obj[key] = parseCsvArray(obj[key]);
    }
    for (const key of ['groupStart', 'deleted', 'edited', 'deletedBetweenExports', 'isThreadMessage']) obj[key] = boolValue(obj[key]);
    return obj;
  });
  return finalizeSnapshot({ messages, format: 'csv' }, file);
}

function directChildByClass(node, className) {
  return [...(node?.children || [])].find(child => child.classList?.contains(className)) || null;
}

function contentPartsFromHtml(container) {
  if (!container) return [];
  const parts = [];
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) parts.push({ type: 'text', text: node.nodeValue });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches('img.inline-emoji')) {
      parts.push({ type: 'emoji', alt: node.getAttribute('alt') || ':emoji:', url: safeComparisonUrl(node.getAttribute('src') || '') });
      return;
    }
    if (node.tagName === 'BR') parts.push({ type: 'text', text: '\n' });
    for (const child of node.childNodes) walk(child);
  };
  for (const child of container.childNodes) walk(child);
  return parts;
}

function parseHtmlText(text, file, format = 'html') {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const sourceLink = [...doc.querySelectorAll('a[href]')]
    .map(a => a.getAttribute('href') || '')
    .find(href => /^https:\/\/discord\.com\/channels\//i.test(href)) || '';
  let channelId = '';
  try { channelId = new URL(sourceLink).pathname.split('/').filter(Boolean).pop() || ''; } catch (_) {}

  const metaEl = doc.getElementById('dhe-export-meta');
  const embeddedMeta = metaEl ? parseMaybeJson(metaEl.textContent, {}) : {};
  const messages = [...doc.querySelectorAll('.message[data-message-id]')].map(messageEl => {
    const article = messageEl.closest('.message-group');
    const author = cleanString(article?.querySelector('.group-header strong')?.textContent);
    const avatar = safeComparisonUrl(article?.querySelector('img.avatar[src]')?.getAttribute('src') || '');
    const meta = directChildByClass(messageEl, 'message-meta');
    const timeEl = meta?.querySelector('time');
    const timestamp = cleanString(timeEl?.getAttribute('datetime') || timeEl?.textContent);
    const contentEl = directChildByClass(messageEl, 'content');
    const replyEl = directChildByClass(messageEl, 'reply');
    const betweenNote = directChildByClass(messageEl, 'between-export-note');
    const imageUrls = [...messageEl.querySelectorAll('.gallery:not(.stickers) img[src]')].map(img => safeComparisonUrl(img.getAttribute('src'))).filter(Boolean);
    const stickerUrls = [...messageEl.querySelectorAll('.gallery.stickers img[src]')].map(img => ({ url: safeComparisonUrl(img.getAttribute('src')), name: img.getAttribute('alt') || 'Discord sticker' })).filter(x => x.url);
    const isThreadMessage = messageEl.dataset.threadMessage === 'true';
    const threadId = cleanString(messageEl.dataset.threadId);
    return {
      id: cleanString(messageEl.dataset.messageId),
      channelId: isThreadMessage && threadId ? threadId : channelId,
      timestamp,
      author,
      avatar,
      deleted: messageEl.dataset.deleted === 'true',
      edited: messageEl.dataset.edited === 'true',
      deletedBetweenExports: messageEl.dataset.deletedBetweenExports === 'true',
      deletedBetweenExportsNote: cleanString(betweenNote?.textContent),
      content: cleanString(contentEl?.textContent),
      contentParts: contentPartsFromHtml(contentEl),
      reply: cleanString(replyEl?.textContent).replace(/^Reply context:\s*/i, ''),
      images: imageUrls,
      stickers: stickerUrls,
      isThreadMessage,
      threadId,
      threadName: cleanString(messageEl.dataset.threadName),
      threadParentMessageId: cleanString(messageEl.dataset.threadParentMessageId),
      threadSourceUrl: cleanString(messageEl.dataset.threadSourceUrl)
    };
  });

  return finalizeSnapshot({
    source: embeddedMeta.source || sourceLink,
    exportedAt: embeddedMeta.exportedAt || '',
    messages,
    format
  }, file);
}

function decodeQuotedPrintable(text) {
  const normalized = String(text).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const encoded = new TextEncoder().encode(normalized[i]);
      bytes.push(...encoded);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function extractHtmlFromMhtml(text) {
  const boundaryMatch = text.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\r\n]+))/i);
  if (!boundaryMatch) throw new Error('Could not find the MHTML MIME boundary.');
  const boundary = (boundaryMatch[1] || boundaryMatch[2] || '').trim();
  const parts = text.split(`--${boundary}`);
  for (const part of parts) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const headerText = part.slice(0, split);
    if (!/Content-Type:\s*text\/html/i.test(headerText)) continue;
    let body = part.slice(split).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
    const transfer = (headerText.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i)?.[1] || '8bit').trim().toLowerCase();
    if (transfer === 'base64') {
      const binary = atob(body.replace(/\s+/g, ''));
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      body = new TextDecoder().decode(bytes);
    } else if (transfer === 'quoted-printable') {
      body = decodeQuotedPrintable(body);
    }
    return body;
  }
  throw new Error('The MHTML file does not contain an HTML transcript part.');
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('This ZIP uses compression that this browser cannot decode here.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzipEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;

  while (offset + 4 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) { offset++; continue; }
    if (offset + 30 > bytes.length) break;
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (flags & 0x0008) throw new Error('ZIP files using data descriptors are not supported for comparison imports.');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error('The ZIP appears to be truncated.');
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    const compressed = bytes.slice(dataStart, dataEnd);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = await inflateRaw(compressed);
    else throw new Error(`Unsupported ZIP compression method ${method}.`);
    if (name && !name.endsWith('/')) entries.set(name, data);
    offset = dataEnd;
  }
  return entries;
}

function chooseTranscriptEntry(entries) {
  const names = [...entries.keys()];
  const root = names.filter(name => !name.includes('/'));
  const pools = root.length ? root : names;
  for (const ext of ['.json', '.csv', '.html', '.htm']) {
    const match = pools.find(name => name.toLowerCase().endsWith(ext) && !/comparison-snapshot|export-meta/i.test(name));
    if (match) return match;
  }
  return null;
}

async function parsePreviousExport(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.zip')) {
    const entries = await unzipEntries(await file.arrayBuffer());
    const transcriptName = chooseTranscriptEntry(entries);
    if (!transcriptName) throw new Error('Could not find an HTML, JSON, or CSV transcript inside that ZIP.');
    const text = new TextDecoder().decode(entries.get(transcriptName));
    const innerFile = { name: transcriptName, lastModified: file.lastModified };
    if (/\.json$/i.test(transcriptName)) return parseJsonText(text, innerFile);
    if (/\.csv$/i.test(transcriptName)) return parseCsvText(text, innerFile);
    return parseHtmlText(text, innerFile, 'zip-html');
  }

  const text = await file.text();
  if (/\.(mhtml|mht)$/i.test(lower)) return parseHtmlText(extractHtmlFromMhtml(text), file, 'mhtml');
  if (/\.json$/i.test(lower)) return parseJsonText(text, file);
  if (/\.csv$/i.test(lower)) return parseCsvText(text, file);
  if (/\.html?$/i.test(lower)) return parseHtmlText(text, file, 'html');
  throw new Error('Choose a previous .mhtml, .zip, .html, .json, or .csv export.');
}

async function sendPreviousSnapshot(tabId, snapshot) {
  if (!snapshot) {
    await chrome.tabs.sendMessage(tabId, { type: 'DHE_PREVIOUS_CLEAR' });
    return;
  }

  const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const meta = {
    source: snapshot.source || '',
    exportedAt: snapshot.exportedAt || '',
    filename: snapshot.filename || 'previous export',
    format: snapshot.format || '',
    total: snapshot.messages.length
  };
  let response = await chrome.tabs.sendMessage(tabId, { type: 'DHE_PREVIOUS_BEGIN', sessionId, meta });
  if (!response?.ok) throw new Error(response?.error || 'Could not prepare the previous export comparison.');

  let batch = [];
  let batchChars = 0;
  let sent = 0;
  const flush = async () => {
    if (!batch.length) return;
    const result = await chrome.tabs.sendMessage(tabId, { type: 'DHE_PREVIOUS_CHUNK', sessionId, messages: batch });
    if (!result?.ok) throw new Error(result?.error || 'Could not transfer the previous export.');
    sent += batch.length;
    setStatus(`Loading previous export into the Discord tab…\n${sent}/${snapshot.messages.length} messages`);
    batch = [];
    batchChars = 0;
  };

  for (const message of snapshot.messages) {
    const approx = JSON.stringify(message).length;
    if (batch.length && (batch.length >= 250 || batchChars + approx > 350000)) await flush();
    batch.push(message);
    batchChars += approx;
  }
  await flush();

  response = await chrome.tabs.sendMessage(tabId, { type: 'DHE_PREVIOUS_END', sessionId });
  if (!response?.ok) throw new Error(response?.error || 'Could not finish loading the previous export.');
}

previousFile.addEventListener('change', async () => {
  const token = ++previousParseToken;
  const file = previousFile.files?.[0];
  previousSnapshot = null;
  clearPrevious.disabled = true;
  if (!file) {
    setPreviousStatus('No previous export selected.');
    return;
  }
  setPreviousStatus(`Reading ${file.name}…`, 'loading');
  try {
    const parsed = await parsePreviousExport(file);
    if (token !== previousParseToken) return;
    previousSnapshot = parsed;
    setPreviousStatus(`Loaded ${parsed.messages.length.toLocaleString()} messages from ${file.name}.`, 'ok');
    clearPrevious.disabled = false;
  } catch (err) {
    if (token !== previousParseToken) return;
    previousFile.value = '';
    setPreviousStatus(`Could not use that export: ${err.message}`, 'error');
  }
});

clearPrevious.addEventListener('click', () => {
  previousParseToken++;
  previousSnapshot = null;
  previousFile.value = '';
  clearPrevious.disabled = true;
  setPreviousStatus('No previous export selected.');
});

start.addEventListener('click', async () => {
  const tab = await activeDiscordTab();
  if (!tab) {
    setStatus('Open a Discord channel or DM at discord.com first.');
    return;
  }

  const format = document.getElementById('format').value;
  const includeImages = document.getElementById('images').checked;
  const includeVideos = Boolean(videos?.checked);
  const includeFiles = Boolean(files?.checked);
  const includeThreads = Boolean(threads?.checked);
  const delayMs = Math.max(300, Number(document.getElementById('delay').value) || 900);
  const stagnantLimit = Math.max(3, Number(document.getElementById('stagnant').value) || 8);

  setRunState({ running: true, canStop: true });
  setStatus(previousSnapshot ? 'Preparing comparison with previous export…' : 'Starting…');

  try {
    await sendPreviousSnapshot(tab.id, previousSnapshot);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'DHE_START_EXPORT',
      options: { format, includeImages, includeVideos, includeFiles, includeThreads, delayMs, stagnantLimit, comparePrevious: Boolean(previousSnapshot) }
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not start export.');
    setStatus(previousSnapshot
      ? 'Export running. The current pull will be compared with the selected previous export.'
      : 'Export running. Keep this Discord tab open.');
  } catch (err) {
    setStatus(`Error: ${err.message}\nReload the Discord tab and try again.`);
    setRunState({ running: false, canStop: false });
  }
});

stop.addEventListener('click', async () => {
  const tab = await activeDiscordTab();
  if (!tab) {
    setStatus('The Discord tab is no longer available.');
    setRunState({ running: false, canStop: false });
    return;
  }

  stop.disabled = true;
  setStatus('Stop requested. The exporter will finish the current scan step and download what it has captured.');

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'DHE_STOP_EXPORT' });
    if (!response?.ok) throw new Error(response?.error || 'Could not stop the scan.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    await refreshStatus();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'DHE_PROGRESS') return;
  setStatus(message.text);
  setRunState({
    running: message.done ? false : Boolean(message.running),
    canStop: message.done ? false : Boolean(message.canStop)
  });
});

selectSettingsTab('main');
setPreviousStatus('No previous export selected.');
refreshStatus();
