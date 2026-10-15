import type { Transcript } from "../shared/types.js";

type Recognition = { lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>; resultIndex: number }) => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void };
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance };
type Hooks = { transcript: (text: string) => void; status: (message: string, code?: string) => void };

/** Browser capabilities are optional; typed input never depends on this class. */
export class SpeechController {
  private recognition: Recognition | null = null;
  private listening = false;
  private wantsMic = false;
  private queue: Transcript[] = [];
  private current: { entry: Transcript; started: number; boundary: number; epoch: number } | null = null;
  private epoch = 0;
  enabled = false;
  volume = 0.8;
  voiceURI = "";
  language = "pl-PL";
  constructor(private win: SpeechWindow, private hooks: Hooks) {}
  get recognitionAvailable() { return Boolean(this.win.SpeechRecognition ?? this.win.webkitSpeechRecognition); }
  get synthesisAvailable() { return Boolean(this.win.speechSynthesis && this.win.SpeechSynthesisUtterance); }
  voices() { return this.win.speechSynthesis?.getVoices() ?? []; }
  startMic() {
    this.wantsMic = true;
    if (this.current) { this.hooks.status("Microphone paused while AI speech is playing."); return; }
    const Constructor = this.win.SpeechRecognition ?? this.win.webkitSpeechRecognition;
    if (!Constructor) { this.wantsMic = false; this.hooks.status("Speech recognition is unavailable. Type a caller utterance instead.", "BROWSER_STT_UNAVAILABLE"); return; }
    if (this.listening) return;
    try {
      const recognition = new Constructor(); this.recognition = recognition;
      recognition.lang = this.language; recognition.continuous = true; recognition.interimResults = false;
      recognition.onresult = (event) => {
        if (this.recognition !== recognition || !this.wantsMic || this.current) return;
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index]; if (result?.isFinal && result[0].transcript.trim()) this.hooks.transcript(result[0].transcript);
        }
      };
      recognition.onerror = (event) => {
        if (this.recognition !== recognition) return;
        this.listening = false; this.wantsMic = false;
        this.hooks.status(`Microphone recognition stopped (${event.error}). Typed input still works.`, "BROWSER_STT_ERROR");
      };
      recognition.onend = () => {
        if (this.recognition !== recognition) return;
        this.listening = false;
        // Do not restart after permission errors or loop endlessly on vendor onend events.
        this.hooks.status(this.current ? "Microphone paused during AI playback." : "Microphone stopped. Start it again or use typed input.");
      };
      recognition.start(); this.listening = true;
      this.hooks.status("Listening… Final recognized speech will be sent as a caller turn.");
    } catch { this.listening = false; this.wantsMic = false; this.hooks.status("Cannot start microphone recognition. Use typed input.", "BROWSER_STT_ERROR"); }
  }
  stopMic() {
    this.wantsMic = false; this.listening = false;
    try { this.recognition?.abort(); } catch { /* Browser may already have ended recognition. */ }
    this.recognition = null;
  }
  private pauseMic() {
    this.listening = false;
    try { this.recognition?.abort(); } catch { /* Best effort. */ }
    this.recognition = null;
  }
  speak(entry: Transcript) {
    if (!this.enabled || !entry.final || entry.speaker === "operator" || !entry.text) return;
    if (!this.synthesisAvailable || !this.voices().length) {
      this.hooks.status("Browser audio is unavailable; all AI text remains visible.", "BROWSER_TTS_UNAVAILABLE"); return;
    }
    if (this.current?.entry.preemptible) this.cancelPlayback();
    this.queue.push(entry); this.playNext();
  }
  private playNext() {
    if (this.current || !this.enabled) return;
    const entry = this.queue.shift();
    if (!entry) { if (this.wantsMic) this.startMic(); return; }
    this.pauseMic();
    const Utterance = this.win.SpeechSynthesisUtterance!;
    const utterance = new Utterance(entry.text);
    utterance.lang = entry.lang || this.language; utterance.volume = this.volume;
    const voice = this.voices().find((item) => item.voiceURI === this.voiceURI); if (voice) utterance.voice = voice;
    const epoch = ++this.epoch;
    const playback = { entry, started: this.win.performance.now(), boundary: 0, epoch };
    this.current = playback;
    utterance.onstart = () => { playback.started = this.win.performance.now(); };
    utterance.onboundary = (event) => { playback.boundary = event.charIndex; };
    utterance.onend = () => { if (this.current?.epoch === epoch) { this.current = null; this.playNext(); } };
    utterance.onerror = () => {
      if (this.current?.epoch !== epoch) return;
      this.current = null; this.queue = [];
      this.hooks.status("Browser speech synthesis failed. Read the visible text instead.", "BROWSER_TTS_ERROR");
    };
    try { this.win.speechSynthesis.speak(utterance); }
    catch { this.current = null; this.queue = []; this.hooks.status("Browser audio is unavailable; text still works.", "BROWSER_TTS_UNAVAILABLE"); }
  }
  interrupt() {
    if (this.current && !this.current.entry.interruptible) { this.hooks.status("This AI utterance is marked non-interruptible."); return null; }
    const playback = this.current;
    const result = { utteranceUntilInterrupt: playback ? playback.entry.text.slice(0, playback.boundary) : "",
      durationUntilInterruptMs: playback ? Math.max(0, Math.round(this.win.performance.now() - playback.started)) : 0 };
    this.cancelPlayback();
    return result;
  }
  cancelPlayback() {
    this.current = null; this.queue = []; this.epoch++;
    try { this.win.speechSynthesis?.cancel(); } catch { /* Capability may disappear mid-session. */ }
  }
  stop() { this.stopMic(); this.cancelPlayback(); }
}
