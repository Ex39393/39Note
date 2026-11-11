export type LibraryPresentation = 'overlay' | 'embedded';

export function resolveLibraryScrollContainer(
  content: HTMLElement,
  presentation: LibraryPresentation,
): HTMLElement {
  if (presentation === 'embedded') {
    return content.closest<HTMLElement>('.home-content') ?? content;
  }
  return content;
}

export function scrollLibraryContainerToTop(
  container: Pick<HTMLElement, 'scrollTo'>,
  prefersReducedMotion: boolean,
): void {
  container.scrollTo({
    top: 0,
    left: 0,
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
  });
}
