(() => {
  if (window.__DHE_LOADED__) return;
  window.__DHE_LOADED__ = true;

  let running = false;
  let stopRequested = false;
  let phase = 'idle';
  let lastProgressText = 'Ready.';
  let lastViewportCaptureAt = 0;
  let previousImport = null;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function sendProgress(text, done = false) {
    lastProgressText = text;
    const canStop = running && !done && (phase === 'starting' || phase === 'scanning' || phase === 'threads');
    try {
      chrome.runtime.sendMessage({
        type: 'DHE_PROGRESS',
        text,
        done,
        running: done ? false : running,
        phase,
        canStop
      });
    } catch (_) {}
  }

  function visibleMessageNodes(channelId = '') {
    const wanted = String(channelId || '');
    const byId = [...document.querySelectorAll('[id^="chat-messages-"]')]
      .filter(el => /^chat-messages-\d+-\d+$/.test(el.id))
      .filter(el => !wanted || channelIdFromNode(el) === wanted);
    if (byId.length) return byId;

    return [...document.querySelectorAll('[data-list-item-id^="chat-messages"]')]
      .filter(el => /\d+$/.test(el.getAttribute('data-list-item-id') || ''))
      .filter(el => !wanted || channelIdFromNode(el) === wanted);
  }

  function messageIdFromNode(node) {
    const raw = node.id || node.getAttribute('data-list-item-id') || '';
    const m = raw.match(/chat-messages[-_](\d+)[-_](\d+)$/) || raw.match(/(\d{15,})$/);
    return m ? m[m.length - 1] : null;
  }

  function channelIdFromNode(node) {
    const raw = node.id || node.getAttribute('data-list-item-id') || '';
    const m = raw.match(/chat-messages[-_](\d+)[-_](\d+)$/);
    return m ? m[1] : null;
  }

  function cleanText(text) {
    return (text || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  function firstText(node, selectors) {
    for (const selector of selectors) {
      const el = node.querySelector(selector);
      const text = cleanText(el?.textContent);
      if (text) return text;
    }
    return '';
  }

  function isDiscordMediaHost(hostname) {
    return hostname === 'cdn.discordapp.com' ||
      hostname === 'media.discordapp.net' ||
      hostname === 'images-ext-1.discordapp.net' ||
      hostname === 'images-ext-2.discordapp.net';
  }

  function safeUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      return u.protocol === 'https:' ? u.href : '';
    } catch (_) {
      return '';
    }
  }

  function isInlineImageDataUrl(raw) {
    return /^data:image\/(?:svg\+xml|png|apng|gif|webp|jpeg);base64,[a-z0-9+/=]+$/i.test(String(raw || ''));
  }

  function safeAssetUrl(raw) {
    const value = String(raw || '');
    if (isInlineImageDataUrl(value)) return value;
    return safeUrl(value);
  }

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(String(text || ''));
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function isDiscordEmojiUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      return isDiscordMediaHost(u.hostname) && /\/emojis\/\d+/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function isDiscordStickerUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      const stickerHost = isDiscordMediaHost(u.hostname) || u.hostname === 'discord.com';
      return stickerHost && /\/stickers\/\d+/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function isConversationImageUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!isDiscordMediaHost(u.hostname)) return false;
      const p = u.pathname.toLowerCase();
      if (/\/(avatars|icons|emojis|role-icons|stickers)\//.test(p)) return false;
      return /\/(attachments|external)\//.test(p) ||
        /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function isRenderableImageUrl(raw) {
    if (isInlineImageDataUrl(raw)) return true;
    try {
      const u = new URL(raw, location.href);
      return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function isDiscordAvatarUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!isDiscordMediaHost(u.hostname)) return false;
      const p = u.pathname.toLowerCase();
      return /\/avatars\//.test(p) ||
        /\/embed\/avatars\//.test(p) ||
        /\/guilds\/\d+\/users\/\d+\/avatars\//.test(p);
    } catch (_) {
      return false;
    }
  }

  function authorElementFromNode(node) {
    const selectors = [
      'h3 [class*="username"]',
      '[class*="headerText"] [class*="username"]',
      '[class*="username"][role="button"]',
      '[class*="username"]'
    ];
    for (const selector of selectors) {
      const el = node.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function avatarUserId(raw) {
    try {
      const path = new URL(raw, location.href).pathname;
      const matches = [
        path.match(/\/guilds\/\d+\/users\/(\d+)\/avatars\//i),
        path.match(/\/users\/(\d+)\/avatars\//i),
        path.match(/\/avatars\/(\d+)\//i)
      ];
      for (const match of matches) if (match) return match[1];
    } catch (_) {}
    return '';
  }

  function snowflakeFromValue(raw) {
    const match = String(raw || '').match(/(?:^|\D)(\d{15,22})(?:\D|$)/);
    return match ? match[1] : '';
  }

  function userIdFromElementAttributes(el) {
    if (!el) return '';
    for (const attr of [...el.attributes || []]) {
      const name = String(attr.name || '');
      // Avoid generic ids/message snowflakes. Only accept attributes whose name
      // explicitly says the value belongs to a user/author/member/profile.
      if (!/(?:user|author|member|profile).*(?:id)|(?:^|[-_:])uid(?:$|[-_:])/i.test(name)) continue;
      const id = snowflakeFromValue(attr.value);
      if (id) return id;
    }
    return '';
  }

  function authorUserIdFromNode(node, avatar = '') {
    const avatarId = avatarUserId(avatar);
    if (avatarId) return avatarId;

    const authorEl = authorElementFromNode(node);
    let el = authorEl;
    let hops = 0;
    while (el && hops < 7) {
      const id = userIdFromElementAttributes(el);
      if (id) return id;
      if (el === node) break;
      el = el.parentElement;
      hops++;
    }

    // Discord occasionally puts the useful author id on a child wrapper instead
    // of the username itself. Keep this targeted to author/user-like attributes so
    // message, channel, emoji, and sticker snowflakes cannot be mistaken for a user.
    const targeted = node?.querySelectorAll?.(
      '[data-user-id],[data-author-id],[data-member-id],[data-profile-id],[user-id],[author-id],[member-id]'
    ) || [];
    for (const candidate of targeted) {
      const id = userIdFromElementAttributes(candidate);
      if (id) return id;
    }
    return '';
  }

  function defaultAvatarUrlForUserId(userId) {
    try {
      if (!/^\d{15,22}$/.test(String(userId || ''))) return '';
      const index = Number((BigInt(userId) >> 22n) % 6n);
      return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    } catch (_) {
      return '';
    }
  }

  function authorIdentityFromNode(node, author, avatar) {
    const userId = authorUserIdFromNode(node, avatar);
    if (userId) return `user:${userId}`;
    return author ? `name:${author}` : '';
  }

  function cssImageUrls(value) {
    const urls = [];
    const re = /url\(["']?([^"')]+)["']?\)/g;
    let match;
    while ((match = re.exec(value || ''))) urls.push(match[1]);
    return urls;
  }

  function collectAvatar(node) {
    // Only inspect elements that Discord itself marks as an avatar. In Compact
    // mode the author's avatar is normally absent from the message row, and a
    // broad `querySelectorAll('img')` can accidentally pick an avatar from an
    // embed/reply/profile preview inside the message. A missing avatar is safer:
    // hydrateVisibleAvatars() will resolve that exact author from their popout.
    const candidates = [
      ...node.querySelectorAll('img[class*="avatar" i]'),
      ...node.querySelectorAll('[class*="avatar" i] img'),
      ...node.querySelectorAll('img[aria-label*="avatar" i]')
    ];

    for (const img of [...new Set(candidates)]) {
      // Ignore avatar-looking media that belongs to embed/reply content rather
      // than the message header itself.
      if (img.closest?.('[class*="embed" i],[class*="replied" i],[class*="reply" i]')) continue;
      const candidates = [
        img.currentSrc,
        img.src,
        img.getAttribute('src'),
        ...(img.getAttribute('srcset') || '').split(',').map(x => x.trim().split(/\s+/)[0])
      ];
      for (const raw of candidates) {
        const src = safeUrl(raw || '');
        if (src && isDiscordAvatarUrl(src)) return src;
      }
    }

    for (const el of node.querySelectorAll('[class*="avatar" i][style*="background"], [class*="avatar" i] [style*="background"]')) {
      if (el.closest?.('[class*="embed" i],[class*="replied" i],[class*="reply" i]')) continue;
      for (const raw of cssImageUrls(el.getAttribute('style') || '')) {
        const src = safeUrl(raw);
        if (src && isDiscordAvatarUrl(src)) return src;
      }
    }
    return '';
  }

  function isImageAttachmentUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!isDiscordMediaHost(u.hostname)) return false;
      return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function isDiscordAttachmentUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      return isDiscordMediaHost(u.hostname) && /\/attachments\//i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function isVideoAttachmentUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      return isDiscordAttachmentUrl(u.href) && /\.(?:mp4|m4v|mov|webm|ogv|avi|mkv)$/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function isOtherAttachmentFileUrl(raw) {
    return isDiscordAttachmentUrl(raw) && !isImageAttachmentUrl(raw) && !isVideoAttachmentUrl(raw);
  }

  function elementMediaUrls(el) {
    const raw = [];
    for (const attr of ['src', 'href', 'data-src', 'data-url', 'poster']) {
      const value = el.getAttribute?.(attr);
      if (value) raw.push(value);
    }
    const srcset = el.getAttribute?.('srcset') || '';
    for (const item of srcset.split(',')) {
      const url = item.trim().split(/\s+/)[0];
      if (url) raw.push(url);
    }
    const style = el.getAttribute?.('style') || '';
    raw.push(...cssImageUrls(style));
    return [...new Set(raw.map(safeUrl).filter(Boolean))];
  }

  function mediaElements(node) {
    return [
      ...node.querySelectorAll('img,source,video,a[href],[style*="background"],[style*="url("]')
    ];
  }

  function mediaNameFromElement(el, fallback = '') {
    const values = [
      el.getAttribute?.('alt'),
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.closest?.('[aria-label]')?.getAttribute?.('aria-label'),
      fallback
    ];
    return cleanText(values.find(Boolean) || '');
  }

  function collectAssetObjects(node, predicate, { excludeReactions = false } = {}) {
    const found = new Map();
    for (const el of mediaElements(node)) {
      if (excludeReactions && el.closest?.('[class*="reaction"]')) continue;
      for (const url of elementMediaUrls(el)) {
        if (!predicate(url)) continue;
        const key = canonicalImageKey(url);
        if (!found.has(key)) found.set(key, { url, name: mediaNameFromElement(el) });
      }
    }
    return [...found.values()];
  }

  function isStickerMarkedElement(el) {
    if (!el?.closest) return false;
    return Boolean(el.closest(
      '[class*="sticker" i],[aria-label*="sticker" i],[data-sticker-id],[data-sticker_id],[data-sticker]'
    ));
  }

  function collectImages(node, attachments) {
    const images = [];
    // Avoid treating Discord sticker renderers as ordinary image attachments.
    // This is one of the main reasons a sticker could appear twice in an export.
    const stickerVisuals = new Set(stickerVisualCandidates(node));
    // Include the same last-resort visual targets used by the sticker screenshot
    // fallback. Without this, a sticker rendered as an otherwise-unmarked <img>
    // can also be collected as a normal conversation image.
    for (const target of stickerViewportTargets(node)) {
      if (target?.el) stickerVisuals.add(target.el);
    }

    for (const img of node.querySelectorAll('img')) {
      if (isStickerMarkedElement(img) || stickerVisuals.has(img)) continue;

      // Prefer the attachment link over Discord's resized preview URL so the saved file
      // is the original image whenever the UI exposes it.
      const anchor = img.closest('a[href]');
      const href = safeUrl(anchor?.href || '');
      if (href && isImageAttachmentUrl(href)) images.push(href);

      for (const src of elementMediaUrls(img)) {
        if (isConversationImageUrl(src)) images.push(src);
      }
    }

    for (const url of attachments || []) {
      if (isImageAttachmentUrl(url)) images.push(url);
    }

    return [...new Set(images)];
  }

  function elementLooksLikeEmoji(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.closest?.('[class*="reaction" i]')) return false;

    const markerText = [
      el.getAttribute?.('class') || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('data-emoji-name') || '',
      el.getAttribute?.('data-emoji-id') || '',
      el.getAttribute?.('alt') || '',
      el.getAttribute?.('title') || ''
    ].join(' ');

    if (/emoji/i.test(markerText)) return true;
    const alt = cleanText(el.getAttribute?.('alt') || '');
    if (/^:[^:\n]{1,64}:$/.test(alt)) return true;

    return elementMediaUrls(el).some(isDiscordEmojiUrl);
  }

  function isDiscordHostedImageLikeUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      const discordStaticAsset = u.hostname === 'discord.com' &&
        /\/assets\/[^/?]+\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(u.pathname);
      if (!isDiscordMediaHost(u.hostname) && !discordStaticAsset) return false;

      const p = u.pathname.toLowerCase();
      if (/\/(?:avatars|icons|role-icons|stickers)\//.test(p)) return false;
      // Discord sometimes proxies emoji through /external/ or serves standard
      // emoji from its static /assets/ bundle instead of /emojis/<id>.
      return discordStaticAsset ||
        /\/(?:emojis|external)\//.test(p) ||
        /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function emojiAssetFromElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.closest?.('[class*="reaction" i]')) return null;

    const urls = elementMediaUrls(el);
    let url = urls.find(isDiscordEmojiUrl) || '';
    if (!url && elementLooksLikeEmoji(el)) {
      url = urls.find(isDiscordHostedImageLikeUrl) || '';
    }
    if (!url) return null;

    const alt = cleanText(
      el.getAttribute?.('alt') ||
      el.getAttribute?.('aria-label') ||
      el.getAttribute?.('data-emoji-name') ||
      el.getAttribute?.('title') ||
      ':emoji:'
    ) || ':emoji:';

    return { url, name: alt, alt };
  }

  function collectEmojis(node) {
    const found = new Map();
    if (!node) return [];

    const candidates = [
      ...node.querySelectorAll(
        'img,source,[class*="emoji" i],[aria-label*="emoji" i],[data-emoji-id],[data-emoji-name]'
      )
    ];

    for (const el of candidates) {
      if (el.closest?.('[class*="reaction" i]')) continue;
      const asset = emojiAssetFromElement(el);
      if (!asset) continue;
      const key = canonicalImageKey(asset.url);
      if (!found.has(key)) found.set(key, asset);
    }
    return [...found.values()];
  }

  function stickerMetaFromElement(el, messageNode, fallbackIndex = 0) {
    let stickerId = '';
    let name = mediaNameFromElement(el, 'Discord sticker');
    const visited = new Set();
    let current = el;
    let hops = 0;

    while (current && current !== messageNode && hops < 8) {
      if (!visited.has(current)) {
        visited.add(current);
        for (const attr of [...current.attributes || []]) {
          const value = String(attr.value || '');
          let match = value.match(/\/stickers\/(\d{15,22})/i);
          if (!match && /sticker/i.test(attr.name)) match = value.match(/\b(\d{15,22})\b/);
          if (match && !stickerId) stickerId = match[1];
          if ((!name || name === 'Discord sticker') && /(?:aria-label|title|alt)/i.test(attr.name)) {
            const candidate = cleanText(value.replace(/\bsticker\b/ig, ''));
            if (candidate) name = candidate;
          }
        }
      }
      current = current.parentElement;
      hops++;
    }

    // Some Discord builds put useful sticker metadata on a descendant rather than
    // the visual element itself, so make one bounded pass over the message attrs.
    if (!stickerId) {
      for (const child of messageNode.querySelectorAll('*')) {
        for (const attr of [...child.attributes || []]) {
          const value = String(attr.value || '');
          const match = value.match(/\/stickers\/(\d{15,22})/i) ||
            (/sticker/i.test(attr.name) ? value.match(/\b(\d{15,22})\b/) : null);
          if (match) {
            stickerId = match[1];
            break;
          }
        }
        if (stickerId) break;
      }
    }

    return { stickerId, name: name || `Discord sticker ${fallbackIndex + 1}` };
  }

  function elementRect(el) {
    try {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    } catch (_) {
      return null;
    }
  }

  function stickerVisualCandidates(node) {
    const directContent = node.querySelector(`[id^="message-content-"]`) || node.querySelector('[class*="messageContent"]');
    const preferred = [
      ...node.querySelectorAll('[class*="sticker" i] canvas,[class*="sticker" i] svg,[class*="sticker" i] img'),
      ...node.querySelectorAll('[aria-label*="sticker" i] canvas,[aria-label*="sticker" i] svg,[aria-label*="sticker" i] img'),
      ...node.querySelectorAll('[data-sticker-id] canvas,[data-sticker-id] svg,[data-sticker-id] img'),
      ...node.querySelectorAll('canvas')
    ];

    // SVG is a common Lottie renderer. Only consider reasonably large SVGs that
    // are outside the ordinary message-content element so reaction/button icons
    // cannot be mistaken for stickers.
    for (const svg of node.querySelectorAll('svg')) {
      if (directContent?.contains(svg)) continue;
      if (svg.closest?.('[class*="reaction" i],button,[role="button"]')) continue;
      const rect = elementRect(svg);
      if (rect && rect.width >= 64 && rect.height >= 64 && rect.width <= 360 && rect.height <= 360) preferred.push(svg);
    }

    const unique = [];
    const seen = new Set();
    for (const el of preferred) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (el.closest?.('[class*="reaction" i]')) continue;
      const rect = elementRect(el);
      if (!rect || rect.width < 48 || rect.height < 48 || rect.width > 420 || rect.height > 420) continue;
      unique.push(el);
    }

    // If Discord wraps the renderer in several nested sticker elements, keep the
    // smallest visible renderer/container for a tight screenshot crop.
    unique.sort((a, b) => {
      const ar = elementRect(a); const br = elementRect(b);
      return ((ar?.width || 9999) * (ar?.height || 9999)) - ((br?.width || 9999) * (br?.height || 9999));
    });

    const filtered = [];
    for (const el of unique) {
      const rect = elementRect(el);
      if (!rect) continue;
      const overlapsExisting = filtered.some(other => {
        const o = elementRect(other);
        if (!o) return false;
        const ix = Math.max(0, Math.min(rect.right, o.right) - Math.max(rect.left, o.left));
        const iy = Math.max(0, Math.min(rect.bottom, o.bottom) - Math.max(rect.top, o.top));
        const intersection = ix * iy;
        const smaller = Math.min(rect.width * rect.height, o.width * o.height);
        return smaller > 0 && intersection / smaller > 0.82;
      });
      if (!overlapsExisting) filtered.push(el);
    }
    return filtered;
  }

  function canvasSnapshot(canvas) {
    try {
      if (!canvas || canvas.tagName !== 'CANVAS' || !canvas.width || !canvas.height) return '';
      const result = canvas.toDataURL('image/png');
      return isInlineImageDataUrl(result) ? result : '';
    } catch (_) {
      // A cross-origin/tainted canvas cannot be read; viewport capture below is
      // intentionally the final fallback for that case.
      return '';
    }
  }

  function serializedStickerSvg(svg) {
    try {
      const rect = elementRect(svg);
      const width = Math.max(1, Math.round(Number(rect?.width) || Number(svg.getAttribute('width')) || 160));
      const height = Math.max(1, Math.round(Number(rect?.height) || Number(svg.getAttribute('height')) || 160));
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(width));
      clone.setAttribute('height', String(height));
      if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);

      const originalEls = [svg, ...svg.querySelectorAll('*')];
      const clonedEls = [clone, ...clone.querySelectorAll('*')];
      const props = [
        'fill','fill-opacity','stroke','stroke-width','stroke-opacity','opacity',
        'display','visibility','transform','transform-origin','clip-path','mask',
        'filter','color','stop-color','stop-opacity','vector-effect'
      ];
      for (let i = 0; i < Math.min(originalEls.length, clonedEls.length); i++) {
        const source = originalEls[i];
        const target = clonedEls[i];
        try {
          const style = getComputedStyle(source);
          const inline = props.map(prop => `${prop}:${style.getPropertyValue(prop)}`).join(';');
          if (inline) target.setAttribute('style', `${target.getAttribute('style') || ''};${inline}`);
        } catch (_) {}
      }

      for (const bad of clone.querySelectorAll('script,foreignObject,iframe,object,embed')) bad.remove();
      for (const el of [clone, ...clone.querySelectorAll('*')]) {
        for (const attr of [...el.attributes || []]) {
          if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
          if (/^(?:href|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value || '')) el.removeAttribute(attr.name);
        }
      }
      const markup = new XMLSerializer().serializeToString(clone);
      return `data:image/svg+xml;base64,${utf8ToBase64(markup)}`;
    } catch (err) {
      console.warn('[DHE] Could not snapshot rendered sticker SVG', err);
      return '';
    }
  }

  function collectStickers(node) {
    const found = new Map();

    // Direct Discord CDN sticker URLs, when the client exposes one.
    for (const asset of collectAssetObjects(node, isDiscordStickerUrl)) {
      const key = canonicalImageKey(asset.url);
      found.set(key, { ...asset, stickerId: (asset.url.match(/\/stickers\/(\d{15,22})/i) || [])[1] || '', source: 'discord-url' });
    }

    // Current Discord builds can render Lottie stickers through canvas or SVG.
    // Capture the actual rendered visual rather than assuming a particular DOM.
    let index = 0;
    for (const visual of stickerVisualCandidates(node)) {
      index++;
      const container = visual.closest?.('[class*="sticker" i],[aria-label*="sticker" i],[data-sticker-id]') || visual.parentElement || visual;
      const meta = stickerMetaFromElement(container, node, index - 1);

      // If an image renderer uses a transformed/proxied URL rather than the
      // canonical /stickers/<id> path, keep that rendered image as the sticker.
      if (visual.tagName === 'IMG') {
        for (const raw of [visual.currentSrc, visual.src, visual.getAttribute('src')]) {
          const url = safeAssetUrl(raw || '');
          if (!url) continue;
          const key = meta.stickerId ? `sticker-img:${meta.stickerId}` : `sticker-img:${canonicalImageKey(url)}`;
          if (!found.has(key)) found.set(key, { url, name: meta.name, stickerId: meta.stickerId, stickerSlot: index - 1, renderedSnapshot: true, source: 'rendered-img' });
          break;
        }
      }

      const dataUrl = visual.tagName === 'CANVAS' ? canvasSnapshot(visual) : (visual.tagName === 'SVG' ? serializedStickerSvg(visual) : '');
      if (!dataUrl) continue;
      const key = meta.stickerId ? `sticker-render:${meta.stickerId}` : `rendered-sticker:${dataUrl.slice(-96)}`;
      if (!found.has(key)) {
        found.set(key, {
          url: dataUrl,
          name: meta.name,
          stickerId: meta.stickerId,
          stickerSlot: index - 1,
          renderedSnapshot: true,
          source: visual.tagName === 'CANVAS' ? 'canvas-snapshot' : 'svg-snapshot'
        });
      }
    }

    return mergeStickerLists([...found.values()]);
  }

  function stickerViewportTargets(node) {
    const targets = [];
    const hasOrdinaryContent = Boolean(cleanText((node.querySelector(`[id^="message-content-"]`) || node.querySelector('[class*="messageContent"]'))?.textContent || ''));
    const hasAttachments = Boolean(node.querySelector('a[href*="/attachments/"]'));

    for (const el of stickerVisualCandidates(node)) {
      const rect = elementRect(el);
      if (!rect) continue;
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      const ratio = (visibleWidth * visibleHeight) / Math.max(1, rect.width * rect.height);
      if (ratio < 0.9) continue;
      const container = el.closest?.('[class*="sticker" i],[aria-label*="sticker" i],[data-sticker-id]') || el.parentElement || el;
      targets.push({ el, rect, meta: stickerMetaFromElement(container, node, targets.length) });
    }

    // Last-resort heuristic for sticker-only messages whose current Discord
    // renderer has no stable sticker class at all: a single medium square visual
    // outside message text/attachments is overwhelmingly likely to be the sticker.
    if (!targets.length && !hasOrdinaryContent && !hasAttachments) {
      const candidates = [...node.querySelectorAll('canvas,svg,img')].filter(el => {
        if (el.closest?.('[class*="reaction" i],button,[role="button"]')) return false;
        const rect = elementRect(el);
        if (!rect) return false;
        return rect.width >= 80 && rect.height >= 80 && rect.width <= 320 && rect.height <= 320;
      });
      candidates.sort((a, b) => {
        const ar = elementRect(a); const br = elementRect(b);
        return ((br?.width || 0) * (br?.height || 0)) - ((ar?.width || 0) * (ar?.height || 0));
      });
      if (candidates[0]) {
        const rect = elementRect(candidates[0]);
        const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        const ratio = (visibleWidth * visibleHeight) / Math.max(1, rect.width * rect.height);
        if (ratio >= 0.9) targets.push({ el: candidates[0], rect, meta: stickerMetaFromElement(candidates[0], node, 0) });
      }
    }
    return targets;
  }

  async function loadDataImage(dataUrl) {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not decode viewport capture.'));
      image.src = dataUrl;
    });
  }

  async function cropViewportCapture(dataUrl, rect) {
    const image = await loadDataImage(dataUrl);
    const scaleX = image.naturalWidth / Math.max(1, window.innerWidth);
    const scaleY = image.naturalHeight / Math.max(1, window.innerHeight);
    const sx = Math.max(0, Math.round(rect.left * scaleX));
    const sy = Math.max(0, Math.round(rect.top * scaleY));
    const sw = Math.min(image.naturalWidth - sx, Math.max(1, Math.round(rect.width * scaleX)));
    const sh = Math.min(image.naturalHeight - sy, Math.max(1, Math.round(rect.height * scaleY)));
    if (sw < 8 || sh < 8) return '';

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return '';
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL('image/png');
  }


  async function captureVisiblePageDataUrl() {
    // Chrome limits captureVisibleTab calls. Share one throttle between sticker
    // and avatar fallbacks so a profile lookup cannot collide with sticker scans.
    const waitMs = Math.max(0, 550 - (Date.now() - lastViewportCaptureAt));
    if (waitMs) await sleep(waitMs);
    const response = await runtimeMessage({ type: 'DHE_CAPTURE_VISIBLE' });
    lastViewportCaptureAt = Date.now();
    return response?.ok && response.dataUrl ? response.dataUrl : '';
  }

  function stickerAssetIsUsableVisual(asset) {
    const url = safeAssetUrl(asset?.url || '');
    if (!url) return false;
    if (isInlineImageDataUrl(url)) return true;
    if (asset?.source === 'rendered-img') return true;
    return isRenderableImageUrl(url);
  }

  async function augmentVisibleStickerSnapshots(map) {
    const pending = [];
    for (const node of visibleMessageNodes()) {
      const id = messageIdFromNode(node);
      const message = id ? map.get(id) : null;
      if (!message) continue;
      if ((message.stickers || []).some(asset => asset?.viewportSnapshot)) continue;

      const targets = stickerViewportTargets(node);
      if (!targets.length) continue;

      // The viewport screenshot is a fallback only. If Discord already exposed
      // one usable visual for every sticker target, adding a screenshot creates
      // the exact doubled-sticker bug this exporter used to have.
      const usableCount = (message.stickers || []).filter(stickerAssetIsUsableVisual).length;
      if (usableCount >= targets.length) continue;

      pending.push({ node, message, targets });
    }
    if (!pending.length) return 0;

    let response;
    try {
      const dataUrl = await captureVisiblePageDataUrl();
      response = dataUrl ? { ok: true, dataUrl } : { ok: false };
    } catch (_) {
      return 0;
    }
    if (!response?.ok || !response.dataUrl) return 0;

    let added = 0;
    for (const { message, targets } of pending) {
      const snapshots = [];
      const knownStickerIds = [...new Set(
        (message.stickers || []).map(asset => String(asset?.stickerId || '').trim()).filter(Boolean)
      )];

      for (let targetIndex = 0; targetIndex < Math.min(3, targets.length); targetIndex++) {
        const target = targets[targetIndex];
        try {
          const dataUrl = await cropViewportCapture(response.dataUrl, target.rect);
          if (!dataUrl) continue;

          // Discord's Lottie renderer often omits the ID from the visual node.
          // If this message clearly has one sticker, carry the already-known ID
          // onto the screenshot so mergeStickerLists can replace, not append.
          const inferredStickerId = target.meta.stickerId ||
            ((targets.length === 1 && knownStickerIds.length === 1) ? knownStickerIds[0] : '');

          snapshots.push({
            url: dataUrl,
            name: target.meta.name || 'Discord sticker',
            stickerId: inferredStickerId,
            stickerSlot: targetIndex,
            renderedSnapshot: true,
            viewportSnapshot: true,
            source: 'viewport-snapshot'
          });
        } catch (_) {}
      }
      if (!snapshots.length) continue;

      message.stickers = mergeStickerLists(message.stickers || [], snapshots);
      added += snapshots.length;
    }
    return added;
  }

  function collectReactionEmojis(node) {
    const found = new Map();
    for (const reaction of node.querySelectorAll('[class*="reaction"]')) {
      const label = cleanText(reaction.getAttribute('aria-label') || reaction.textContent);
      for (const el of [reaction, ...reaction.querySelectorAll('img,source,[class*="emoji" i],[style*="background"],[style*="url("]')]) {
        const urls = elementMediaUrls(el);
        const url = urls.find(isDiscordEmojiUrl) ||
          (/(emoji|reaction)/i.test(`${el.getAttribute?.('class') || ''} ${el.getAttribute?.('aria-label') || ''}`)
            ? urls.find(isDiscordHostedImageLikeUrl)
            : '');
        if (!url) continue;
        const key = canonicalImageKey(url);
        if (!found.has(key)) found.set(key, { url, name: mediaNameFromElement(el, label) || label });
      }
    }
    return [...found.values()];
  }

  function compactContentParts(parts) {
    const out = [];
    for (const part of parts) {
      if (!part) continue;
      if (part.type === 'text') {
        if (!part.text) continue;
        const prev = out[out.length - 1];
        if (prev?.type === 'text') prev.text += part.text;
        else out.push({ type: 'text', text: part.text });
      } else {
        out.push(part);
      }
    }
    return out;
  }

  function richContentFromElement(root) {
    if (!root) return { content: '', contentParts: [] };
    const parts = [];

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push({ type: 'text', text: node.nodeValue || '' });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName;

      if (tag === 'BR') {
        parts.push({ type: 'text', text: '\n' });
        return;
      }

      // Detect the rendered emoji element before descending into its children.
      // Discord has used both direct CDN <img>s and proxied/wrapped emoji
      // elements, so relying only on /emojis/<id> URLs is too brittle.
      const emojiAsset = emojiAssetFromElement(el);
      if (emojiAsset) {
        parts.push({
          type: 'emoji',
          url: emojiAsset.url,
          alt: emojiAsset.alt || emojiAsset.name || ':emoji:'
        });
        return;
      }

      // Non-emoji images inside message content are handled by the attachment
      // collector and should not become stray text/content parts here.
      if (tag === 'IMG' || tag === 'SOURCE') return;

      for (const child of el.childNodes) walk(child);
    }

    walk(root);
    const contentParts = compactContentParts(parts);
    const content = cleanText(
      contentParts
        .map(part => part.type === 'emoji' ? (part.alt || ':emoji:') : part.text)
        .join('')
    );
    return { content, contentParts };
  }

  function formatLocalTimestamp(raw) {
    if (!raw) return '';
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return raw;
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      }).format(date);
    } catch (_) {
      return date.toLocaleString();
    }
  }

  function mergeAssetLists(...lists) {
    const merged = new Map();
    for (const list of lists) {
      for (const asset of list || []) {
        const url = safeAssetUrl(typeof asset === 'string' ? asset : asset?.url || '');
        if (!url) continue;
        const key = canonicalImageKey(url);
        const item = typeof asset === 'string' ? { url, name: '' } : { ...asset, url };
        if (!merged.has(key)) merged.set(key, item);
        else if (!merged.get(key).name && item.name) merged.get(key).name = item.name;
      }
    }
    return [...merged.values()];
  }

  function stickerAssetPriority(asset) {
    const source = String(asset?.source || '');
    // Prefer a directly renderable Discord image. A bare Discord sticker URL can
    // point at Lottie data rather than an image, in which case the viewport
    // snapshot is the actually useful representation.
    if (source === 'discord-url') return isRenderableImageUrl(asset?.url || '') ? 700 : 150;
    if (source === 'rendered-img') return 680;
    if (asset?.viewportSnapshot || source === 'viewport-snapshot') return 600;
    if (source === 'canvas-snapshot') return 500;
    if (source === 'svg-snapshot') return 400;
    return 300;
  }

  function mergeStickerLists(...lists) {
    const byUrl = mergeAssetLists(...lists);
    const byStickerId = new Map();
    const bySlot = new Map();
    const noIdentity = [];

    for (const asset of byUrl) {
      const stickerId = String(asset?.stickerId || '').trim();
      const rawSlot = asset?.stickerSlot;
      const hasSlot = Number.isInteger(rawSlot) && rawSlot >= 0;
      const identityMap = stickerId ? byStickerId : (hasSlot ? bySlot : null);
      const identity = stickerId || (hasSlot ? String(rawSlot) : '');

      if (!identityMap) {
        noIdentity.push(asset);
        continue;
      }

      const current = identityMap.get(identity);
      if (!current || stickerAssetPriority(asset) > stickerAssetPriority(current)) {
        identityMap.set(identity, asset);
      } else if (current && !current.name && asset.name) {
        current.name = asset.name;
      }
    }

    // Discord can expose one physical sticker twice: once as an ID-bearing CDN
    // resource and once as a proxied/rendered image with only a visual slot. For
    // the common one-sticker message, collapse those identities into one asset.
    if (byStickerId.size === 1 && bySlot.size === 1) {
      const [stickerId, idAsset] = [...byStickerId.entries()][0];
      const [slot, slotAsset] = [...bySlot.entries()][0];
      const winner = stickerAssetPriority(slotAsset) > stickerAssetPriority(idAsset)
        ? { ...slotAsset, stickerId, stickerSlot: Number(slot) }
        : idAsset;
      byStickerId.set(stickerId, winner);
      bySlot.clear();
    }

    return [...byStickerId.values(), ...bySlot.values(), ...noIdentity];
  }

  function deletedMessageState(node) {
    if (!node) return { deleted: false, deletedSource: '' };

    // Vencord MessageLogger keeps deleted messages in Discord's message list and
    // adds this class to the message <li>. Check a few nearby ancestors as well
    // because Discord occasionally moves the stable chat-messages-* id onto an
    // inner wrapper while Vencord decorates the outer message container.
    let current = node;
    for (let hops = 0; current && hops < 5; hops++, current = current.parentElement) {
      if (current.classList?.contains('messagelogger-deleted')) {
        return { deleted: true, deletedSource: 'vencord-message-logger' };
      }
    }

    // Be tolerant of a future Vencord renderer that places the marker on a child
    // instead of the message root. Keep this exact-class based so ordinary Discord
    // text containing the word "deleted" cannot become a false positive.
    if (node.querySelector?.('.messagelogger-deleted')) {
      return { deleted: true, deletedSource: 'vencord-message-logger' };
    }

    return { deleted: false, deletedSource: '' };
  }

  function stripVencordEditMetadata(root) {
    if (!root) return root;
    const clone = root.cloneNode(true);

    // Vencord appends a Timestamp containing an "(edited)" label to each retained
    // historical revision. Remove only that metadata before parsing the old text,
    // otherwise the literal word "edited" becomes part of the exported message.
    for (const time of clone.querySelectorAll('time')) time.remove();
    for (const marker of clone.querySelectorAll('.messagelogger-edit-marker')) marker.remove();
    for (const el of [...clone.querySelectorAll('span')]) {
      const text = cleanText(el.textContent || '');
      if (/^\(?edited\)?$/i.test(text)) el.remove();
    }
    return clone;
  }

  function parseVencordEditHistory(node) {
    if (!node) return [];
    const entries = [];

    for (const row of node.querySelectorAll('.messagelogger-edited')) {
      const timeEl = row.querySelector('time[datetime]');
      const timestamp = timeEl?.getAttribute('datetime') || '';
      const cleaned = stripVencordEditMetadata(row);
      const rich = richContentFromElement(cleaned);
      const content = rich.content || cleanText(cleaned?.innerText || cleaned?.textContent || '');
      if (!content && !rich.contentParts?.some(part => part?.type === 'emoji')) continue;

      entries.push({
        timestamp,
        localTimestamp: formatLocalTimestamp(timestamp),
        content,
        contentParts: rich.contentParts || []
      });
    }

    return entries;
  }

  function mergeEditHistory(...lists) {
    const result = [];
    const seen = new Set();
    for (const list of lists) {
      for (const edit of list || []) {
        if (!edit) continue;
        const timestamp = String(edit.timestamp || '');
        const content = String(edit.content || '');
        const partsKey = JSON.stringify(edit.contentParts || []);
        const key = `${timestamp}\u0000${content}\u0000${partsKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          timestamp,
          localTimestamp: edit.localTimestamp || formatLocalTimestamp(timestamp),
          content,
          contentParts: edit.contentParts || []
        });
      }
    }

    // Vencord stores revisions chronologically. Preserve that order when timestamp
    // metadata is available, while keeping DOM order stable for entries without it.
    return result
      .map((edit, index) => ({ edit, index, time: edit.timestamp ? Date.parse(edit.timestamp) : NaN }))
      .sort((a, b) => Number.isFinite(a.time) && Number.isFinite(b.time) ? a.time - b.time : a.index - b.index)
      .map(item => item.edit);
  }

  function editedMessageState(node) {
    if (!node) return { edited: false, editedSource: '', editHistory: [] };

    const editHistory = parseVencordEditHistory(node);
    const hasVencordMarker = Boolean(
      editHistory.length ||
      node.querySelector?.('.messagelogger-edit-marker') ||
      node.classList?.contains('messagelogger-edit-marker')
    );

    return {
      edited: hasVencordMarker,
      editedSource: hasVencordMarker ? 'vencord-message-logger' : '',
      editHistory
    };
  }

  function parseMessage(node) {
    const id = messageIdFromNode(node);
    if (!id) return null;

    const { deleted, deletedSource } = deletedMessageState(node);
    const { edited, editedSource, editHistory } = editedMessageState(node);

    const timeEl = node.querySelector('time[datetime]');
    const timestamp = timeEl?.getAttribute('datetime') || '';
    const localTimestamp = formatLocalTimestamp(timestamp);

    const authorEl = authorElementFromNode(node);
    const author = cleanText(authorEl?.textContent) || firstText(node, [
      'h3 [class*="username"]',
      '[class*="headerText"] [class*="username"]',
      '[class*="username"]'
    ]);
    const avatar = collectAvatar(node);
    const authorKey = authorIdentityFromNode(node, author, avatar);
    const groupStart = Boolean(avatar || node.querySelector('h3'));

    const directContent = node.querySelector(`[id="message-content-${id}"]`) ||
      node.querySelector('[id^="message-content-"], [class*="messageContent"]');
    const rich = richContentFromElement(directContent);
    let content = rich.content;
    if (!content) content = cleanText(directContent?.innerText || directContent?.textContent || '');

    const attachments = [...new Set(
      [...node.querySelectorAll('a[href], video, video source, source[src]')]
        .flatMap(el => elementMediaUrls(el))
        .map(safeUrl)
        .filter(Boolean)
        .filter(isDiscordAttachmentUrl)
    )];

    const embeds = [...node.querySelectorAll('[class*="embed"] a[href]')]
      .map(a => safeUrl(a.href))
      .filter(Boolean);

    const reactions = [...node.querySelectorAll('[class*="reaction"]')]
      .map(el => cleanText(el.getAttribute('aria-label') || el.textContent))
      .filter(Boolean);

    const reply = firstText(node, ['[class*="repliedMessage"]', '[class*="reply"]']);

    const stickers = collectStickers(node);
    const stickerUrlKeys = new Set(
      (stickers || [])
        .map(asset => safeAssetUrl(asset?.url || ''))
        .filter(url => url && !isInlineImageDataUrl(url))
        .map(canonicalImageKey)
    );

    // Collect ordinary message images after sticker detection, then remove any
    // URL that is also known to represent a sticker. This prevents one Discord
    // visual from being rendered once in the image gallery and again as a sticker.
    const images = collectImages(node, attachments)
      .filter(url => !stickerUrlKeys.has(canonicalImageKey(url)));

    const inlineEmojiAssets = (rich.contentParts || [])
      .filter(part => part?.type === 'emoji' && part?.url)
      .map(part => ({ url: part.url, name: part.alt || ':emoji:', alt: part.alt || ':emoji:' }));
    const emojis = mergeAssetLists(
      collectEmojis(directContent || node),
      inlineEmojiAssets
    );
    const reactionEmojis = collectReactionEmojis(node);

    return {
      id,
      channelId: channelIdFromNode(node),
      timestamp,
      localTimestamp,
      author,
      authorKey,
      avatar,
      groupStart,
      deleted,
      deletedSource,
      edited,
      editedSource,
      editHistory,
      content,
      contentParts: rich.contentParts,
      reply,
      attachments: [...new Set(attachments)],
      embeds: [...new Set(embeds)],
      images,
      emojis,
      stickers,
      reactionEmojis,
      reactions: [...new Set(reactions)],
      isThreadMessage: false,
      threadId: '',
      threadName: '',
      threadParentMessageId: '',
      threadSourceUrl: ''
    };
  }

  function findScroller(nodes) {
    let el = nodes[0];
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      const scrollable = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 40;
      if (scrollable) return el;
      el = el.parentElement;
    }

    const candidates = [...document.querySelectorAll('main div, [role="main"] div')]
      .filter(el => el.scrollHeight > el.clientHeight * 1.5)
      .filter(el => /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    return candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
  }

  function activeConversationChannelId() {
    const parts = location.pathname.split('/').filter(Boolean);
    const candidate = parts[parts.length - 1] || '';
    return /^\d{15,22}$/.test(candidate) ? candidate : '';
  }

  function threadIdFromHref(raw, mainChannelId = '') {
    try {
      const url = new URL(String(raw || ''), location.href);
      if (url.hostname !== 'discord.com' || !url.pathname.startsWith('/channels/')) return '';
      const parts = url.pathname.split('/').filter(Boolean);
      const channelParts = parts[0] === 'channels' ? parts.slice(2) : [];
      const ids = channelParts.filter(part => /^\d{15,22}$/.test(part));
      for (let i = ids.length - 1; i >= 0; i--) {
        if (ids[i] !== String(mainChannelId || '')) return ids[i];
      }
    } catch (_) {}
    return '';
  }

  function threadLabelFromElement(el) {
    const values = [
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      el?.textContent
    ].map(cleanText).filter(Boolean);
    const raw = values.find(value => !/^(?:view|open)\s+thread$/i.test(value)) || values[0] || 'Discord thread';
    return raw.replace(/\s+/g, ' ').slice(0, 120) || 'Discord thread';
  }

  function threadCandidatesFromNodes(nodes, mainChannelId, attemptedKeys) {
    const result = [];
    const seen = new Set();
    for (const node of nodes || []) {
      const parentMessageId = messageIdFromNode(node) || '';
      const elements = [...node.querySelectorAll('a[href],button,[role="button"]')];
      for (const el of elements) {
        if (!isVisibleElement(el)) continue;
        const href = el.getAttribute?.('href') || '';
        const threadId = threadIdFromHref(href, mainChannelId);
        const marker = `${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.textContent || ''}`.toLowerCase();
        const threadish = /\bthread\b|\breplies\b|\b\d+\s+repl(?:y|ies)\b|\bview\s+replies\b|\bopen\s+thread\b/.test(marker);
        if (!threadish) continue;
        // Avoid the ordinary per-message Reply action; only plural replies/thread
        // controls qualify when Discord does not expose a thread URL.
        if (!threadId && !/\bthread\b|\breplies\b|\b\d+\s+repl(?:y|ies)\b/.test(marker)) continue;
        const key = threadId ? `thread:${threadId}` : `parent:${parentMessageId}:${threadLabelFromElement(el).toLowerCase()}`;
        if (attemptedKeys?.has(key) || seen.has(key)) continue;
        seen.add(key);
        result.push({ key, threadId, parentMessageId, name: threadLabelFromElement(el), href: safeUrl(href), element: el });
      }
    }
    return result;
  }

  async function waitForThreadNodes(mainChannelId, preferredThreadId, timeoutMs) {
    const deadline = Date.now() + Math.max(1200, timeoutMs || 3500);
    while (Date.now() < deadline && !stopRequested) {
      const all = visibleMessageNodes();
      let nodes = preferredThreadId ? all.filter(node => channelIdFromNode(node) === preferredThreadId) : [];
      if (!nodes.length) nodes = all.filter(node => {
        const id = channelIdFromNode(node);
        return id && id !== mainChannelId;
      });
      if (nodes.length) {
        const threadId = channelIdFromNode(nodes[0]) || preferredThreadId || '';
        nodes = nodes.filter(node => channelIdFromNode(node) === threadId);
        return { threadId, nodes };
      }
      await sleep(120);
    }
    return { threadId: preferredThreadId || '', nodes: [] };
  }

  function threadPanelRootFromScroller(scroller, mainChannelId) {
    if (!scroller) return null;
    let current = scroller;
    let last = scroller;
    for (let hops = 0; current && current !== document.body && hops < 10; hops++) {
      const containsMain = visibleMessageNodes(mainChannelId).some(node => current.contains(node));
      if (containsMain && current !== scroller) break;
      last = current;
      current = current.parentElement;
    }
    return last;
  }

  function threadNameFromPanel(threadScroller, mainChannelId, fallback = '') {
    const root = threadPanelRootFromScroller(threadScroller, mainChannelId);
    if (!root) return fallback || 'Discord thread';
    const candidates = [];
    const selectors = ['h1', 'h2', 'h3', '[class*="threadName" i]', '[class*="title" i]'];
    for (const selector of selectors) {
      for (const el of root.querySelectorAll(selector)) {
        if (!isVisibleElement(el)) continue;
        const text = cleanText(el.textContent).replace(/^#\s*/, '');
        if (!text || text.length > 120) continue;
        if (/^(?:thread|threads|replies|members)$/i.test(text)) continue;
        candidates.push(text);
      }
    }
    return candidates[0] || fallback || 'Discord thread';
  }

  async function closeThreadPanel(threadScroller, mainChannelId, originalUrl, delayMs) {
    if (location.href !== originalUrl) {
      history.back();
      const deadline = Date.now() + Math.max(1800, delayMs * 4);
      while (Date.now() < deadline) {
        if (location.href === originalUrl && visibleMessageNodes(mainChannelId).length) return true;
        await sleep(100);
      }
    }

    const root = threadPanelRootFromScroller(threadScroller, mainChannelId);
    const buttons = [...(root?.querySelectorAll?.('button,[role="button"]') || [])]
      .filter(isVisibleElement)
      .filter(el => /\bclose\b/i.test(`${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''}`));
    if (buttons.length) {
      buttons[0].click();
      await sleep(Math.min(500, Math.max(150, delayMs / 2)));
      return true;
    }

    // Some Discord builds close the thread side panel with Escape.
    const target = document.activeElement || document.body;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    }
    await sleep(180);
    return false;
  }

  function tagThreadMessages(threadMap, meta) {
    for (const [id, message] of threadMap.entries()) {
      threadMap.set(id, {
        ...message,
        isThreadMessage: true,
        threadId: String(meta.threadId || message.channelId || ''),
        threadName: String(meta.name || 'Discord thread'),
        threadParentMessageId: String(meta.parentMessageId || ''),
        threadSourceUrl: String(meta.href || '')
      });
    }
  }

  async function scanOneVisibleThread(candidate, mainChannelId, threadMessages, avatarCache, avatarAttempts, options, completedThreadIds) {
    const { delayMs = 900, stagnantLimit = 8 } = options || {};
    const originalUrl = location.href;
    if (!candidate?.element?.isConnected || !isVisibleElement(candidate.element)) return { opened: false, count: 0 };

    try {
      candidate.element.click();
    } catch (_) {
      return { opened: false, count: 0 };
    }

    const opened = await waitForThreadNodes(mainChannelId, candidate.threadId, Math.max(2500, delayMs * 4));
    if (!opened.nodes.length || !opened.threadId || opened.threadId === mainChannelId) {
      if (location.href !== originalUrl) await closeThreadPanel(null, mainChannelId, originalUrl, delayMs);
      return { opened: false, count: 0 };
    }

    const threadId = opened.threadId;
    let threadNodes = opened.nodes;
    let threadScroller = findScroller(threadNodes);
    if (!threadScroller) {
      await closeThreadPanel(null, mainChannelId, originalUrl, delayMs);
      return { opened: false, count: 0 };
    }

    const threadMap = new Map();
    const threadAvatarCache = new Map(avatarCache || []);
    const threadAvatarAttempts = new Map();
    const meta = {
      ...candidate,
      threadId,
      name: threadNameFromPanel(threadScroller, mainChannelId, candidate.name || `Thread ${threadId}`),
      href: candidate.href || `https://discord.com/channels/${location.pathname.split('/').filter(Boolean)[1] || '@me'}/${threadId}`
    };

    sendProgress(`Scanning thread…\n${meta.name}`);
    threadScroller.scrollTop = threadScroller.scrollHeight;
    await sleep(delayMs);
    threadNodes = visibleMessageNodes(threadId);
    scanInto(threadMap, threadAvatarCache, threadNodes);
    tagThreadMessages(threadMap, meta);
    await augmentVisibleStickerSnapshots(threadMap);
    await hydrateVisibleAvatars(threadMap, threadAvatarCache, threadAvatarAttempts, 4);

    let stagnant = 0;
    let lastOldest = null;
    let pass = 0;
    let reachedBeginning = false;
    const threadIdleLimit = Math.max(3, Math.min(stagnantLimit, 10));

    while (stagnant < threadIdleLimit && !stopRequested) {
      pass++;
      threadNodes = visibleMessageNodes(threadId);
      scanInto(threadMap, threadAvatarCache, threadNodes);
      tagThreadMessages(threadMap, meta);

      const beforeTop = threadScroller.scrollTop;
      const step = Math.max(400, Math.floor(threadScroller.clientHeight * 0.82));
      threadScroller.scrollTop = Math.max(0, beforeTop - step);
      await sleep(delayMs);

      threadNodes = visibleMessageNodes(threadId);
      const added = scanInto(threadMap, threadAvatarCache, threadNodes);
      tagThreadMessages(threadMap, meta);
      await augmentVisibleStickerSnapshots(threadMap);
      await hydrateVisibleAvatars(threadMap, threadAvatarCache, threadAvatarAttempts, 3);

      const ordered = [...threadMap.values()].sort(compareSnowflakes);
      const oldest = ordered[0]?.id || null;
      if (added === 0 && oldest === lastOldest) stagnant++;
      else stagnant = 0;
      lastOldest = oldest;

      sendProgress(`Scanning thread…\n${meta.name}\n${threadMap.size} replies captured\npass ${pass}, idle ${stagnant}/${threadIdleLimit}`);

      if (threadScroller.scrollTop <= 1) {
        await sleep(delayMs);
        const topNodes = visibleMessageNodes(threadId);
        const topAdded = scanInto(threadMap, threadAvatarCache, topNodes);
        tagThreadMessages(threadMap, meta);
        if (topAdded > 0) stagnant = 0;
        // Thread panes do not always show Discord's normal "beginning" text; two
        // stable top passes are enough once scrollTop is pinned at zero.
        if (topAdded === 0 && stagnant >= 2) {
          reachedBeginning = true;
          break;
        }
      }
      if (pass > 50000) break;
    }

    for (const message of threadMap.values()) {
      if (message.id === candidate.parentMessageId) continue;
      const key = `${threadId}:${message.id}`;
      const old = threadMessages.get(key);
      threadMessages.set(key, old ? { ...old, ...message } : message);
    }
    if (reachedBeginning) completedThreadIds?.add(threadId);

    await closeThreadPanel(threadScroller, mainChannelId, originalUrl, delayMs);
    return { opened: true, count: threadMap.size, threadId, reachedBeginning };
  }

  async function scanVisibleThreads(mainChannelId, mainNodes, threadMessages, attemptedKeys, avatarCache, avatarAttempts, options, completedThreadIds) {
    const candidates = threadCandidatesFromNodes(mainNodes, mainChannelId, attemptedKeys);
    let opened = 0;
    for (const candidate of candidates) {
      if (stopRequested) break;
      attemptedKeys.add(candidate.key);
      const result = await scanOneVisibleThread(candidate, mainChannelId, threadMessages, avatarCache, avatarAttempts, options, completedThreadIds);
      if (result.opened) opened++;
    }
    return opened;
  }

  function oldestVisibleMessageId(nodes) {
    const ids = (nodes || []).map(messageIdFromNode).filter(Boolean);
    if (!ids.length) return '';
    return ids.reduce((oldest, id) => {
      try { return BigInt(id) < BigInt(oldest) ? id : oldest; }
      catch (_) { return String(id) < String(oldest) ? id : oldest; }
    });
  }

  async function scanThreadsSecondPass(mainChannelId, mainScroller, threadMessages, attemptedKeys, avatarCache, avatarAttempts, options, completedThreadIds) {
    const { delayMs = 900, stagnantLimit = 8, stopAtMessageId = '' } = options || {};
    let scroller = mainScroller;
    if (!scroller) return { reachedBeginning: false, scroller: null };

    phase = 'threads';
    sendProgress(`Main channel scan complete.\nStarting thread-only second pass…\n${threadMessages.size} thread replies captured`);

    scroller.scrollTop = scroller.scrollHeight;
    await sleep(delayMs);

    let pass = 0;
    let stagnant = 0;
    let lastOldest = '';
    let reachedBeginning = false;

    while (stagnant < stagnantLimit && !stopRequested) {
      pass++;
      let nodes = visibleMessageNodes(mainChannelId);
      if (!nodes.length) {
        await sleep(delayMs);
        nodes = visibleMessageNodes(mainChannelId);
      }
      if (!nodes.length) break;

      const openedHere = await scanVisibleThreads(
        mainChannelId,
        nodes,
        threadMessages,
        attemptedKeys,
        avatarCache,
        avatarAttempts,
        { delayMs, stagnantLimit },
        completedThreadIds
      );

      nodes = visibleMessageNodes(mainChannelId);
      scroller = findScroller(nodes) || scroller;
      if (stopRequested) break;

      const beforeTop = scroller.scrollTop;
      const step = Math.max(500, Math.floor(scroller.clientHeight * 0.82));
      scroller.scrollTop = Math.max(0, beforeTop - step);
      await sleep(delayMs);

      nodes = visibleMessageNodes(mainChannelId);
      const openedAfter = await scanVisibleThreads(
        mainChannelId,
        nodes,
        threadMessages,
        attemptedKeys,
        avatarCache,
        avatarAttempts,
        { delayMs, stagnantLimit },
        completedThreadIds
      );

      nodes = visibleMessageNodes(mainChannelId);
      scroller = findScroller(nodes) || scroller;
      const oldest = oldestVisibleMessageId(nodes);
      const moved = scroller.scrollTop < beforeTop - 1 || (oldest && oldest !== lastOldest);
      if (!moved && openedHere + openedAfter === 0) stagnant++;
      else stagnant = 0;
      if (oldest) lastOldest = oldest;

      sendProgress(`Scanning threads (second pass)…\n${attemptedKeys.size} thread entr${attemptedKeys.size === 1 ? 'y' : 'ies'} checked\n${threadMessages.size} thread replies captured\npass ${pass}, idle ${stagnant}/${stagnantLimit}`);

      let reachedMainCoverageStart = false;
      if (stopAtMessageId && oldest) {
        try { reachedMainCoverageStart = BigInt(oldest) <= BigInt(stopAtMessageId); }
        catch (_) { reachedMainCoverageStart = String(oldest) <= String(stopAtMessageId); }
      }
      if (reachedMainCoverageStart && scroller.scrollTop > 1) break;

      if (scroller.scrollTop <= 1) {
        await sleep(delayMs);
        nodes = visibleMessageNodes(mainChannelId);
        await scanVisibleThreads(
          mainChannelId,
          nodes,
          threadMessages,
          attemptedKeys,
          avatarCache,
          avatarAttempts,
          { delayMs, stagnantLimit },
          completedThreadIds
        );
        reachedBeginning = true;
        break;
      }

      if (pass > 200000) throw new Error('Stopped after too many thread scan passes.');
    }

    return { reachedBeginning, scroller };
  }

  function isVisibleElement(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }

  function profileTriggerFromNode(node) {
    const authorEl = authorElementFromNode(node);
    if (!authorEl) return null;
    return authorEl.closest('button,[role="button"]') || authorEl;
  }

  function likelyProfileRoots(messageNode) {
    const selectors = [
      '[role="dialog"]',
      '[class*="userProfile" i]',
      '[class*="user-profile" i]',
      '[class*="profile" i]',
      '[class*="popout" i]'
    ];
    const roots = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el) || !isVisibleElement(el) || messageNode?.contains(el)) continue;
        seen.add(el);
        roots.push(el);
      }
    }
    return roots;
  }

  function isProfileAvatarAssetUrl(raw) {
    // Only accept explicit Discord avatar endpoints or our own rendered snapshot
    // here. Bundled Discord /assets/ images are intentionally *not* accepted by
    // URL alone because profile banners and decorations can live there too; if a
    // default avatar is rendered from such an internal asset, snapshotProfileAvatar
    // captures the verified avatar element visually instead.
    return isInlineImageDataUrl(raw) || isDiscordAvatarUrl(raw);
  }

  function avatarUrlsFromElement(el) {
    const urls = [];
    if (!el) return urls;
    if (el.tagName === 'IMG') {
      urls.push(el.currentSrc, el.src, el.getAttribute('src'));
      const srcset = el.getAttribute('srcset') || '';
      for (const item of srcset.split(',')) urls.push(item.trim().split(/\s+/)[0]);
    }
    try {
      const style = getComputedStyle(el);
      urls.push(...cssImageUrls(style.backgroundImage || ''));
    } catch (_) {}
    urls.push(...cssImageUrls(el.getAttribute?.('style') || ''));
    return [...new Set(urls.map(raw => safeAssetUrl(raw || '')).filter(url => url && isProfileAvatarAssetUrl(url)))];
  }

  function normalizedAuthorText(value) {
    return cleanText(value).replace(/^@/, '').toLocaleLowerCase();
  }

  function profileNameTexts(root) {
    if (!root) return [];
    const selectors = [
      '[class*="nickname" i]',
      '[class*="username" i]',
      '[class*="displayName" i]',
      '[class*="userTag" i]',
      'h1', 'h2', 'h3'
    ];
    const values = [];
    for (const selector of selectors) {
      for (const el of root.querySelectorAll(selector)) {
        const text = cleanText(el.textContent);
        if (text && text.length <= 96) values.push(text);
      }
    }
    return [...new Set(values)];
  }

  function profileRootAuthorMatch(root, author) {
    const target = normalizedAuthorText(author);
    if (!target) return false;
    for (const raw of profileNameTexts(root)) {
      const value = normalizedAuthorText(raw);
      if (value === target || value.startsWith(`${target}#`)) return true;
    }
    return false;
  }

  function profileRootDistance(root, trigger) {
    try {
      const a = root.getBoundingClientRect();
      const b = trigger.getBoundingClientRect();
      const ax = a.left + a.width / 2;
      const ay = a.top + a.height / 2;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      return Math.hypot(ax - bx, ay - by);
    } catch (_) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function chooseOpenedProfileRoot(messageNode, trigger, beforeRoots, author) {
    const roots = likelyProfileRoots(messageNode);
    const ranked = roots.map(root => {
      const isNew = !beforeRoots.has(root);
      const authorMatch = profileRootAuthorMatch(root, author);
      const names = profileNameTexts(root);
      const distance = profileRootDistance(root, trigger);
      let score = 0;
      if (isNew) score += 220;
      if (authorMatch) score += 180;
      if (names.length && !authorMatch) score -= 90;
      if (Number.isFinite(distance)) score += Math.max(0, 70 - distance / 12);
      if (root.getAttribute?.('role') === 'dialog') score += 25;
      return { root, score, isNew, authorMatch };
    }).sort((a, b) => b.score - a.score);

    const winner = ranked[0];
    if (!winner) return null;
    // Never use an arbitrary pre-existing profile panel for somebody else. This
    // is what caused one person's PFP to be assigned to another in Compact mode.
    if (!winner.isNew && !winner.authorMatch) return null;
    if (winner.score < 80) return null;
    return winner.root;
  }

  function profileAvatarCandidates(root, trigger) {
    if (!root) return [];
    const candidateElements = new Set([root]);
    for (const el of root.querySelectorAll('img,[class*="avatar" i],[style*="background"]')) candidateElements.add(el);

    const byUrl = new Map();
    for (const el of candidateElements) {
      if (!isVisibleElement(el)) continue;
      for (const url of avatarUrlsFromElement(el)) {
        let score = 0;
        const path = new URL(url).pathname;
        if (/\/embed\/avatars\/\d+\.(?:png|webp|jpe?g)/i.test(path)) score += 60;
        if (/\/(?:avatars|users\/\d+\/avatars|guilds\/\d+\/users\/\d+\/avatars)\//i.test(path)) score += 55;

        const rect = el.getBoundingClientRect();
        if (rect.width >= 72 || rect.height >= 72 || (el.naturalWidth || 0) >= 96) score += 45;
        else if (rect.width >= 36 || rect.height >= 36) score += 20;

        const marker = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute?.('aria-label') || ''}`.toLowerCase();
        if (/avatar/.test(marker)) score += 70;
        if (/banner/.test(marker)) score -= 100;

        if (trigger) {
          const distance = profileRootDistance(el, trigger);
          if (Number.isFinite(distance)) score += Math.max(0, 20 - distance / 40);
        }

        const current = byUrl.get(url);
        if (!current || score > current.score) byUrl.set(url, { url, score });
      }
    }
    return [...byUrl.values()].sort((a, b) => b.score - a.score);
  }


  function profileAvatarVisualCandidates(root) {
    if (!root) return [];
    const candidates = new Set();
    const selectors = [
      '[class*="avatar" i]',
      '[aria-label*="avatar" i]',
      'img[alt*="avatar" i]',
      'svg[class*="avatar" i]',
      'canvas[class*="avatar" i]'
    ];
    for (const selector of selectors) {
      for (const el of root.querySelectorAll(selector)) candidates.add(el);
    }

    // If Discord uses an unhelpful generated class, an image already recognized
    // as an avatar asset is still a strong candidate inside this verified popout.
    for (const img of root.querySelectorAll('img')) {
      if (avatarUrlsFromElement(img).length) candidates.add(img);
    }

    return [...candidates].filter(isVisibleElement).map(el => {
      const rect = el.getBoundingClientRect();
      const marker = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('alt') || ''}`.toLowerCase();
      let score = 0;
      if (/avatar/.test(marker)) score += 180;
      if (/banner|decoration|badge|status/.test(marker)) score -= 160;
      if (rect.width >= 48 && rect.height >= 48) score += 70;
      if (rect.width >= 72 && rect.height >= 72) score += 35;
      const ratio = rect.width / Math.max(1, rect.height);
      if (ratio >= 0.75 && ratio <= 1.33) score += 55;
      if (rect.width > 220 || rect.height > 220) score -= 100;
      // Prefer the containing avatar wrapper to a tiny child SVG path, but avoid
      // very large containers that include the whole profile header.
      if (el.children?.length && rect.width <= 180 && rect.height <= 180) score += 20;
      return { el, rect, score };
    }).filter(item => item.rect.width >= 24 && item.rect.height >= 24)
      .sort((a, b) => b.score - a.score || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
  }

  async function snapshotProfileAvatar(root) {
    const target = profileAvatarVisualCandidates(root)[0];
    if (!target || target.score < 80) return '';
    try {
      // Capture exactly what Discord rendered. This is the crucial fallback for
      // default avatars that are painted by the client without a recoverable CDN
      // URL or user ID in the accessible DOM.
      const viewport = await captureVisiblePageDataUrl();
      if (!viewport) return '';
      return await cropViewportCapture(viewport, target.rect);
    } catch (err) {
      console.warn('[DHE] Could not snapshot profile avatar', err);
      return '';
    }
  }

  function userIdFromProfileRoot(root) {
    if (!root) return '';
    const elements = [root, ...root.querySelectorAll('*')];
    for (const el of elements) {
      const targeted = userIdFromElementAttributes(el);
      if (targeted) return targeted;

      if (el.tagName === 'IMG') {
        for (const url of avatarUrlsFromElement(el)) {
          const avatarId = avatarUserId(url);
          if (avatarId) return avatarId;
        }
      }

      // Profile-only fallback: inspect user/profile/member-related attribute
      // values and links. Restricting this to the verified popout prevents a
      // message/channel/sticker snowflake from being mistaken for the author ID.
      for (const attr of [...el.attributes || []]) {
        const name = String(attr.name || '').toLowerCase();
        const value = String(attr.value || '');
        if (/(user|profile|member|uid)/.test(name) || /(user|profile|member|uid)/i.test(value)) {
          const id = snowflakeFromValue(value);
          if (id) return id;
        }
        if ((name === 'href' || name === 'data-href') && /\/users?\//i.test(value)) {
          const id = snowflakeFromValue(value);
          if (id) return id;
        }
      }
    }
    return '';
  }

  function discriminatorFromProfileRoot(root) {
    if (!root) return '';
    const text = cleanText(root.innerText || root.textContent || '');
    const match = text.match(/#(\d{4})(?:\b|$)/);
    return match ? match[1] : '';
  }

  function defaultAvatarUrlForIdentity(userId, discriminator = '') {
    try {
      if (discriminator && /^\d{4}$/.test(discriminator) && discriminator !== '0000') {
        return `https://cdn.discordapp.com/embed/avatars/${Number(discriminator) % 5}.png`;
      }
      return defaultAvatarUrlForUserId(userId);
    } catch (_) {
      return '';
    }
  }

  async function avatarFromProfilePopout(node, expectedAuthor = '') {
    const trigger = profileTriggerFromNode(node);
    if (!trigger || !isVisibleElement(trigger)) return { avatar: '', userId: '', verified: false };

    // Close any stale profile card first. A previously open card can otherwise be
    // mistaken for the profile belonging to the author we're about to inspect.
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    } catch (_) {}
    await sleep(50);

    const beforeRoots = new Set(likelyProfileRoots(node));
    const knownUserId = authorUserIdFromNode(node, collectAvatar(node));
    try {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (_) {
      try { trigger.click(); } catch (_) {}
    }

    let root = null;
    for (const wait of [120, 180, 260, 360]) {
      await sleep(wait);
      root = chooseOpenedProfileRoot(node, trigger, beforeRoots, expectedAuthor);
      if (root) break;
    }

    let avatar = '';
    let userId = knownUserId;
    let verified = false;
    if (root) {
      const authorMatch = profileRootAuthorMatch(root, expectedAuthor);
      // A newly created root is strong evidence; matching the visible profile
      // name is even stronger. Do not take images from any other page region.
      verified = authorMatch || !beforeRoots.has(root);
      const candidates = profileAvatarCandidates(root, trigger);
      if (candidates[0]?.score >= 35) avatar = candidates[0].url;
      userId = userId || userIdFromProfileRoot(root);
      const discriminator = discriminatorFromProfileRoot(root);
      if (!avatar && userId) avatar = defaultAvatarUrlForIdentity(userId, discriminator);
      // Last resort: use the avatar rendered in this *verified* person's profile.
      // This handles current Discord builds where a default PFP is painted from
      // internal client assets and neither the user ID nor a public avatar URL is
      // present in the DOM. Never take this snapshot outside the verified root.
      if (!avatar) avatar = await snapshotProfileAvatar(root);
    }

    // Close the exact popout we just opened before continuing the scan.
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    } catch (_) {}
    await sleep(50);

    if (!verified) return { avatar: '', userId: '', verified: false };
    return { avatar, userId, verified: true };
  }

  function cacheMessageAvatar(message, avatarCache) {
    if (!message?.avatar) return;
    const key = message.authorKey || (message.author ? `name:${message.author}` : '');
    if (key) avatarCache.set(key, message.avatar);
  }

  function applyAvatarToMap(map, key, author, avatar) {
    if (!avatar) return;
    for (const message of map.values()) {
      const messageKey = message.authorKey || (message.author ? `name:${message.author}` : '');
      if ((key && messageKey === key) || (!key && author && message.author === author)) {
        if (!message.avatar) message.avatar = avatar;
      }
    }
  }

  async function hydrateVisibleAvatars(map, avatarCache, avatarAttempts, maxLookups = 4) {
    let lookups = 0;
    const seenThisPass = new Set();

    for (const node of visibleMessageNodes()) {
      if (stopRequested || lookups >= maxLookups) break;
      const id = messageIdFromNode(node);
      const message = id ? map.get(id) : null;
      if (!message?.author) continue;

      const key = message.authorKey || `name:${message.author}`;
      if (seenThisPass.has(key)) continue;
      seenThisPass.add(key);

      if (message.avatar) {
        avatarCache.set(key, message.avatar);
        continue;
      }
      if (avatarCache.has(key)) {
        applyAvatarToMap(map, key, message.author, avatarCache.get(key));
        continue;
      }

      const attempts = avatarAttempts.get(key) || 0;
      if (attempts >= 3) continue;
      avatarAttempts.set(key, attempts + 1);
      lookups++;

      const resolved = await avatarFromProfilePopout(node, message.author);
      if (!resolved?.verified) continue;

      const resolvedKey = resolved.userId ? `user:${resolved.userId}` : key;
      if (resolved.avatar) {
        avatarCache.set(resolvedKey, resolved.avatar);
        // Keep a name-key cache only when it refers to this exact display name and
        // no stronger user ID is available. This reduces accidental identity
        // merging for users who happen to share a display name.
        if (!resolved.userId) avatarCache.set(key, resolved.avatar);
      }

      for (const candidate of map.values()) {
        const candidateKey = candidate.authorKey || (candidate.author ? `name:${candidate.author}` : '');
        if (candidateKey !== key) continue;
        if (resolved.userId) candidate.authorKey = resolvedKey;
        if (!candidate.avatar && resolved.avatar) candidate.avatar = resolved.avatar;
      }
    }
  }

  function scanInto(map, avatarCache = new Map(), nodes = null) {
    let added = 0;
    for (const node of (nodes || visibleMessageNodes())) {
      const msg = parseMessage(node);
      if (msg) {
        const key = msg.authorKey || (msg.author ? `name:${msg.author}` : '');
        if (!msg.avatar && key && avatarCache.has(key)) msg.avatar = avatarCache.get(key);
        cacheMessageAvatar(msg, avatarCache);
      }

      if (msg && !map.has(msg.id)) {
        map.set(msg.id, msg);
        added++;
      } else if (msg && map.has(msg.id)) {
        const old = map.get(msg.id);
        map.set(msg.id, {
          ...old,
          ...msg,
          author: msg.author || old.author || '',
          authorKey: msg.authorKey || old.authorKey || '',
          avatar: msg.avatar || old.avatar || '',
          localTimestamp: msg.localTimestamp || old.localTimestamp || formatLocalTimestamp(msg.timestamp || old.timestamp),
          groupStart: Boolean(old.groupStart || msg.groupStart),
          deleted: Boolean(old.deleted || msg.deleted),
          deletedSource: msg.deletedSource || old.deletedSource || '',
          edited: Boolean(old.edited || msg.edited),
          editedSource: msg.editedSource || old.editedSource || '',
          editHistory: mergeEditHistory(old.editHistory, msg.editHistory),
          contentParts: msg.contentParts?.length ? msg.contentParts : (old.contentParts || []),
          attachments: [...new Set([...(old.attachments || []), ...(msg.attachments || [])])],
          embeds: [...new Set([...(old.embeds || []), ...(msg.embeds || [])])],
          images: [...new Set([...(old.images || []), ...(msg.images || [])])],
          emojis: mergeAssetLists(old.emojis, msg.emojis),
          stickers: mergeStickerLists(old.stickers, msg.stickers),
          reactionEmojis: mergeAssetLists(old.reactionEmojis, msg.reactionEmojis),
          reactions: [...new Set([...(old.reactions || []), ...(msg.reactions || [])])],
          isThreadMessage: Boolean(old.isThreadMessage || msg.isThreadMessage),
          threadId: msg.threadId || old.threadId || '',
          threadName: msg.threadName || old.threadName || '',
          threadParentMessageId: msg.threadParentMessageId || old.threadParentMessageId || '',
          threadSourceUrl: msg.threadSourceUrl || old.threadSourceUrl || ''
        });
      }
    }
    return added;
  }

  function compareSnowflakes(a, b) {
    try {
      const aa = BigInt(a.id);
      const bb = BigInt(b.id);
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    } catch (_) {
      return (a.timestamp || '').localeCompare(b.timestamp || '');
    }
  }

  function normalizeMessageIdentity(messages) {
    const normalized = messages.map(message => ({ ...message }));
    let currentAuthor = '';
    let currentAuthorKey = '';
    let currentAvatar = '';

    for (const message of normalized) {
      if (!message.localTimestamp && message.timestamp) message.localTimestamp = formatLocalTimestamp(message.timestamp);

      const explicitAuthor = message.author || '';
      const explicitKey = message.authorKey || '';
      const sameAuthor = Boolean(
        (explicitKey && currentAuthorKey && explicitKey === currentAuthorKey) ||
        (!explicitKey && explicitAuthor && currentAuthor && explicitAuthor === currentAuthor)
      );

      if (message.groupStart) {
        currentAuthor = explicitAuthor;
        currentAuthorKey = explicitKey;
        currentAvatar = message.avatar || '';
      } else {
        // Continuation rows may omit author information in Cozy mode. Inherit only
        // when it is genuinely absent. If Discord explicitly shows a different
        // author (common in Compact mode), never carry the previous person's avatar
        // onto that message. That was the source of default-PFP mixups.
        if (!message.author && currentAuthor) message.author = currentAuthor;
        if (!message.authorKey && !explicitAuthor && currentAuthorKey) message.authorKey = currentAuthorKey;

        const resolvedSameAuthor = sameAuthor || (!explicitAuthor && !explicitKey);
        if (!message.avatar && currentAvatar && resolvedSameAuthor) message.avatar = currentAvatar;

        const authorChanged = Boolean(
          (explicitKey && currentAuthorKey && explicitKey !== currentAuthorKey) ||
          (!explicitKey && explicitAuthor && currentAuthor && explicitAuthor !== currentAuthor)
        );
        if (authorChanged && !message.avatar) currentAvatar = '';

        if (message.author) currentAuthor = message.author;
        if (message.authorKey) currentAuthorKey = message.authorKey;
        if (message.avatar) currentAvatar = message.avatar;
      }
    }

    // Reuse an avatar only for the same author identity. Default Discord avatars
    // are valid avatar URLs too, so once recovered they are cached exactly like a
    // custom PFP and cannot leak across authors.
    const avatarByAuthor = new Map();
    for (const message of normalized) {
      const key = message.authorKey || (message.author ? `name:${message.author}` : '');
      if (key && message.avatar) avatarByAuthor.set(key, message.avatar);
    }
    for (const message of normalized) {
      const key = message.authorKey || (message.author ? `name:${message.author}` : '');
      if (!message.avatar && key && avatarByAuthor.has(key)) message.avatar = avatarByAuthor.get(key);
    }

    // Recompute visual groups from author changes and time gaps instead of trusting
    // Discord's Cozy/Compact DOM differences. This makes the export layout stable
    // regardless of the user's current chat appearance.
    let previous = null;
    for (const message of normalized) {
      const previousTime = previous?.timestamp ? Date.parse(previous.timestamp) : NaN;
      const currentTime = message.timestamp ? Date.parse(message.timestamp) : NaN;
      const longGap = Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime - previousTime > 7 * 60 * 1000;
      message.groupStart = !previous || message.author !== previous.author || longGap;
      previous = message;
    }

    return normalized;
  }

  function groupMessagesForHtml(messages) {
    const groups = [];
    let group = null;

    for (const message of messages) {
      const previous = group?.messages[group.messages.length - 1];
      const previousTime = previous?.timestamp ? Date.parse(previous.timestamp) : NaN;
      const currentTime = message.timestamp ? Date.parse(message.timestamp) : NaN;
      const longGap = Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime - previousTime > 7 * 60 * 1000;
      const startsNew = !group || message.author !== group.author || longGap;

      if (startsNew) {
        group = {
          author: message.author || 'Unknown',
          avatar: message.avatar || '',
          messages: []
        };
        groups.push(group);
      } else if (!group.avatar && message.avatar) {
        group.avatar = message.avatar;
      }

      group.messages.push(message);
    }

    return groups;
  }

  function conversationName() {
    const title = cleanText(document.querySelector('h1')?.textContent || '');
    if (title) return title;
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ? `discord-${parts[parts.length - 1]}` : 'discord-chat';
  }

  function safeFileName(name) {
    return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'discord-chat';
  }

  function timestampForFilename() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '').replace('T', '-').replace('Z', '');
  }

  function normalizeDiscordConversationSource(raw) {
    try {
      const url = new URL(String(raw || ''), location.href);
      if (url.hostname !== 'discord.com' || !url.pathname.startsWith('/channels/')) return '';
      return url.pathname.replace(/\/+$/, '');
    } catch (_) {
      return '';
    }
  }

  function snowflakeBigInt(value) {
    try {
      const text = String(value || '');
      return /^\d{15,}$/.test(text) ? BigInt(text) : null;
    } catch (_) {
      return null;
    }
  }

  function cloneComparisonMessage(message) {
    return {
      ...message,
      id: String(message?.id || ''),
      channelId: String(message?.channelId || ''),
      timestamp: String(message?.timestamp || ''),
      localTimestamp: message?.localTimestamp || formatLocalTimestamp(message?.timestamp || ''),
      author: String(message?.author || ''),
      authorKey: String(message?.authorKey || ''),
      avatar: String(message?.avatar || ''),
      groupStart: Boolean(message?.groupStart),
      deleted: Boolean(message?.deleted),
      deletedSource: String(message?.deletedSource || ''),
      edited: Boolean(message?.edited),
      editedSource: String(message?.editedSource || ''),
      editHistory: Array.isArray(message?.editHistory) ? message.editHistory : [],
      content: String(message?.content || ''),
      contentParts: Array.isArray(message?.contentParts) ? message.contentParts : [],
      reply: String(message?.reply || ''),
      attachments: Array.isArray(message?.attachments) ? message.attachments : [],
      embeds: Array.isArray(message?.embeds) ? message.embeds : [],
      images: Array.isArray(message?.images) ? message.images : [],
      emojis: Array.isArray(message?.emojis) ? message.emojis : [],
      stickers: Array.isArray(message?.stickers) ? message.stickers : [],
      reactionEmojis: Array.isArray(message?.reactionEmojis) ? message.reactionEmojis : [],
      reactions: Array.isArray(message?.reactions) ? message.reactions : [],
      deletedBetweenExports: Boolean(message?.deletedBetweenExports),
      deletedBetweenExportsSource: String(message?.deletedBetweenExportsSource || ''),
      deletedBetweenExportsNote: String(message?.deletedBetweenExportsNote || ''),
      comparisonStatus: String(message?.comparisonStatus || ''),
      previousExportedAt: String(message?.previousExportedAt || ''),
      comparisonDetectedAt: String(message?.comparisonDetectedAt || ''),
      isThreadMessage: Boolean(message?.isThreadMessage),
      threadId: String(message?.threadId || ''),
      threadName: String(message?.threadName || ''),
      threadParentMessageId: String(message?.threadParentMessageId || ''),
      threadSourceUrl: String(message?.threadSourceUrl || '')
    };
  }

  function validatePreviousSnapshot(snapshot, currentMessages) {
    if (!snapshot?.messages?.length) throw new Error('The selected previous export contains no usable Discord messages.');

    const previousSource = normalizeDiscordConversationSource(snapshot.meta?.source || '');
    const currentSource = normalizeDiscordConversationSource(location.href);
    let sourceVerified = false;
    if (previousSource && currentSource) {
      if (previousSource !== currentSource) {
        throw new Error('The selected previous export is from a different Discord channel or DM.');
      }
      sourceVerified = true;
    }

    const previousChannels = new Set(snapshot.messages.map(m => String(m?.channelId || '')).filter(Boolean));
    const currentChannels = new Set(currentMessages.map(m => String(m?.channelId || '')).filter(Boolean));
    let channelVerified = false;
    if (previousChannels.size && currentChannels.size) {
      const overlap = [...previousChannels].some(id => currentChannels.has(id));
      if (!overlap) throw new Error('The selected previous export has a different Discord channel ID from the current chat.');
      channelVerified = true;
    }

    if (!sourceVerified && !channelVerified) {
      const currentIds = new Set(currentMessages.map(m => String(m.id || '')));
      const overlapCount = snapshot.messages.reduce((count, m) => count + (currentIds.has(String(m?.id || '')) ? 1 : 0), 0);
      if (!overlapCount) {
        throw new Error('Could not verify that the selected previous export belongs to this Discord chat. Use an export from this same channel or DM.');
      }
    }
  }

  function comparisonDeletionNote(previousExportedAt, currentExportedAt) {
    const previousLocal = formatLocalTimestamp(previousExportedAt || '') || 'the previous pull';
    const currentLocal = formatLocalTimestamp(currentExportedAt || '') || 'the current pull';
    return `Deleted between ${previousLocal} and ${currentLocal}. This message was present in the previous export but was not found in the current pull.`;
  }

  function applyPreviousComparison(currentMessages, snapshot, scanInfo = {}) {
    if (!snapshot?.messages?.length) {
      return { messages: currentMessages, info: null };
    }

    validatePreviousSnapshot(snapshot, currentMessages);

    const currentIds = new Set(currentMessages.map(message => String(message.id || '')));
    const previousById = new Map();
    for (const raw of snapshot.messages) {
      const message = cloneComparisonMessage(raw);
      if (/^\d{15,}$/.test(message.id)) previousById.set(message.id, message);
    }

    let oldestCurrent = null;
    for (const message of currentMessages) {
      const id = snowflakeBigInt(message.id);
      if (id !== null && (oldestCurrent === null || id < oldestCurrent)) oldestCurrent = id;
    }

    const detectedAt = String(scanInfo.currentExportedAt || new Date().toISOString());
    const previousExportedAt = String(snapshot.meta?.exportedAt || '');
    const carried = [];
    const newlyMissing = [];
    let skippedOutsideCoverage = 0;

    const completedThreadIds = scanInfo.completedThreadIds instanceof Set ? scanInfo.completedThreadIds : new Set(scanInfo.completedThreadIds || []);

    for (const previous of previousById.values()) {
      if (currentIds.has(previous.id)) continue;

      // Never infer a deletion inside a thread unless this pull explicitly scanned
      // that same thread all the way to its beginning. This prevents false orange
      // deletions when Include threads is off or a thread could not be opened.
      if (previous.isThreadMessage && (!scanInfo.includeThreads || !completedThreadIds.has(String(previous.threadId || '')))) {
        skippedOutsideCoverage++;
        continue;
      }

      const id = snowflakeBigInt(previous.id);
      const inCoveredRange = Boolean(scanInfo.reachedBeginning) || (oldestCurrent !== null && id !== null && id >= oldestCurrent);
      if (!inCoveredRange) {
        skippedOutsideCoverage++;
        continue;
      }

      if (previous.deletedBetweenExports) {
        carried.push({
          ...previous,
          deletedBetweenExports: true,
          deletedBetweenExportsSource: previous.deletedBetweenExportsSource || 'previous-export-comparison',
          deletedBetweenExportsNote: comparisonDeletionNote(previous.previousExportedAt || previousExportedAt, previous.comparisonDetectedAt || detectedAt),
          comparisonStatus: 'carried-forward',
          previousExportedAt: previous.previousExportedAt || previousExportedAt,
          comparisonDetectedAt: previous.comparisonDetectedAt || detectedAt
        });
        continue;
      }

      // A message already marked red by Vencord in the previous pull was already
      // deleted before that pull, so it is not a new between-export deletion.
      if (previous.deleted) continue;

      newlyMissing.push({
        ...previous,
        deletedBetweenExports: true,
        deletedBetweenExportsSource: 'previous-export-comparison',
        deletedBetweenExportsNote: comparisonDeletionNote(previousExportedAt, detectedAt),
        comparisonStatus: 'new',
        previousExportedAt,
        comparisonDetectedAt: detectedAt
      });
    }

    const combined = normalizeMessageIdentity([...currentMessages, ...carried, ...newlyMissing].sort(compareSnowflakes));
    return {
      messages: combined,
      info: {
        enabled: true,
        previousFilename: String(snapshot.meta?.filename || 'previous export'),
        previousFormat: String(snapshot.meta?.format || ''),
        previousExportedAt,
        previousMessageCount: previousById.size,
        newlyMissing: newlyMissing.length,
        carriedMissing: carried.length,
        skippedOutsideCoverage,
        reachedBeginning: Boolean(scanInfo.reachedBeginning)
      }
    };
  }

  function csvCell(value) {
    let s;
    if (Array.isArray(value)) {
      s = value.map(item => typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item ?? '')).join(' | ');
    } else if (typeof value === 'object' && value !== null) {
      s = JSON.stringify(value);
    } else {
      s = String(value ?? '');
    }
    return `"${s.replace(/"/g, '""')}"`;
  }

  function toCsv(messages) {
    const columns = ['id', 'channelId', 'timestamp', 'localTimestamp', 'author', 'authorKey', 'avatar', 'groupStart', 'isThreadMessage', 'threadId', 'threadName', 'threadParentMessageId', 'threadSourceUrl', 'deleted', 'deletedSource', 'deletedBetweenExports', 'deletedBetweenExportsSource', 'deletedBetweenExportsNote', 'comparisonStatus', 'previousExportedAt', 'comparisonDetectedAt', 'edited', 'editedSource', 'editHistory', 'content', 'contentParts', 'reply', 'attachments', 'embeds', 'images', 'emojis', 'stickers', 'reactionEmojis', 'reactions'];
    const rows = [columns.map(csvCell).join(',')];
    for (const m of messages) rows.push(columns.map(k => csvCell(m[k])).join(','));
    return rows.join('\r\n');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  }

  function linkList(items) {
    if (!items?.length) return '';
    return `<ul>${items.map(url => `<li><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></li>`).join('')}</ul>`;
  }

  function canonicalImageKey(raw) {
    if (isInlineImageDataUrl(raw)) return String(raw);
    try {
      const u = new URL(raw);
      if (isDiscordMediaHost(u.hostname) &&
          /\/(attachments|external|stickers|avatars|emojis)\//.test(u.pathname)) {
        return u.pathname;
      }
      return u.href;
    } catch (_) {
      return raw;
    }
  }

  function extensionFromUrl(raw) {
    if (/^data:image\/svg\+xml;base64,/i.test(String(raw || ''))) return '.svg';
    if (/^data:image\/png;base64,/i.test(String(raw || ''))) return '.png';
    if (/^data:image\/(?:apng);base64,/i.test(String(raw || ''))) return '.apng';
    if (/^data:image\/gif;base64,/i.test(String(raw || ''))) return '.gif';
    if (/^data:image\/webp;base64,/i.test(String(raw || ''))) return '.webp';
    if (/^data:image\/jpeg;base64,/i.test(String(raw || ''))) return '.jpg';
    try {
      const pathname = new URL(raw).pathname;
      const m = pathname.match(/\.([a-z0-9]{1,12})$/i);
      return m ? `.${m[1].toLowerCase()}` : '.img';
    } catch (_) {
      return '.img';
    }
  }

  function originalNameFromUrl(raw) {
    if (isInlineImageDataUrl(raw)) return `rendered-sticker${extensionFromUrl(raw)}`;
    try {
      const last = decodeURIComponent(new URL(raw).pathname.split('/').pop() || 'image');
      return safeFileName(last).slice(0, 70) || `image${extensionFromUrl(raw)}`;
    } catch (_) {
      return `image${extensionFromUrl(raw)}`;
    }
  }

  function buildMediaIndex(messages) {
    const entries = [];
    const byKey = new Map();
    let sequence = 0;

    function allowedForKind(url, kind) {
      if (kind === 'avatar') return isDiscordAvatarUrl(url) || isInlineImageDataUrl(url) || isProfileAvatarAssetUrl(url);
      if (kind === 'emoji' || kind === 'reaction-emoji') {
        return isDiscordEmojiUrl(url) || isDiscordHostedImageLikeUrl(url);
      }
      if (kind === 'sticker') return isDiscordStickerUrl(url) || isInlineImageDataUrl(url) || isDiscordHostedImageLikeUrl(url);
      if (kind === 'video') return isVideoAttachmentUrl(url);
      if (kind === 'file') return isOtherAttachmentFileUrl(url);
      return isConversationImageUrl(url);
    }

    function add(rawUrl, message, kind) {
      const url = safeAssetUrl(rawUrl);
      if (!url || !allowedForKind(url, kind)) return;

      const key = canonicalImageKey(url);
      if (byKey.has(key)) return;

      sequence++;
      const original = originalNameFromUrl(url);
      const hasExt = /\.[a-z0-9]{1,12}$/i.test(original);
      const fallbackExt = kind === 'file' ? '.bin' : kind === 'video' ? '.video' : extensionFromUrl(url);
      const prefix = kind.replace(/[^a-z0-9-]+/gi, '-') || 'media';
      const filename = `${String(sequence).padStart(5, '0')}-${prefix}-${message.id}-${hasExt ? original : `${original}${fallbackExt}`}`;
      const entry = { key, url, filename, messageId: message.id, kind };
      entries.push(entry);
      byKey.set(key, entry);
    }

    for (const message of messages) {
      if (message.avatar) add(message.avatar, message, 'avatar');
      for (const rawUrl of message.images || []) add(rawUrl, message, 'image');
      for (const asset of message.emojis || []) add(asset.url, message, 'emoji');
      for (const asset of message.stickers || []) add(asset.url, message, 'sticker');
      for (const asset of message.reactionEmojis || []) add(asset.url, message, 'reaction-emoji');
      for (const rawUrl of message.attachments || []) {
        if (isVideoAttachmentUrl(rawUrl)) add(rawUrl, message, 'video');
        else if (isOtherAttachmentFileUrl(rawUrl)) add(rawUrl, message, 'file');
      }
      for (const edit of message.editHistory || []) {
        for (const part of edit.contentParts || []) {
          if (part?.type === 'emoji' && part?.url) add(part.url, message, 'emoji');
        }
      }
    }

    return { entries, byKey };
  }

  function imageGallery(images, resolveImage) {
    if (!images?.length) return '';
    const seen = new Set();
    const figures = [];

    for (const raw of images) {
      const key = canonicalImageKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = resolveImage ? resolveImage(raw) : raw;
      figures.push(`<figure><a href="${escapeHtml(raw)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(resolved)}" loading="lazy" alt="Discord image attachment"></a></figure>`);
    }

    return figures.length ? `<div class="gallery">${figures.join('')}</div>` : '';
  }

  function resolveAssetUrl(raw, resolver) {
    return resolver ? resolver(raw) : raw;
  }

  function renderContent(message, resolveImage) {
    const parts = message.contentParts || [];
    if (!parts.length) return escapeHtml(message.content).replace(/\n/g, '<br>');
    return parts.map(part => {
      if (part.type === 'emoji' && part.url) {
        const src = resolveAssetUrl(part.url, resolveImage);
        const alt = part.alt || ':emoji:';
        return `<img class="inline-emoji" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" title="${escapeHtml(alt)}">`;
      }
      return escapeHtml(part.text || '').replace(/\n/g, '<br>');
    }).join('');
  }

  function assetGallery(assets, resolveImage, className, fallbackAlt) {
    if (!assets?.length) return '';
    const seen = new Set();
    const figures = [];
    for (const asset of assets) {
      const raw = typeof asset === 'string' ? asset : asset?.url;
      if (!raw) continue;
      const key = canonicalImageKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const name = (typeof asset === 'object' && asset?.name) ? asset.name : fallbackAlt;
      const resolved = resolveAssetUrl(raw, resolveImage);
      if (isRenderableImageUrl(raw)) {
        const image = `<img src="${escapeHtml(resolved)}" loading="lazy" alt="${escapeHtml(name || fallbackAlt)}" title="${escapeHtml(name || '')}">`;
        figures.push(isInlineImageDataUrl(raw)
          ? `<figure>${image}</figure>`
          : `<figure><a href="${escapeHtml(raw)}" target="_blank" rel="noreferrer">${image}</a></figure>`);
      } else {
        figures.push(`<figure class="media-link"><a href="${escapeHtml(raw)}" target="_blank" rel="noreferrer">${escapeHtml(name || fallbackAlt || 'Discord media')}</a></figure>`);
      }
    }
    return figures.length ? `<div class="gallery ${escapeHtml(className || '')}">${figures.join('')}</div>` : '';
  }

  function attachmentHtml(message, resolveMedia, includeVideos, includeFiles) {
    const attachments = [...new Set(message.attachments || [])];
    if (!attachments.length) return '';

    const videoBlocks = [];
    const links = [];
    for (const raw of attachments) {
      const name = originalNameFromUrl(raw) || raw;
      if (isVideoAttachmentUrl(raw)) {
        const resolved = includeVideos ? resolveAssetUrl(raw, resolveMedia) : raw;
        if (includeVideos) {
          videoBlocks.push(`<figure class="video-item"><video controls preload="metadata" src="${escapeHtml(resolved)}"></video><figcaption><a href="${escapeHtml(resolved)}" target="_blank" rel="noreferrer">${escapeHtml(name)}</a></figcaption></figure>`);
        } else {
          links.push(`<li><a href="${escapeHtml(raw)}" target="_blank" rel="noreferrer">${escapeHtml(name)}</a> <span class="attachment-note">(video not embedded)</span></li>`);
        }
        continue;
      }

      if (isOtherAttachmentFileUrl(raw)) {
        const resolved = includeFiles ? resolveAssetUrl(raw, resolveMedia) : raw;
        links.push(`<li><a href="${escapeHtml(resolved)}" target="_blank" rel="noreferrer">${escapeHtml(name)}</a></li>`);
        continue;
      }

      // Image attachments are already rendered in the image gallery. Keep a
      // normal source link here to preserve the previous exporter behavior.
      links.push(`<li><a href="${escapeHtml(raw)}" target="_blank" rel="noreferrer">${escapeHtml(name)}</a></li>`);
    }

    const videos = videoBlocks.length ? `<div class="video-gallery">${videoBlocks.join('')}</div>` : '';
    const list = links.length ? `<div class="section"><b>Attachments</b><ul>${links.join('')}</ul></div>` : '';
    return videos + list;
  }

  function reactionHtml(message, resolveImage) {
    const labels = message.reactions || [];
    const assets = message.reactionEmojis || [];
    if (!labels.length && !assets.length) return '';
    const icons = assets.map(asset => {
      const src = resolveAssetUrl(asset.url, resolveImage);
      return `<img class="reaction-emoji" src="${escapeHtml(src)}" alt="${escapeHtml(asset.name || 'reaction emoji')}" title="${escapeHtml(asset.name || '')}">`;
    }).join('');
    const text = labels.length ? `<span>${labels.map(escapeHtml).join(' · ')}</span>` : '';
    return `<div class="reactions">${icons}${text}</div>`;
  }

  function editHistoryHtml(message, resolveImage) {
    if (!message.editHistory?.length) return '';
    return `<div class="edit-history">${message.editHistory.map((edit, index) => {
      const local = edit.localTimestamp || formatLocalTimestamp(edit.timestamp || '');
      const label = message.editHistory.length > 1 ? `Previous version ${index + 1}` : 'Previous version';
      return `<div class="edit-history-entry">
        <div class="edit-history-meta"><span>${escapeHtml(label)}</span>${local ? ` <time datetime="${escapeHtml(edit.timestamp || '')}">${escapeHtml(local)}</time>` : ''}</div>
        <div class="edit-history-content">${renderContent(edit, resolveImage)}</div>
      </div>`;
    }).join('')}</div>`;
  }

  function toHtml(messages, name, options = {}) {
    const { resolveImage = null, resolveAvatar = null, resolveMedia = resolveImage, includeImages = true, includeVideos = false, includeFiles = false, sourceUrl = location.href, comparisonInfo = null, exportedAt = '' } = options;
    const topLevelMessages = messages.filter(message => !message.isThreadMessage);
    const threadMessages = messages.filter(message => message.isThreadMessage);
    const groups = groupMessagesForHtml(topLevelMessages);
    const threadsByParent = new Map();

    for (const message of threadMessages) {
      const parentId = String(message.threadParentMessageId || '');
      if (!parentId) continue;
      if (!threadsByParent.has(parentId)) threadsByParent.set(parentId, []);
      threadsByParent.get(parentId).push(message);
    }
    for (const replies of threadsByParent.values()) replies.sort(compareSnowflakes);

    const renderMessage = (m) => `
        <div class="message${m.deleted ? ' deleted-message' : ''}${m.edited ? ' edited-message' : ''}${m.deletedBetweenExports ? ' between-export-deleted' : ''}" data-message-id="${escapeHtml(m.id)}" data-deleted="${m.deleted ? 'true' : 'false'}" data-edited="${m.edited ? 'true' : 'false'}" data-deleted-between-exports="${m.deletedBetweenExports ? 'true' : 'false'}" data-thread-message="${m.isThreadMessage ? 'true' : 'false'}" data-thread-id="${escapeHtml(m.threadId || '')}" data-thread-name="${escapeHtml(m.threadName || '')}" data-thread-parent-message-id="${escapeHtml(m.threadParentMessageId || '')}" data-thread-source-url="${escapeHtml(m.threadSourceUrl || '')}">
          <div class="message-meta"><time datetime="${escapeHtml(m.timestamp)}">${escapeHtml(m.timestamp)}</time> <span class="id">${escapeHtml(m.id)}</span>${m.deleted ? ' <span class="deleted-badge" title="Retained by Vencord MessageLogger">DELETED</span>' : ''}${m.edited ? ' <span class="edited-badge" title="Edit history retained by Vencord MessageLogger">EDITED</span>' : ''}${m.deletedBetweenExports ? ' <span class="between-export-badge" title="Present in the previous export but absent from the current pull">DELETED BETWEEN EXPORTS</span>' : ''}</div>
          ${m.deletedBetweenExports ? `<div class="between-export-note">${escapeHtml(m.deletedBetweenExportsNote || comparisonDeletionNote(m.previousExportedAt, m.comparisonDetectedAt || exportedAt))}</div>` : ''}
          ${m.reply ? `<div class="reply">Reply context: ${escapeHtml(m.reply)}</div>` : ''}
          ${editHistoryHtml(m, resolveImage)}
          <div class="content">${renderContent(m, resolveImage)}</div>
          ${imageGallery(m.images, resolveImage)}
          ${assetGallery(m.stickers, resolveImage, 'stickers', 'Discord sticker')}
          ${attachmentHtml(m, resolveMedia, includeVideos, includeFiles)}
          ${m.embeds?.length ? `<div class="section"><b>Embed links</b>${linkList(m.embeds)}</div>` : ''}
          ${reactionHtml(m, resolveImage)}
        </div>`;

    const renderGroup = (group, thread = false) => {
      const avatarSrc = group.avatar ? (resolveAvatar ? resolveAvatar(group.avatar) : group.avatar) : '';
      const avatar = avatarSrc
        ? `<img class="avatar" src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(group.author)} profile picture">`
        : `<div class="avatar placeholder" aria-hidden="true"></div>`;
      const firstTimestamp = group.messages[0]?.timestamp || '';
      const localTimestamp = group.messages[0]?.localTimestamp || formatLocalTimestamp(firstTimestamp);
      return `
      <article class="message-group${thread ? ' thread-message-group' : ''}">
        <div class="avatar-column">${avatar}</div>
        <div class="group-body">
          <div class="group-header"><strong>${escapeHtml(group.author || 'Unknown')}</strong> <time class="local-time" datetime="${escapeHtml(firstTimestamp)}">${escapeHtml(localTimestamp)}</time></div>
          ${group.messages.map(renderMessage).join('')}
        </div>
      </article>`;
    };

    const safeThreadDomToken = (value) => String(value || 'thread').replace(/[^a-zA-Z0-9_-]+/g, '-');

    const threadDescriptor = (parentId, replies) => {
      const threadName = replies.find(reply => reply.threadName)?.threadName || 'Discord thread';
      const threadId = replies.find(reply => reply.threadId)?.threadId || '';
      const threadUrl = replies.find(reply => reply.threadSourceUrl)?.threadSourceUrl || '';
      const domId = `dhe-thread-${safeThreadDomToken(threadId || parentId)}`;
      return { threadName, threadId, threadUrl, domId };
    };

    const renderThreadButton = (parentMessage) => {
      const replies = threadsByParent.get(String(parentMessage.id || '')) || [];
      if (!replies.length) return '';
      const { threadName, domId } = threadDescriptor(parentMessage.id, replies);
      return `<div class="thread-launch"><a class="thread-open-button" href="#${escapeHtml(domId)}" role="button" aria-label="Open thread ${escapeHtml(threadName)}"><span class="thread-icon">#</span><span class="thread-button-name">${escapeHtml(threadName)}</span><span class="thread-button-action">View thread</span><span class="thread-count">${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}</span></a></div>`;
    };

    const renderThreadDrawer = (parentMessage, replies, orphan = false) => {
      const { threadName, threadId, threadUrl, domId } = threadDescriptor(parentMessage?.id || '', replies);
      const replyGroups = groupMessagesForHtml(replies);
      const sourceLink = threadUrl
        ? `<a class="thread-source-link" href="${escapeHtml(threadUrl)}" target="_blank" rel="noreferrer">Open in Discord</a>`
        : '';
      const parentTimestamp = parentMessage?.timestamp || '';
      const parentLocal = parentMessage?.localTimestamp || formatLocalTimestamp(parentTimestamp);
      const parentAuthor = parentMessage?.author || '';
      const parentContent = parentMessage && !orphan
        ? renderContent(parentMessage, resolveImage)
        : '<span class="thread-parent-missing">Parent message was outside the exported channel range.</span>';
      return `<section id="${escapeHtml(domId)}" class="thread-drawer" data-thread-id="${escapeHtml(threadId)}" data-thread-parent-message-id="${escapeHtml(parentMessage?.id || '')}">
        <a class="thread-drawer-backdrop" href="#dhe-thread-closed" aria-label="Close thread"></a>
        <aside class="thread-drawer-panel" role="dialog" aria-modal="true" aria-label="Thread ${escapeHtml(threadName)}">
          <header class="thread-drawer-header">
            <div class="thread-drawer-title"><span class="thread-icon">#</span><div><strong>${escapeHtml(threadName)}</strong><div class="thread-drawer-subtitle">${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}</div></div></div>
            <div class="thread-drawer-actions">${sourceLink}<a class="thread-close" href="#dhe-thread-closed" aria-label="Close thread">×</a></div>
          </header>
          <div class="thread-drawer-body">
            <div class="thread-parent-context">
              <div class="thread-parent-label">${orphan ? 'Thread parent' : `Started by <strong>${escapeHtml(parentAuthor || 'Unknown')}</strong>${parentLocal ? ` <time datetime="${escapeHtml(parentTimestamp)}">${escapeHtml(parentLocal)}</time>` : ''}`}</div>
              <div class="thread-parent-content">${parentContent || '<span class="thread-parent-missing">No text content.</span>'}</div>
            </div>
            <div class="thread-replies">${replyGroups.map(group => renderGroup(group, true)).join('')}</div>
          </div>
        </aside>
      </section>`;
    };

    const items = groups.map(group => {
      const avatarSrc = group.avatar ? (resolveAvatar ? resolveAvatar(group.avatar) : group.avatar) : '';
      const avatar = avatarSrc
        ? `<img class="avatar" src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(group.author)} profile picture">`
        : `<div class="avatar placeholder" aria-hidden="true"></div>`;

      const messagesHtml = group.messages.map(m => `${renderMessage(m)}${renderThreadButton(m)}`).join('');
      const firstTimestamp = group.messages[0]?.timestamp || '';
      const localTimestamp = group.messages[0]?.localTimestamp || formatLocalTimestamp(firstTimestamp);
      return `
      <article class="message-group">
        <div class="avatar-column">${avatar}</div>
        <div class="group-body">
          <div class="group-header"><strong>${escapeHtml(group.author || 'Unknown')}</strong> <time class="local-time" datetime="${escapeHtml(firstTimestamp)}">${escapeHtml(localTimestamp)}</time></div>
          ${messagesHtml}
        </div>
      </article>`;
    }).join('\n');

    const orphanThreads = [...threadsByParent.entries()]
      .filter(([parentId]) => !topLevelMessages.some(message => String(message.id) === parentId));

    const orphanThreadButtons = orphanThreads.length
      ? `<section class="orphan-thread-list"><h2>Threads whose parent is outside this export</h2>${orphanThreads.map(([parentId, replies]) => {
          const { threadName, domId } = threadDescriptor(parentId, replies);
          return `<a class="thread-open-button orphan-thread-button" href="#${escapeHtml(domId)}" role="button"><span class="thread-icon">#</span><span class="thread-button-name">${escapeHtml(threadName)}</span><span class="thread-button-action">View thread</span><span class="thread-count">${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}</span></a>`;
        }).join('')}</section>`
      : '';

    const threadDrawers = [...threadsByParent.entries()].map(([parentId, replies]) => {
      const parent = topLevelMessages.find(message => String(message.id) === String(parentId));
      return renderThreadDrawer(parent || { id: parentId }, replies, !parent);
    }).join('\n');

    const comparisonRange = comparisonInfo?.previousExportedAt && exportedAt
      ? `${formatLocalTimestamp(comparisonInfo.previousExportedAt)} to ${formatLocalTimestamp(exportedAt)}`
      : '';
    const comparisonSummary = comparisonInfo?.enabled
      ? `<p class="comparison-summary"><b>Previous-export comparison${comparisonRange ? ` (${escapeHtml(comparisonRange)})` : ''}:</b> ${comparisonInfo.newlyMissing} message${comparisonInfo.newlyMissing === 1 ? '' : 's'} newly detected as deleted between exports${comparisonInfo.carriedMissing ? `; ${comparisonInfo.carriedMissing} previously detected missing message${comparisonInfo.carriedMissing === 1 ? '' : 's'} carried forward` : ''}.${comparisonInfo.skippedOutsideCoverage ? ` ${comparisonInfo.skippedOutsideCoverage} older previous message${comparisonInfo.skippedOutsideCoverage === 1 ? ' was' : 's were'} not compared because this pull stopped before reaching them.` : ''}</p>`
      : '';
    const exportMeta = JSON.stringify({ source: sourceUrl, exportedAt: exportedAt || '', comparison: comparisonInfo || null, archiveOptions: { includeImages: Boolean(includeImages), includeVideos: Boolean(includeVideos), includeFiles: Boolean(includeFiles), includeThreads: threadMessages.length > 0 } }).replace(/</g, '\\u003c');

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title>
    <script id="dhe-export-meta" type="application/json">${exportMeta}</script>
    <style>
      body{font-family:system-ui,sans-serif;max-width:980px;margin:40px auto;padding:0 20px;background:#111214;color:#dbdee1}
      h1{color:#f2f3f5}.message-group{display:grid;grid-template-columns:48px minmax(0,1fr);gap:12px;padding:16px 0;border-bottom:1px solid #2b2d31}.avatar-column{padding-top:2px}.avatar{display:block;width:40px;height:40px;border-radius:50%;object-fit:cover;background:#1e1f22}.avatar.placeholder{background:#2b2d31}.group-body{min-width:0}.group-header{font-size:15px;margin-bottom:3px}.group-header .local-time{color:#949ba4;margin-left:8px;font-size:12px;font-weight:400}.message{padding:3px 0}.message.edited-message:not(.deleted-message){background:rgba(0,168,252,.08);border-left:3px solid #00a8fc;margin-left:-8px;padding-left:8px}.message.edited-message:not(.deleted-message)>.content{color:#58b9ff}.message.deleted-message{background:rgba(240,71,71,.08);border-left:3px solid #f04747;margin-left:-8px;padding-left:8px}.message.deleted-message>.content{color:#f04747}.message.between-export-deleted{background:rgba(240,166,26,.10);border-left:3px solid #f0a61a;margin-left:-8px;padding-left:8px}.message.between-export-deleted>.content{color:#ffbd4a}.message-meta{font-size:11px;color:#777d87;min-height:14px}.message-meta .id{margin-left:8px}.deleted-badge,.edited-badge,.between-export-badge{display:inline-block;margin-left:8px;padding:1px 5px;border-radius:4px;color:#fff;font-size:9px;font-weight:700;letter-spacing:.04em;vertical-align:1px}.deleted-badge{background:#f04747}.edited-badge{background:#00a8fc}.between-export-badge{background:#f0a61a;color:#1e1f22}.between-export-note{margin:4px 0 5px;padding:5px 7px;border-radius:5px;background:rgba(240,166,26,.08);color:#ffbd4a;font-size:11px}.comparison-summary{padding:8px 10px;border-left:3px solid #f0a61a;background:rgba(240,166,26,.08);color:#dbdee1}.edit-history{margin:5px 0 4px}.edit-history-entry{margin:4px 0;padding:6px 8px;border-left:3px solid #00a8fc;background:rgba(0,168,252,.07);border-radius:0 5px 5px 0}.edit-history-meta{font-size:10px;color:#58b9ff;margin-bottom:2px}.edit-history-meta time{color:#949ba4;margin-left:6px}.edit-history-content{color:#58b9ff}.content{margin-top:1px;white-space:normal}.inline-emoji{width:1.375em;height:1.375em;object-fit:contain;vertical-align:-.35em;margin:0 .04em}.reply{margin:4px 0;color:#b5bac1;border-left:3px solid #4e5058;padding-left:8px}.section,.reactions{font-size:13px;margin-top:8px}.reactions{display:flex;align-items:center;gap:5px;color:#b5bac1;flex-wrap:wrap}.reaction-emoji{width:22px;height:22px;object-fit:contain}a{color:#00a8fc;overflow-wrap:anywhere}.gallery{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}.gallery figure{margin:0}.gallery img{display:block;max-width:min(100%,520px);max-height:520px;border-radius:8px;background:#1e1f22;object-fit:contain}.gallery.stickers img{max-width:180px;max-height:180px;background:transparent}.media-link{padding:8px 10px;border:1px solid #2b2d31;border-radius:8px}.video-gallery{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}.video-item{margin:0;max-width:620px}.video-item video{display:block;max-width:100%;max-height:520px;border-radius:8px;background:#000}.video-item figcaption{font-size:11px;margin-top:4px}.attachment-note{color:#949ba4;font-size:11px}
      .thread-launch{margin:8px 0 5px}.thread-open-button{display:flex;align-items:center;gap:8px;width:min(100%,520px);box-sizing:border-box;padding:8px 10px;border:1px solid #3f4147;border-radius:8px;background:#1e1f22;color:#dbdee1;text-decoration:none}.thread-open-button:hover{background:#2b2d31;border-color:#5865f2}.thread-icon{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#5865f2;color:#fff;font-weight:800}.thread-button-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.thread-button-action{color:#00a8fc;font-size:11px;margin-left:auto}.thread-count{color:#949ba4;font-size:11px;white-space:nowrap}.thread-drawer{position:fixed;inset:0;z-index:9999;visibility:hidden;pointer-events:none}.thread-drawer:target{visibility:visible;pointer-events:auto}.thread-drawer-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.62);opacity:0;transition:opacity .16s ease}.thread-drawer:target .thread-drawer-backdrop{opacity:1}.thread-drawer-panel{position:absolute;top:0;right:0;width:min(620px,94vw);height:100vh;height:100dvh;box-sizing:border-box;background:#111214;border-left:1px solid #3f4147;box-shadow:-18px 0 40px rgba(0,0,0,.45);transform:translateX(100%);transition:transform .18s ease;overflow-y:auto}.thread-drawer:target .thread-drawer-panel{transform:translateX(0)}.thread-drawer-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 14px;border-bottom:1px solid #2b2d31;background:#111214}.thread-drawer-title{display:flex;align-items:center;gap:9px;min-width:0}.thread-drawer-title>div{min-width:0}.thread-drawer-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.thread-drawer-subtitle{color:#949ba4;font-size:11px;margin-top:1px}.thread-drawer-actions{display:flex;align-items:center;gap:10px;flex:0 0 auto}.thread-source-link{font-size:11px}.thread-close{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;background:#2b2d31;color:#dbdee1;text-decoration:none;font-size:23px;line-height:1}.thread-close:hover{background:#3f4147}.thread-drawer-body{padding:0 14px 24px}.thread-parent-context{margin:14px 0 8px;padding:10px 12px;border-left:3px solid #5865f2;border-radius:0 7px 7px 0;background:rgba(88,101,242,.08)}.thread-parent-label{font-size:11px;color:#b5bac1;margin-bottom:5px}.thread-parent-label time{color:#949ba4;margin-left:6px}.thread-parent-content{overflow-wrap:anywhere}.thread-parent-missing{color:#949ba4;font-style:italic}.thread-replies{padding:0 2px}.thread-message-group{grid-template-columns:36px minmax(0,1fr);gap:9px;padding:10px 0;border-bottom:1px solid rgba(78,80,88,.55)}.thread-message-group:last-child{border-bottom:0}.thread-message-group .avatar{width:30px;height:30px}.thread-message-group .group-header{font-size:13px}.orphan-thread-list{margin:24px 0;padding:12px;border:1px solid #2b2d31;border-radius:8px;background:#1e1f22}.orphan-thread-list h2{font-size:14px;margin:0 0 10px}.orphan-thread-button{margin-top:7px;width:100%}@media(max-width:620px){.thread-button-action{display:none}.thread-drawer-panel{width:100vw}.thread-source-link{display:none}}
    </style></head><body><main id="dhe-transcript"><h1>${escapeHtml(name)}</h1><p>${topLevelMessages.length} channel messages${threadMessages.length ? ` plus ${threadMessages.length} thread replies` : ''} exported from <a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceUrl)}</a>.</p>${comparisonSummary}${items}${orphanThreadButtons}</main>${threadDrawers}</body></html>`;
  }

  function saveFile(data, filename, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }


  function base64ToBytes(base64) {
    const binary = atob(String(base64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function inlineDataUrlToBytes(raw) {
    const match = String(raw || '').match(/^data:([^;,]+);base64,(.+)$/i);
    if (!match) throw new Error('Unsupported inline media data URL.');
    return { contentType: match[1] || 'application/octet-stream', bytes: base64ToBytes(match[2]) };
  }

  let crc32Table = null;
  function crc32(bytes) {
    if (!crc32Table) {
      crc32Table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crc32Table[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crc32Table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipDosTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f),
      date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
    };
  }

  function writeU16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function writeU32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function buildZipBlob(files) {
    // Store-only ZIP keeps the implementation dependency-free and preserves
    // already-compressed Discord images without wasting time recompressing them.
    // Classic ZIP fields are 32-bit, so reject archives that require ZIP64.
    const encoder = new TextEncoder();
    const prepared = files.map(file => {
      const name = String(file.name || '').replace(/^\/+/, '').replace(/\\/g, '/');
      const nameBytes = encoder.encode(name);
      const data = file.data instanceof Uint8Array
        ? file.data
        : file.data instanceof ArrayBuffer
          ? new Uint8Array(file.data)
          : encoder.encode(String(file.data ?? ''));
      if (!name || nameBytes.length > 0xffff) throw new Error('A ZIP filename is too long.');
      if (data.length > 0xffffffff) throw new Error('A single exported file is too large for this ZIP writer.');
      return { name, nameBytes, data, crc: crc32(data), ...zipDosTime(file.date || new Date()) };
    });

    if (prepared.length > 0xffff) throw new Error('Too many files for this ZIP writer.');

    let localSize = 0;
    let centralSize = 0;
    for (const file of prepared) {
      localSize += 30 + file.nameBytes.length + file.data.length;
      centralSize += 46 + file.nameBytes.length;
    }
    const totalSize = localSize + centralSize + 22;
    if (totalSize > 0xffffffff) throw new Error('ZIP would exceed 4 GB; use MHTML or export a smaller range.');

    const out = new Uint8Array(totalSize);
    const view = new DataView(out.buffer);
    let offset = 0;
    const central = [];

    for (const file of prepared) {
      const localOffset = offset;
      writeU32(view, offset, 0x04034b50); offset += 4;
      writeU16(view, offset, 20); offset += 2;          // version needed
      writeU16(view, offset, 0x0800); offset += 2;      // UTF-8 filename
      writeU16(view, offset, 0); offset += 2;           // stored
      writeU16(view, offset, file.time); offset += 2;
      writeU16(view, offset, file.date); offset += 2;
      writeU32(view, offset, file.crc); offset += 4;
      writeU32(view, offset, file.data.length); offset += 4;
      writeU32(view, offset, file.data.length); offset += 4;
      writeU16(view, offset, file.nameBytes.length); offset += 2;
      writeU16(view, offset, 0); offset += 2;
      out.set(file.nameBytes, offset); offset += file.nameBytes.length;
      out.set(file.data, offset); offset += file.data.length;
      central.push({ file, localOffset });
    }

    const centralOffset = offset;
    for (const { file, localOffset } of central) {
      writeU32(view, offset, 0x02014b50); offset += 4;
      writeU16(view, offset, 20); offset += 2;          // version made by
      writeU16(view, offset, 20); offset += 2;          // version needed
      writeU16(view, offset, 0x0800); offset += 2;      // UTF-8 filename
      writeU16(view, offset, 0); offset += 2;           // stored
      writeU16(view, offset, file.time); offset += 2;
      writeU16(view, offset, file.date); offset += 2;
      writeU32(view, offset, file.crc); offset += 4;
      writeU32(view, offset, file.data.length); offset += 4;
      writeU32(view, offset, file.data.length); offset += 4;
      writeU16(view, offset, file.nameBytes.length); offset += 2;
      writeU16(view, offset, 0); offset += 2;           // extra
      writeU16(view, offset, 0); offset += 2;           // comment
      writeU16(view, offset, 0); offset += 2;           // disk
      writeU16(view, offset, 0); offset += 2;           // internal attrs
      writeU32(view, offset, 0); offset += 4;           // external attrs
      writeU32(view, offset, localOffset); offset += 4;
      out.set(file.nameBytes, offset); offset += file.nameBytes.length;
    }

    const actualCentralSize = offset - centralOffset;
    writeU32(view, offset, 0x06054b50); offset += 4;
    writeU16(view, offset, 0); offset += 2;
    writeU16(view, offset, 0); offset += 2;
    writeU16(view, offset, prepared.length); offset += 2;
    writeU16(view, offset, prepared.length); offset += 2;
    writeU32(view, offset, actualCentralSize); offset += 4;
    writeU32(view, offset, centralOffset); offset += 4;
    writeU16(view, offset, 0); offset += 2;

    return new Blob([out], { type: 'application/zip' });
  }

  function shouldArchiveMediaEntry(entry, options = {}) {
    const { includeImages = true, includeVideos = false, includeFiles = false } = options;
    if (entry.kind === 'video') return Boolean(includeVideos);
    if (entry.kind === 'file') return Boolean(includeFiles);
    return Boolean(includeImages);
  }

  async function collectZipMedia(mediaIndex, archiveOptions) {
    const fetched = new Map();
    const files = [];
    let failures = 0;
    let totalBytes = 0;

    const selected = mediaIndex.entries.filter(entry => shouldArchiveMediaEntry(entry, archiveOptions));
    if (!selected.length) return { fetched, files, failures, totalBytes, selectedCount: 0 };

    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i];
      sendProgress(`Packing media into ZIP…
${i + 1}/${selected.length}
${Math.round(totalBytes / 1024 / 1024)} MB fetched, ${failures} failed`);
      try {
        let bytes;
        let contentType = 'application/octet-stream';
        if (isInlineImageDataUrl(entry.url)) {
          const inline = inlineDataUrlToBytes(entry.url);
          bytes = inline.bytes;
          contentType = inline.contentType;
        } else {
          const result = await runtimeMessage({ type: 'DHE_FETCH_MEDIA', url: entry.url });
          if (!result?.ok || !result.base64) throw new Error(result?.error || 'fetch failed');
          bytes = base64ToBytes(result.base64);
          contentType = result.contentType || contentType;
        }
        fetched.set(entry.key, { ...entry, bytes, contentType });
        files.push({ name: entry.filename, data: bytes });
        totalBytes += bytes.length;
      } catch (err) {
        console.warn('[DHE] ZIP media fetch failed', entry.url, err);
        failures++;
      }
    }

    return { fetched, files, failures, totalBytes, selectedCount: selected.length };
  }

  function pageLooksLikeBeginning() {
    const text = document.body.innerText || '';
    return /beginning of (the )?(channel|conversation)|welcome to the beginning/i.test(text);
  }

  async function runtimeMessage(message) {
    return await chrome.runtime.sendMessage(message);
  }

  async function downloadMedia(entries, base) {
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      sendProgress(`Saving media…\n${i + 1}/${entries.length}\n${ok} saved, ${failed} failed`);
      try {
        const result = await runtimeMessage({
          type: 'DHE_DOWNLOAD_URL',
          url: entry.url,
          filename: `${base}-media/${entry.filename}`
        });
        if (!result?.ok) throw new Error(result?.error || 'download failed');
        ok++;
      } catch (err) {
        console.warn('[DHE] image download failed', entry.url, err);
        failed++;
      }
    }
    return { ok, failed };
  }

  function wrapBase64(base64) {
    return base64.replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');
  }

  function cleanHeaderValue(value) {
    return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  }

  async function buildMhtml(messages, name, base, mediaIndex, archiveOptions, htmlOptions = {}) {
    const boundary = `----=_DHE_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const fetched = new Map();
    let totalBytes = 0;
    let failures = 0;

    const selected = mediaIndex.entries.filter(entry => shouldArchiveMediaEntry(entry, archiveOptions));
    if (selected.length) {
      for (let i = 0; i < selected.length; i++) {
        const entry = selected[i];
        sendProgress(`Embedding media into MHTML…
${i + 1}/${selected.length}
${Math.round(totalBytes / 1024 / 1024)} MB fetched, ${failures} failed`);
        // Rendered Lottie sticker snapshots are already data URLs inside the HTML,
        // so they need no separate MIME part.
        if (isInlineImageDataUrl(entry.url)) continue;
        try {
          const result = await runtimeMessage({ type: 'DHE_FETCH_MEDIA', url: entry.url });
          if (!result?.ok || !result.base64) throw new Error(result?.error || 'fetch failed');
          fetched.set(entry.key, {
            ...entry,
            contentType: cleanHeaderValue(result.contentType || 'application/octet-stream'),
            byteLength: Number(result.byteLength) || 0,
            base64: result.base64
          });
          totalBytes += Number(result.byteLength) || 0;
        } catch (err) {
          console.warn('[DHE] MHTML media fetch failed', entry.url, err);
          failures++;
        }
      }
    }

    const resolveImage = (raw) => {
      const key = canonicalImageKey(raw);
      return fetched.get(key)?.url || raw;
    };
    const html = toHtml(messages, name, { ...htmlOptions, resolveImage, resolveAvatar: resolveImage, resolveMedia: resolveImage, includeImages: Boolean(archiveOptions?.includeImages), includeVideos: Boolean(archiveOptions?.includeVideos), includeFiles: Boolean(archiveOptions?.includeFiles), sourceUrl: location.href });
    const rootLocation = `https://discord-history-export.local/${encodeURIComponent(base)}.html`;
    const parts = [];

    parts.push(
      `From: <Saved by Local Discord History Exporter>\r\n` +
      `Subject: ${cleanHeaderValue(name)}\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="utf-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n` +
      `Content-Location: ${rootLocation}\r\n\r\n` +
      html + `\r\n`
    );

    for (const item of fetched.values()) {
      const partType = item.kind === 'file' && /^multipart\//i.test(item.contentType)
        ? 'application/octet-stream'
        : item.contentType;
      const disposition = item.kind === 'file' ? 'attachment' : 'inline';
      parts.push(
        `--${boundary}\r\n` +
        `Content-Type: ${partType}\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        `Content-Location: ${cleanHeaderValue(item.url)}\r\n` +
        `Content-Disposition: ${disposition}; filename="${cleanHeaderValue(item.filename).replace(/"/g, '')}"\r\n\r\n` +
        wrapBase64(item.base64) + `\r\n`
      );
    }

    parts.push(`--${boundary}--\r\n`);
    return {
      blob: new Blob(parts, { type: 'multipart/related' }),
      embedded: fetched.size + selected.filter(entry => isInlineImageDataUrl(entry.url)).length,
      failures,
      totalBytes
    };
  }

  async function exportCurrentChat(options) {
    if (running) throw new Error('An export is already running in this tab.');
    running = true;
    stopRequested = false;
    phase = 'starting';

    const {
      format = 'mhtml',
      includeImages = true,
      includeVideos = false,
      includeFiles = false,
      includeThreads = false,
      delayMs = 900,
      stagnantLimit = 8,
      comparePrevious = false
    } = options || {};
    const comparisonSnapshot = comparePrevious && previousImport?.ready
      ? { meta: { ...(previousImport.meta || {}) }, messages: [...(previousImport.messages || [])] }
      : null;
    if (comparePrevious && !comparisonSnapshot) throw new Error('The previous export comparison was not loaded. Re-select the previous export and try again.');
    previousImport = null;
    const archiveOptions = { includeImages, includeVideos, includeFiles, includeThreads };
    const messages = new Map();
    const threadMessages = new Map();
    const attemptedThreadKeys = new Set();
    const completedThreadIds = new Set();
    const avatarCache = new Map();
    const avatarAttempts = new Map();

    try {
      const mainChannelId = activeConversationChannelId() || channelIdFromNode(visibleMessageNodes()[0]);
      let nodes = visibleMessageNodes(mainChannelId);
      if (!nodes.length) throw new Error('No Discord messages found. Open a text channel or DM and wait for it to load.');

      let scroller = findScroller(nodes);
      if (!scroller) throw new Error('Could not identify Discord\'s message scroller. Discord may have changed its layout.');

      phase = 'scanning';
      sendProgress('Moving to the newest messages…');
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(delayMs);
      nodes = visibleMessageNodes(mainChannelId);
      scanInto(messages, avatarCache, nodes);
      await augmentVisibleStickerSnapshots(messages);
      await hydrateVisibleAvatars(messages, avatarCache, avatarAttempts, 6);

      let stagnant = 0;
      let pass = 0;
      let lastOldest = null;
      let reachedBeginning = false;

      while (stagnant < stagnantLimit && !stopRequested) {
        pass++;
        nodes = visibleMessageNodes(mainChannelId);
        scanInto(messages, avatarCache, nodes);
        await augmentVisibleStickerSnapshots(messages);
        await hydrateVisibleAvatars(messages, avatarCache, avatarAttempts, 4);

        if (stopRequested) break;

        const beforeTop = scroller.scrollTop;
        const step = Math.max(500, Math.floor(scroller.clientHeight * 0.82));
        scroller.scrollTop = Math.max(0, beforeTop - step);
        await sleep(delayMs);

        nodes = visibleMessageNodes(mainChannelId);
        const added = scanInto(messages, avatarCache, nodes);
        await augmentVisibleStickerSnapshots(messages);
        await hydrateVisibleAvatars(messages, avatarCache, avatarAttempts, 4);
        const ordered = [...messages.values()].sort(compareSnowflakes);
        const oldest = ordered[0]?.id || null;

        if (added === 0 && oldest === lastOldest) stagnant++;
        else stagnant = 0;
        lastOldest = oldest;

        const mediaCount = ordered.reduce((n, m) => n + (m.images?.length || 0) + (m.emojis?.length || 0) + (m.stickers?.length || 0) + (m.reactionEmojis?.length || 0) + (m.attachments?.filter(isVideoAttachmentUrl).length || 0) + (m.attachments?.filter(isOtherAttachmentFileUrl).length || 0), 0);
        sendProgress(`Scanning main history…\n${messages.size} channel messages captured\n${mediaCount} media references seen\npass ${pass}, idle ${stagnant}/${stagnantLimit}`);

        if (scroller.scrollTop <= 1) {
          await sleep(delayMs);
          nodes = visibleMessageNodes(mainChannelId);
          const topAdded = scanInto(messages, avatarCache, nodes);
          await augmentVisibleStickerSnapshots(messages);
          await hydrateVisibleAvatars(messages, avatarCache, avatarAttempts, 6);
          if (topAdded > 0) stagnant = 0;
          if (pageLooksLikeBeginning() && topAdded === 0) {
            reachedBeginning = true;
            break;
          }
        }

        if (pass > 200000) throw new Error('Stopped after too many scan passes.');
      }

      if (stopRequested) {
        sendProgress(`Stopping scan and preparing export…\n${messages.size} channel messages captured so far.`);
      } else {
        await hydrateVisibleAvatars(messages, avatarCache, avatarAttempts, 10);
      }

      if (!stopRequested && scroller.scrollTop <= 1) reachedBeginning = true;

      if (includeThreads && !stopRequested) {
        const mainOldestId = [...messages.values()].sort(compareSnowflakes)[0]?.id || '';
        const threadPass = await scanThreadsSecondPass(
          mainChannelId,
          scroller,
          threadMessages,
          attemptedThreadKeys,
          avatarCache,
          avatarAttempts,
          { delayMs, stagnantLimit, stopAtMessageId: mainOldestId },
          completedThreadIds
        );
        scroller = threadPass.scroller || scroller;
        if (stopRequested) {
          sendProgress(`Stopping thread pass and preparing export…\n${messages.size} channel messages and ${threadMessages.size} thread replies captured so far.`);
        }
      }

      phase = 'exporting';
      const exportedAt = new Date().toISOString();
      const mainOrdered = normalizeMessageIdentity([...messages.values()].sort(compareSnowflakes));
      const threadOrdered = [...threadMessages.values()]
        .sort((a, b) => String(a.threadId || '').localeCompare(String(b.threadId || '')) || compareSnowflakes(a, b));
      const currentOrdered = [...mainOrdered, ...threadOrdered];
      const comparisonResult = comparisonSnapshot
        ? applyPreviousComparison(currentOrdered, comparisonSnapshot, { reachedBeginning, currentExportedAt: exportedAt, includeThreads, completedThreadIds })
        : { messages: currentOrdered, info: null };
      const ordered = comparisonResult.messages;
      const comparisonInfo = comparisonResult.info;
      if (comparisonInfo) {
        sendProgress(`Comparing with previous export…\n${comparisonInfo.newlyMissing} newly missing message${comparisonInfo.newlyMissing === 1 ? '' : 's'}\n${comparisonInfo.carriedMissing} previous comparison deletion${comparisonInfo.carriedMissing === 1 ? '' : 's'} carried forward`);
      }
      const name = conversationName();
      const base = `${safeFileName(name)}-${timestampForFilename()}`;
      const mediaIndex = buildMediaIndex(ordered);
      let mediaSummary = '';

      if (format === 'mhtml') {
        const result = await buildMhtml(ordered, name, base, mediaIndex, archiveOptions, { comparisonInfo, exportedAt });
        saveFile(result.blob, `${base}.mhtml`, 'multipart/related');
        mediaSummary = result.embedded || result.failures
          ? ` ${result.embedded} media files embedded${result.failures ? `, ${result.failures} failed` : ''}.`
          : '';
      } else {
        const zipMedia = await collectZipMedia(mediaIndex, archiveOptions);
        const zipFiles = [];
        const mediaFolder = `${base}-media`;

        if (format === 'json') {
          zipFiles.push({
            name: `${base}.json`,
            data: JSON.stringify({ source: location.href, exportedAt, comparison: comparisonInfo, archiveOptions, messages: ordered }, null, 2)
          });
        } else if (format === 'csv') {
          zipFiles.push({ name: `${base}.csv`, data: toCsv(ordered) });
        } else {
          const resolver = (raw) => {
            const key = canonicalImageKey(raw);
            const entry = mediaIndex.byKey.get(key);
            return entry && zipMedia.fetched.has(key) ? `${mediaFolder}/${entry.filename}` : raw;
          };
          zipFiles.push({
            name: `${base}.html`,
            data: toHtml(ordered, name, { resolveImage: resolver, resolveAvatar: resolver, resolveMedia: resolver, includeImages, includeVideos, includeFiles, sourceUrl: location.href, comparisonInfo, exportedAt })
          });
        }

        for (const file of zipMedia.files) {
          zipFiles.push({ name: `${mediaFolder}/${file.name}`, data: file.data });
        }

        sendProgress(`Building ZIP…
${zipFiles.length} files
${Math.round(zipMedia.totalBytes / 1024 / 1024)} MB media`);
        const zipBlob = buildZipBlob(zipFiles);
        saveFile(zipBlob, `${base}-${format}.zip`, 'application/zip');
        mediaSummary = zipMedia.selectedCount
          ? ` ${zipMedia.files.length} media files packed into ZIP${zipMedia.failures ? `, ${zipMedia.failures} failed` : ''}.`
          : ' ZIP contains the transcript only.';
      }

      phase = 'done';
      const comparisonSummary = comparisonInfo
        ? ` Comparison found ${comparisonInfo.newlyMissing} message${comparisonInfo.newlyMissing === 1 ? '' : 's'} deleted between the previous and current pull.${comparisonInfo.skippedOutsideCoverage ? ` ${comparisonInfo.skippedOutsideCoverage} older previous message${comparisonInfo.skippedOutsideCoverage === 1 ? ' was' : 's were'} outside this pull's scanned range.` : ''}`
        : '';
      sendProgress(`Done. Exported ${messages.size} channel messages${includeThreads ? ` plus ${threadMessages.size} thread replies` : ''}.${mediaSummary}${comparisonSummary}`, true);
    } finally {
      running = false;
      stopRequested = false;
      if (phase !== 'done') phase = 'idle';
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'DHE_GET_STATUS') {
      sendResponse({
        ok: true,
        running,
        stopRequested,
        phase,
        canStop: running && (phase === 'starting' || phase === 'scanning' || phase === 'threads'),
        text: lastProgressText
      });
      return;
    }

    if (message?.type === 'DHE_PREVIOUS_CLEAR') {
      if (running) {
        sendResponse({ ok: false, error: 'Cannot change the comparison export while a scan is running.' });
        return;
      }
      previousImport = null;
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'DHE_PREVIOUS_BEGIN') {
      if (running) {
        sendResponse({ ok: false, error: 'Cannot load a comparison export while a scan is running.' });
        return;
      }
      previousImport = {
        sessionId: String(message.sessionId || ''),
        meta: { ...(message.meta || {}) },
        messages: [],
        ready: false
      };
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'DHE_PREVIOUS_CHUNK') {
      if (!previousImport || previousImport.sessionId !== String(message.sessionId || '')) {
        sendResponse({ ok: false, error: 'Previous-export import session was lost. Try selecting the file again.' });
        return;
      }
      const chunk = Array.isArray(message.messages) ? message.messages : [];
      previousImport.messages.push(...chunk);
      sendResponse({ ok: true, count: previousImport.messages.length });
      return;
    }

    if (message?.type === 'DHE_PREVIOUS_END') {
      if (!previousImport || previousImport.sessionId !== String(message.sessionId || '')) {
        sendResponse({ ok: false, error: 'Previous-export import session was lost. Try selecting the file again.' });
        return;
      }
      previousImport.ready = true;
      sendResponse({ ok: true, count: previousImport.messages.length });
      return;
    }

    if (message?.type === 'DHE_STOP_EXPORT') {
      if (!running) {
        sendResponse({ ok: false, error: 'No export is currently running.' });
        return;
      }
      if (phase !== 'starting' && phase !== 'scanning' && phase !== 'threads') {
        sendResponse({ ok: false, error: 'The history scan has already ended and the file is being prepared.' });
        return;
      }
      stopRequested = true;
      sendProgress('Stop requested. Finishing the current scan step, then exporting what has been captured…');
      sendResponse({ ok: true });
      return;
    }

    if (message?.type !== 'DHE_START_EXPORT') return;
    if (running) {
      sendResponse({ ok: false, error: 'An export is already running.' });
      return;
    }

    sendResponse({ ok: true });
    exportCurrentChat(message.options).catch(err => {
      console.error('[DHE]', err);
      phase = 'idle';
      sendProgress(`Export failed: ${err.message}`, true);
    });
    return true;
  });

})();
