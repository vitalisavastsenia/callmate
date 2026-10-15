import { useEffect, useRef } from 'react';
import type { ApprovalRequest } from './types';

export function useApprovalAttention(approval: ApprovalRequest | null | undefined, onOpen: () => void) {
  const audio = useRef<AudioContext | null>(null);
  const asked = useRef(false);
  const open = useRef(onOpen); open.current = onOpen;
  const notified = useRef(new Set<string>());
  function prepare() {
    if (!asked.current) {
      asked.current = true;
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission().catch(() => {});
    }
    try { audio.current ??= new AudioContext(); void audio.current.resume().catch(() => {}); } catch { /* Sound is optional. */ }
  }
  useEffect(() => {
    if (!approval) return;
    const originalTitle = document.title;
    let timer: ReturnType<typeof setInterval> | undefined;
    let notification: Notification | undefined;
    const cleanup = () => { clearInterval(timer); timer = undefined; document.title = originalTitle; notification?.close(); notification = undefined; };
    const attention = () => {
      cleanup();
      if (!document.hidden) return;
      document.title = '⚡ Zeus needs you';
      let flash = true;
      timer = setInterval(() => { flash = !flash; document.title = flash ? '⚡ Zeus needs you' : originalTitle; }, 1000);
      if (notified.current.has(approval.id)) return;
      notified.current.add(approval.id);
      try {
        const context = audio.current;
        if (context?.state === 'running') {
          const oscillator = context.createOscillator(); const gain = context.createGain();
          oscillator.connect(gain); gain.connect(context.destination); oscillator.frequency.value = 660;
          gain.gain.setValueAtTime(0.08, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.25);
          oscillator.start(); oscillator.stop(context.currentTime + 0.25);
        }
      } catch { /* Keep approval controls usable if audio fails. */ }
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          notification = new Notification('⚡ Zeus needs you', { body: 'Approve or reject the exact alternative before the countdown ends.', tag: approval.id });
          notification.onclick = () => { window.focus(); open.current(); cleanup(); };
        } catch { /* Notifications are optional. */ }
      }
    };
    attention(); document.addEventListener('visibilitychange', attention);
    return () => { document.removeEventListener('visibilitychange', attention); cleanup(); };
  }, [approval?.id]);
  useEffect(() => () => { void audio.current?.close().catch(() => {}); }, []);
  return prepare;
}
