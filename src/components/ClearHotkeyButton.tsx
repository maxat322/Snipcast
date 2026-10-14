export function ClearHotkeyButton({ label, disabled, onClick }: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const description = `Очистить горячую клавишу: ${label}`;
  return (
    <button type="button" className="settings__ghost settings__hotkey-clear"
      aria-label={description} title={description} disabled={disabled} onClick={onClick}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 6 12 12M18 6 6 18" />
      </svg>
    </button>
  );
}
