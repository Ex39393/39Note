import { useEffect, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

export function useElementSize(element: HTMLElement | null): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return size;
}
