import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";

export function Copy({ text, label, mono = true }: { text: string; label?: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`copy ${mono ? "mono" : ""}`}
      title="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      <span>{label ?? text}</span>
      <span className="copy-icon" aria-hidden>
        {done ? "✓" : "⧉"}
      </span>
    </button>
  );
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="ext">
      {children} <span aria-hidden>↗</span>
    </a>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "btc" | "near" | "ok" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Qr({ value, size = 168 }: { value: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: size * 2, color: { dark: "#0b0d12", light: "#ffffff" } }).then(setSrc, () => setSrc(""));
  }, [value, size]);
  return src ? <img className="qr" src={src} width={size} height={size} alt={`QR code for ${value}`} /> : null;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

export function timeAgo(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
