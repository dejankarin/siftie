interface ToastProps {
  text: string;
}

export function Toast({ text }: ToastProps) {
  if (!text) return null;
  return (
    <div className="toast fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-40 px-3.5 py-2 rounded-full bg-[var(--ink)] text-white text-[12.5px] shadow-[0_12px_32px_-12px_rgba(20,15,25,0.4)]">
      {text}
    </div>
  );
}
