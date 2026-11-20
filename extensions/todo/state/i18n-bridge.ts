/**
 * The todo extension's user-facing words. rpiv-todo translates them through rpiv-i18n; this copy is
 * English-only, so `t` returns the English text each call site passes.
 */

import type { TaskStatus } from "../tool/types.ts";

type ScopeFn = (key: string, fallback: string) => string;

export const t: ScopeFn = (_key, fallback) => fallback;

const STATUS_LABEL_PENDING = "pending";
const STATUS_LABEL_IN_PROGRESS = "in progress";
const STATUS_LABEL_COMPLETED = "completed";
const STATUS_LABEL_DELETED = "deleted";

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return t("status.pending", STATUS_LABEL_PENDING);
		case "in_progress":
			return t("status.in_progress", STATUS_LABEL_IN_PROGRESS);
		case "completed":
			return t("status.completed", STATUS_LABEL_COMPLETED);
		case "deleted":
			return t("status.deleted", STATUS_LABEL_DELETED);
	}
}
