import { useEffect, useState } from 'react';
import {
  areReaderOcclusionInsetsEqual,
  deriveReaderOcclusionInsets,
  EMPTY_READER_OCCLUSION_INSETS,
  measureReaderEdgeOverlap,
  type ReaderOcclusionEdge,
  type ReaderOcclusionInsets,
} from '../utils/readerOcclusion';

const OCCLUDER_SELECTOR = '[data-reader-occlusion-edge]';

export function useReaderOcclusionInsets(
  readerElement: HTMLElement | null,
  enabled: boolean,
): ReaderOcclusionInsets {
  const [insets, setInsets] = useState<ReaderOcclusionInsets>(
    EMPTY_READER_OCCLUSION_INSETS,
  );

  useEffect(() => {
    if (!readerElement || !enabled) {
      setInsets((current) =>
        areReaderOcclusionInsetsEqual(current, EMPTY_READER_OCCLUSION_INSETS)
          ? current
          : EMPTY_READER_OCCLUSION_INSETS,
      );
      return;
    }

    const readerLayout = readerElement.closest<HTMLElement>('.app-content');
    if (!readerLayout) return;

    const observedOccluders = new Set<HTMLElement>();
    const closingOccluders = new Set<HTMLElement>();
    const closingTimers = new Map<HTMLElement, number>();
    const getOccluders = () =>
      Array.from(readerLayout.querySelectorAll<HTMLElement>(OCCLUDER_SELECTOR));
    const measure = () => {
      const layoutBounds = readerLayout.getBoundingClientRect();
      const readerBounds = readerElement.getBoundingClientRect();
      const nextInsets = deriveReaderOcclusionInsets(
        getOccluders().map((occluder) => {
          const edge = occluder.dataset.readerOcclusionEdge as ReaderOcclusionEdge;
          const occluderBounds = occluder.getBoundingClientRect();
          const overlapsReaderVertically =
            Math.min(readerBounds.bottom, occluderBounds.bottom) >
            Math.max(readerBounds.top, occluderBounds.top);
          const overlapWidth = measureReaderEdgeOverlap(
            edge,
            occluder.offsetWidth,
            layoutBounds,
            readerBounds,
          );
          return {
            edge,
            active:
              (occluder.dataset.readerOcclusionActive === 'true' ||
                closingOccluders.has(occluder)) &&
              overlapsReaderVertically,
            width: overlapWidth,
          };
        }),
      );
      setInsets((current) =>
        areReaderOcclusionInsetsEqual(current, nextInsets) ? current : nextInsets,
      );
    };

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(readerLayout);
    resizeObserver.observe(readerElement);
    const clearClosingOcclusion = (occluder: HTMLElement) => {
      closingOccluders.delete(occluder);
      const timer = closingTimers.get(occluder);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        closingTimers.delete(occluder);
      }
    };
    const retainClosingOcclusion = (occluder: HTMLElement) => {
      clearClosingOcclusion(occluder);
      const transitionTime = getTransformTransitionTime(occluder);
      if (transitionTime <= 0) return;
      closingOccluders.add(occluder);
      closingTimers.set(
        occluder,
        window.setTimeout(() => {
          clearClosingOcclusion(occluder);
          measure();
        }, transitionTime + 50),
      );
    };
    const settleClosingOcclusion = (event: TransitionEvent) => {
      if (
        event.target !== event.currentTarget ||
        (event.type === 'transitionend' && event.propertyName !== 'transform')
      ) {
        return;
      }
      const occluder = event.currentTarget as HTMLElement;
      clearClosingOcclusion(occluder);
      measure();
    };
    const refreshOccluders = () => {
      const nextOccluders = new Set(getOccluders());
      observedOccluders.forEach((occluder) => {
        if (!nextOccluders.has(occluder)) {
          resizeObserver.unobserve(occluder);
          occluder.removeEventListener('transitionend', settleClosingOcclusion);
          occluder.removeEventListener('transitioncancel', settleClosingOcclusion);
          clearClosingOcclusion(occluder);
          observedOccluders.delete(occluder);
        }
      });
      nextOccluders.forEach((occluder) => {
        if (!observedOccluders.has(occluder)) {
          observedOccluders.add(occluder);
          resizeObserver.observe(occluder);
          occluder.addEventListener('transitionend', settleClosingOcclusion);
          occluder.addEventListener('transitioncancel', settleClosingOcclusion);
        }
      });
      measure();
    };

    refreshOccluders();

    const mutationObserver = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.attributeName !== 'data-reader-occlusion-active') return;
        const occluder = record.target as HTMLElement;
        if (occluder.dataset.readerOcclusionActive === 'true') {
          clearClosingOcclusion(occluder);
        } else if (record.oldValue === 'true') {
          retainClosingOcclusion(occluder);
        }
      });
      refreshOccluders();
    });
    mutationObserver.observe(readerLayout, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-reader-occlusion-active', 'data-reader-occlusion-edge'],
      subtree: true,
    });
    const childListObserver = new MutationObserver(refreshOccluders);
    childListObserver.observe(readerLayout, { childList: true });

    return () => {
      childListObserver.disconnect();
      mutationObserver.disconnect();
      observedOccluders.forEach((occluder) => {
        occluder.removeEventListener('transitionend', settleClosingOcclusion);
        occluder.removeEventListener('transitioncancel', settleClosingOcclusion);
        clearClosingOcclusion(occluder);
      });
      resizeObserver.disconnect();
    };
  }, [enabled, readerElement]);

  return insets;
}

function getTransformTransitionTime(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  const properties = splitCssList(style.transitionProperty);
  const durations = splitCssList(style.transitionDuration).map(parseCssTime);
  const delays = splitCssList(style.transitionDelay).map(parseCssTime);
  const itemCount = Math.max(properties.length, durations.length, delays.length);
  let maximum = 0;

  for (let index = 0; index < itemCount; index += 1) {
    const property = properties[index % properties.length];
    if (property !== 'all' && property !== 'transform') continue;
    const duration = durations[index % durations.length] ?? 0;
    const delay = delays[index % delays.length] ?? 0;
    maximum = Math.max(maximum, duration + delay);
  }

  return maximum;
}

function splitCssList(value: string): string[] {
  const values = value.split(',').map((item) => item.trim());
  return values.length > 0 ? values : [''];
}

function parseCssTime(value: string): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  return value.endsWith('ms') ? amount : amount * 1_000;
}
