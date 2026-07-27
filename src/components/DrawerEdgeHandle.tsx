interface DrawerEdgeHandleProps {
  side: 'left' | 'right';
  isOpen: boolean;
  onToggle: () => void;
  accessibleLabel: string;
}

export function DrawerEdgeHandle({
  side,
  isOpen,
  onToggle,
  accessibleLabel,
}: DrawerEdgeHandleProps) {
  const arrow = side === 'left'
    ? isOpen ? '‹' : '›'
    : isOpen ? '›' : '‹';

  return (
    <button
      aria-expanded={isOpen}
      aria-label={accessibleLabel}
      className={`drawer-edge-handle is-${side}`}
      title={accessibleLabel}
      type="button"
      onClick={onToggle}
    >
      <span aria-hidden="true">{arrow}</span>
    </button>
  );
}
