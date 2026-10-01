import { useEffect, useRef, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

export function useElementSize(
  element: HTMLElement | null,
  onBeforeChange?: () => void,
): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const sizeRef = useRef(size);
  const onBeforeChangeRef = useRef(onBeforeChange);

  onBeforeChangeRef.current = onBeforeChange;

  useEffect(() => {
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const nextSize = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      const currentSize = sizeRef.current;
      if (
        currentSize.width === nextSize.width &&
        currentSize.height === nextSize.height
      ) {
        return;
      }
      if (currentSize.width > 0 && currentSize.height > 0) {
        onBeforeChangeRef.current?.();
      }
      sizeRef.current = nextSize;
      setSize(nextSize);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return size;
}
