const STORAGE_ID_KEY = "activeChecklistTemplateId";
const STORAGE_NAME_KEY = "activeChecklistTemplateName";

export type ActiveChecklist = { id: string; name: string };

export function getActiveChecklist(): ActiveChecklist | null {
  if (typeof window === "undefined") return null;
  const id = window.localStorage.getItem(STORAGE_ID_KEY);
  const name = window.localStorage.getItem(STORAGE_NAME_KEY);
  if (!id || !name) return null;
  return { id, name };
}

export function setActiveChecklist(checklist: ActiveChecklist) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_ID_KEY, checklist.id);
  window.localStorage.setItem(STORAGE_NAME_KEY, checklist.name);
}

export function clearActiveChecklist() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_ID_KEY);
  window.localStorage.removeItem(STORAGE_NAME_KEY);
}
