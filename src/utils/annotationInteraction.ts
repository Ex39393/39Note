export const ANNOTATION_TAP_MOVEMENT_THRESHOLD = 6;

export interface AnnotationPointerStart {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export function isSimpleAnnotationTap(
  start: AnnotationPointerStart | null,
  end: { pointerId: number; clientX: number; clientY: number },
  hasMeaningfulSelection: boolean,
): boolean {
  if (!start || start.pointerId !== end.pointerId || hasMeaningfulSelection) {
    return false;
  }
  return Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY)
    <= ANNOTATION_TAP_MOVEMENT_THRESHOLD;
}

export function isAnnotationTapInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest([
    'a',
    'button',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '.definition-bubble',
    '.pdf-search-bar',
    '.selection-action',
  ].join(',')));
}
