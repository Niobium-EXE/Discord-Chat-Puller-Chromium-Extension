## v0.7.1 startup bottom-anchor fix

- Fixes a startup race where Discord's virtual message list could be nudged upward while the exporter was trying to move to the newest messages.
- The exporter no longer calls `scrollIntoView()` on a potentially stale last-message node or sends a synthetic End key during bottom anchoring.
- Jump-to-present now reacquires Discord's message scroller, pins it to the real bottom across multiple layout frames, and verifies the jump control is gone before scanning upward.
- The main scan reacquires the virtual scroller as Discord recycles it and re-pins once after avatar/profile hydration so the first history step starts from the actual newest messages.

## v0.7.0 verified thread return + large attachment fix

- Thread exports still use the optional two-pass workflow, but the second pass now records the newest main-channel message ID from pass one, repeatedly returns Discord to the bottom, and verifies that newest ID is visible before thread scanning begins. If Discord cannot be returned to the newest messages, the exporter stops with a clear error instead of silently scanning threads from the wrong point.
- The return-to-newest routine also tries Discord's visible **Jump to Present** control when available and waits for the virtualized message list to settle.
- Large attachment embedding no longer sends an entire MP4 or other file through one Chromium extension message. Media is fetched by the background worker and transferred to the content script in 6 MiB chunks, avoiding Chromium's approximately 64 MiB extension-message limit.
- Chunked transfer is used for both MHTML media embedding and ZIP media packing.

## v0.6.9 second-pass threads + thread drawer exports

- **Include threads** remains an Advanced option and remains **off by default**.
- The normal channel history is now pulled completely first. Threads are not opened during that first pass.
- If thread export is enabled and the main scan completes normally, the exporter returns to the newest part of the channel and performs a dedicated **second pass** that only looks for and opens threads while moving back through the same main-history range again.
- **Stop & export** also works during the thread-only second pass; already captured thread replies are kept.
- HTML/MHTML no longer dump thread replies inline below the parent message. A compact **View thread** control appears on the parent instead.
- Selecting **View thread** opens an offline Discord-style drawer from the right containing the thread title, parent-message context, reply count, and captured thread replies. The drawer uses fragment/CSS navigation instead of JavaScript so it also works in local MHTML/HTML viewers that restrict scripts.
- Thread replies retain the same avatar, emoji/sticker, attachment, Vencord edit/deletion, and previous-export comparison metadata as before.
- JSON/CSV continue to include `isThreadMessage`, `threadId`, `threadName`, `threadParentMessageId`, and `threadSourceUrl`.

## v0.6.8 optional thread history export

- Adds **Include threads** to the Advanced tab in both the normal popup and Opera/Opera GX sidebar. It is **off by default**.
- When enabled, the exporter detects accessible thread controls while each parent message is visible, opens the thread, scrolls through its reply history, captures the replies, and returns to the parent channel scan.
- HTML/MHTML nest captured thread replies under the originating channel message in a Discord-style thread block.
- JSON/CSV include `isThreadMessage`, `threadId`, `threadName`, `threadParentMessageId`, and `threadSourceUrl`.
- Thread replies use the same avatar, emoji, sticker, edit/deletion, and optional media-attachment handling as normal messages.
- Previous-export deletion comparison only treats a missing thread reply as deleted when that same thread was enabled and completely scanned in the current pull, preventing false orange deletions when thread export is disabled or incomplete.
- Thread export relies on Discord's rendered web UI and only captures threads the logged-in account can open. Discord UI changes may require selector updates.

## v0.6.7 edge-safe tooltips

Info tooltips in both the normal Chromium popup and the Opera/Opera GX sidebar are now positioned dynamically and clamped to the visible panel. They stay inside the panel near left/right edges, wrap normally, and flip above the info icon when there is not enough room below. Export behavior is unchanged from v0.6.6.

## v0.6.6 compact settings tooltips

The popup and Opera/Opera GX sidebar now use short setting titles with a circled `i` beside settings that need explanation. Hover or keyboard-focus the info icon to see the detailed description. Export behavior is unchanged from v0.6.5.

## v0.6.5 Opera / Opera GX sidebar support

- Adds an Opera `sidebar_action` while retaining the existing Chromium toolbar `action`.
- Opera and Opera GX can keep the exporter controls open in the browser sidebar during long-running pulls.
- Adds a responsive `sidebar.html` panel that uses the same export/comparison logic as the normal popup.
- The sidebar collapses the two-column controls on very narrow panel widths.
- Other Chromium browsers continue to use the normal toolbar popup; the Opera-specific manifest key is additive.

## v0.6.3 timestamped between-export deletions

- Orange comparison deletions now say exactly when the deletion window occurred using the previous pull's export timestamp and the current pull's export timestamp, formatted in the viewer's local time.
- Example: `Deleted between Aug 25, 2026, 8:14:32 PM CDT and Aug 26, 2026, 5:21:06 PM CDT.`
- The raw ISO timestamps remain available as `previousExportedAt` and `comparisonDetectedAt` in structured export data.
- The HTML/MHTML comparison summary also shows the previous-to-current pull time range.

## v0.6.2 previous-export deletion comparison

- Adds an optional **Compare with previous export** file picker in the extension popup.
- Accepts earlier exporter `.mhtml`, `.zip`, `.html`, `.json`, and `.csv` pulls. ZIP imports understand the store-only archives produced by this extension and can also read ordinary DEFLATE ZIP entries in Chromium when `DecompressionStream` is available.
- Compares by Discord message ID. A message that existed in the previous pull but is absent from the currently scanned history is restored into the new transcript and highlighted **orange** with a `DELETED BETWEEN EXPORTS` badge.
- Orange comparison deletions include the exact local-time window between the previous export and current export.
- Keeps Vencord MessageLogger deletions separate: Vencord-retained deletions stay **red**, edits stay **blue**, and between-export deletions are **orange**.
- JSON/CSV add `deletedBetweenExports`, `deletedBetweenExportsSource`, `deletedBetweenExportsNote`, `comparisonStatus`, `previousExportedAt`, and `comparisonDetectedAt` fields.
- JSON exports also include top-level comparison metadata. HTML/MHTML include a comparison summary and embedded export metadata to make future comparisons easier.
- Previously detected orange deletions are carried forward when they are still within the current pull's covered range.
- When **Stop & export** is used before reaching the beginning of the conversation, the comparer only calls a previous message missing if its snowflake falls within the range the current pull actually scanned. Older previous messages outside that range are skipped instead of being falsely labeled deleted.
- The importer verifies the Discord channel/DM using the source URL, channel ID, or overlapping message IDs before comparing, reducing accidental cross-channel comparisons.

## v0.6.1 ZIP packaging

- MHTML remains a single `.mhtml` download.
- HTML, JSON, and CSV now each download as a **single ZIP archive** instead of creating a transcript download plus many separate media downloads.
- With media enabled, the ZIP contains the selected transcript at the root and a sibling `<export-name>-media/` folder containing all successfully fetched avatars, images, stickers, custom emojis, and reaction emoji assets.
- HTML inside the ZIP points to those local media files. If a media fetch fails, its original Discord URL is retained instead.
- With media disabled, the non-MHTML ZIP contains only the selected transcript file.

## v0.5.9 per-author avatar fix

- Stops treating arbitrary images inside Compact-mode message rows as the message author's PFP.
- Resolves missing avatars only from the profile popout opened for that specific visible author.
- Verifies the newly opened profile root using the expected display name and/or a newly created popout before accepting an avatar.
- Removes the old page-wide image fallback that could assign one visible user's avatar to another user with a default avatar.
- Extracts the user ID from the verified profile where Discord exposes it and derives the built-in default avatar when necessary.
- Supports both the current username-system default-avatar formula and the legacy discriminator-based formula when a legacy discriminator is visible.
- Keeps a resolved `user:<snowflake>` identity key when available so two authors are not merged merely because of display-name caching.

## v0.6.0 Vencord edited-message support

When Vencord MessageLogger exposes edit history in the rendered chat, the exporter detects `messagelogger-edited` history rows and the `messagelogger-edit-marker` attached to edited messages. HTML/MHTML exports show a blue `EDITED` badge and blue highlight, and include any previous text revisions that Vencord is currently rendering. JSON/CSV include `edited`, `editedSource`, and `editHistory` fields. Deleted messages remain red; a message can carry both deleted and edited flags.

If Vencord's inline edit-history display is disabled, the exporter can still mark a message as edited when the Vencord edit marker is present, but previous revisions are only exportable when Vencord has rendered them into the page.

## v0.5.5 default-avatar fix

- Prevents Compact-mode continuation logic from carrying the previous author's avatar onto a different author.
- Detects Discord default avatar URLs rendered as either `<img>` elements or CSS backgrounds in profile popouts.
- Restricts profile-avatar lookup to the opened user profile/popout before considering page-wide images, avoiding accidental selection of the logged-in user's own avatar.
- When Discord exposes a user ID but no custom avatar visual, derives that user's built-in default avatar using Discord's current user-ID based default-avatar rule.
- Keeps avatar caching scoped to the resolved author identity so default avatars are not shared between users.

## v0.5.4 sticker + emoji fix

- Prevents one Discord sticker from being exported both as ordinary image media and as a sticker.
- Treats the visible-tab sticker screenshot as a fallback only when Discord has not already exposed a usable sticker image.
- Collapses ID-based and renderer-slot representations for one-sticker messages.
- Detects custom/standard rendered emoji by their Discord emoji DOM markers as well as `/emojis/<id>` CDN URLs.
- Supports Discord-proxied emoji images and Discord static emoji assets, preserving them inline in HTML/MHTML and in the media archive.

# Local Discord History Exporter

A clean-room Manifest V3 browser extension that exports the currently open Discord web conversation by scrolling through the message UI and capturing messages as Discord renders them.

## What it does

- Works on `https://discord.com/channels/...`
- Starts at the newest messages, then scrolls upward through history
- Captures messages incrementally so Discord's virtualized list can discard old DOM nodes without losing already-seen messages
- Deduplicates by Discord message ID
- Exports **MHTML, or ZIP-packaged HTML, JSON, or CSV**
- Captures UTC/ISO timestamps, browser-local display timestamps, author names, profile pictures, text content, custom emoji assets, stickers, reaction emoji assets, reply context, attachment URLs, embed links, image references, and visible reaction text where available
- Optionally captures accessible Discord thread reply histories and nests them under their originating messages
- Recovers missing profile pictures in Compact mode by opening the visible author profile popout as a fallback, caching the avatar, and closing the popout again
- Reconstructs message groups from consecutive authors/time gaps so HTML/MHTML grouping does not depend on Cozy vs. Compact appearance
- Includes a **Stop & export** control that stops further history scrolling and immediately prepares a download from everything captured so far
- Packs Discord-hosted chat media into the HTML/JSON/CSV ZIP archive, including custom emojis, stickers, reaction emoji assets, profile pictures, and conversation images
- **MHTML mode embeds fetched chat media into one `.mhtml` archive** for a single-file offline transcript
- Does **not** read or store your Discord authentication token
- Does **not** call private Discord API endpoints

## Media behavior

When **Save chat media and profile pictures** is enabled:

- **HTML**: downloads one ZIP containing the `.html` transcript plus a sibling `<export-name>-media/` folder inside the archive; inline transcript images, custom emojis, stickers, reaction emoji assets, and avatars point at those local files.
- **JSON / CSV**: downloads one ZIP containing the structured transcript plus the same media folder inside the archive.
- **MHTML**: fetches Discord-hosted chat media and embeds it as MIME resources inside the `.mhtml` file. No separate media folder is created.

Server icons and role icons are still ignored. Avatars are saved separately as profile media. Custom Discord emojis are kept inline in message text, reaction emoji assets are retained, and stickers are rendered as standalone message media. Native Unicode emoji stay as text because they do not need a separate file.

If a Discord-hosted media URL has expired or cannot be fetched, the transcript keeps the original URL and reports the failed media count when the export finishes.

## Install in Opera / Opera GX

1. Extract this folder.
2. Open `opera://extensions` (or the Extensions page from the Opera menu).
3. Enable **Developer mode**.
4. Click **Load unpacked** and choose this folder.
5. Make sure Opera's sidebar is visible, then open **Sidebar setup / Manage sidebar** and enable the Discord History Exporter entry under extensions.
6. Open Discord in the main browser area and enter the channel/DM you want to archive.
7. Click the exporter icon in Opera's sidebar. The panel can stay open while the Discord tab scrolls through history.
8. The normal toolbar extension button remains available too.

## Install in Chrome / Edge / Brave

1. Extract this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Choose this folder.
6. Open Discord in the browser and enter the channel/DM you want to archive.
7. Click the extension and choose HTML, MHTML, JSON, or CSV.
8. Leave **Save chat media and profile pictures** checked if you want offline media.
9. Click **Export current chat** and keep that Discord tab open while it scans.
10. If you have enough history before the automatic scan finishes, reopen the extension and click **Stop & export**. It will stop pulling older messages and export everything captured so far.

## MHTML notes

MHTML is a multipart web archive format. This extension writes the transcript HTML as the root part and each successfully fetched media asset as a base64 MIME part whose `Content-Location` matches the Discord media URL used by the transcript.

Very media-heavy histories can produce large MHTML or ZIP files because the browser assembles the archive in memory. If a huge channel causes memory pressure, stop earlier or export a smaller history range.

## Permissions

- `activeTab`: communicates with the currently open Discord tab.
- `downloads`: saves media files with predictable names under the export's media folder.
- Discord CDN host permissions: fetches/embeds avatars, custom emojis, stickers, reaction emoji assets, and conversation images and downloads them locally.

## Important limitations

Discord's web UI is not a stable public API. Class names and DOM structure can change, so selectors may occasionally need updating.

In Compact mode Discord may omit avatar elements from the message DOM. This version falls back to the normal profile popout for visible authors. That makes avatar capture independent of the chosen chat layout in normal operation, but a future Discord profile-popout redesign could require selector updates.

For very large channels, UI-based history loading can take a long time and Discord may not expose every old message to the browser at once. This extension deliberately relies on the visible web UI rather than extracting a user token or automating undocumented authenticated endpoints.

MHTML support is aimed primarily at Chromium browsers such as Chrome, Edge, and Brave. Other browsers may not open `.mhtml` files the same way.

## Files

- `manifest.json` — Manifest V3 extension definition
- `popup.html` / `popup.js` — normal Chromium toolbar-popup controls
- `sidebar.html` — responsive Opera / Opera GX sidebar panel (shares `popup.js`)
- `content.js` — Discord UI scanner and exporters
- `background.js` — Discord-media fetch/download helper



## v0.5.0 changes

- **Stop & export** turns red while an export is running so the emergency/early-finish action is visually obvious.
- Added custom Discord emoji capture from message content. HTML/MHTML recreates those emoji inline instead of reducing them to missing-image placeholders.
- Added Discord sticker capture and offline media embedding/downloading. Image/GIF/WebP stickers render in the transcript; non-image sticker resources are retained as offline-linked media where available.
- Added custom reaction emoji asset capture.
- Added `emojis`, `stickers`, `reactionEmojis`, `contentParts`, and `localTimestamp` fields to structured exports.
- The timestamp beside each username is now formatted in the browser's local time zone. The original Discord ISO timestamp and message ID remain on the metadata line beneath it.
- MHTML remains the default export format.


## v0.4.0 changes

- Added Compact-mode avatar recovery. When a message does not render an avatar, the exporter briefly opens that visible author's Discord profile popout, captures the Discord-hosted avatar URL, caches it, and closes the popout.
- Added author identity caching when Discord exposes a user/author ID in DOM attributes, with display-name fallback when it does not.
- Recomputes consecutive message groups from author changes and time gaps so exported avatar grouping is consistent across Cozy and Compact layouts.
- Added **Stop & export**. It ends the backward history scan after the current step and proceeds with MHTML/HTML/JSON/CSV generation using the messages already captured.
- The popup now restores running state when reopened, so **Stop & export** still works after the extension popup has been closed during a long scan.
- MHTML remains the default export format.

### v0.5.4
- De-duplicates stickers across both the normal image collector and sticker collector.
- Uses viewport crops only when no usable rendered sticker image is already present.
- Improves custom/standard emoji capture for proxied CDN URLs, emoji wrapper elements, and Discord static assets.

### v0.5.3
- De-duplicates multiple capture representations of the same Discord sticker by sticker ID.
- Prefers the real Discord/rendered sticker image over the viewport screenshot fallback when both are available.

### v0.5.2
- Added renderer-independent sticker detection for IMG, Canvas, and SVG.
- Added a visible-tab crop fallback that stores the pixels Discord actually painted when a Lottie/SVG representation cannot be exported faithfully.
- Fixed sticker-ID regex boundaries from the previous build.
- Viewport sticker snapshots replace weaker rendered-SVG guesses to avoid broken tiny icons in the final archive.


## v0.5.9 avatar fix

When Discord Compact mode does not expose a usable URL or user ID for a default profile picture, the exporter now opens the verified author profile and captures only that profile's rendered avatar element. This prevents a missing default avatar from becoming blank while still avoiding cross-user avatar reuse.


## Vencord MessageLogger deleted messages

If Vencord MessageLogger is displaying a deleted message in the chat, the exporter detects Vencord's `messagelogger-deleted` marker. HTML/MHTML exports show a red `DELETED` badge and highlight; JSON/CSV include `deleted` and `deletedSource` fields. Detection is based on the retained message currently being present in the rendered Discord chat.


## v0.6.5 advanced archive options

The popup and Opera sidebar now have **Main** and **Advanced** tabs. Main contains the normal export format, image/media option, previous-export comparison, start/stop controls, and status. Advanced contains the load delay, idle-pass limit, and two opt-in archive options:

- **Embed/save video attachments** (off by default)
- **Embed/save other uploaded attachment files** such as MHTML, PDF, text files, archives, audio, and other non-image/non-video Discord uploads (off by default)

For MHTML these selected attachment types are added as MIME parts inside the single `.mhtml` archive. For HTML/JSON/CSV they are stored in the ZIP media folder. HTML rewrites links to the archived files and renders archived video attachments with native video controls. Large videos/files can make exports very large.
