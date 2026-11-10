interface DrawerEdgeHandleProps {
  side: 'left' | 'right';
  isOpen: boolean;
  onToggle: () => void;
  accessibleLabel: string;
  disabled?: boolean;
}

export function DrawerEdgeHandle({
  side,
  isOpen,
  onToggle,
  accessibleLabel,
  disabled = false,
}: DrawerEdgeHandleProps) {
  const arrow = side === 'left' ? (isOpen ? '‹' : '›') : isOpen ? '›' : '‹';

  return (
    <button
      aria-expanded={isOpen}
      aria-hidden={disabled ? true : undefined}
      aria-label={accessibleLabel}
      className={`drawer-edge-handle is-${side}`}
      disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      title={accessibleLabel}
      type="button"
      onClick={onToggle}
    >
      <span aria-hidden="true">{arrow}</span>
    </button>
  );
}
