/**
 * Chat: pi's transcript drawn closer to Claude Code's. Tool calls as `● Read(file)` rows with
 * `⎿  Read 3 lines` under them, highlighted diffs for edits, `>` before your messages and `●` before
 * the model's replies, and an orange status line while pi works.
 *
 * Based on pi-polish by Thomas van Dongen (MIT; see THIRD_PARTY_NOTICES.md).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chatChrome from "./chrome.ts";
import chatTools from "./tools.ts";

export default function chatExtension(pi: ExtensionAPI) {
	chatTools(pi);
	chatChrome(pi);
}
