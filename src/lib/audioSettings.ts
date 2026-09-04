const VALVE_AUDIO_KEY = "audio.valveAction.enabled";
const STEP_AUDIO_KEY = "audio.stepComplete.enabled";

function getFlag(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return defaultValue;
  return raw === "true";
}

function setFlag(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, String(value));
}

export function isValveActionAudioEnabled(): boolean {
  return getFlag(VALVE_AUDIO_KEY, true);
}
export function setValveActionAudioEnabled(value: boolean) {
  setFlag(VALVE_AUDIO_KEY, value);
}

export function isStepCompleteAudioEnabled(): boolean {
  return getFlag(STEP_AUDIO_KEY, true);
}
export function setStepCompleteAudioEnabled(value: boolean) {
  setFlag(STEP_AUDIO_KEY, value);
}

export function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  window.speechSynthesis.speak(utterance);
}
