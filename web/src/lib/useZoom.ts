import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';

export interface ZoomApi {
  t: ZoomTransform;
  zoomBy: (k: number) => void;
  reset: () => void;
  /** Fit a box [[x0,y0],[x1,y1]] in map units. */
  fitBounds: (b: [[number, number], [number, number]], maxK?: number, padding?: number) => void;
}

export function useSvgZoom(
  ref: RefObject<SVGSVGElement | null>,
  { width, height, maxK = 60, wheel = true }: { width: number; height: number; maxK?: number; wheel?: boolean },
): ZoomApi {
  const [t, setT] = useState<ZoomTransform>(zoomIdentity);
  const zRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    let pending: ZoomTransform | null = null;
    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, maxK])
      .translateExtent([
        [-width * 0.15, -height * 0.15],
        [width * 1.15, height * 1.15],
      ])
      .clickDistance(6)
      .filter((e: Event & { button?: number; ctrlKey?: boolean }) => {
        if (e.type === 'wheel' && !wheel) return false;
        return (!e.ctrlKey || e.type === 'wheel') && !e.button;
      })
      .on('zoom', (e: { transform: ZoomTransform }) => {
        pending = e.transform;
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (pending) setT(pending);
          });
      });
    zRef.current = z;
    select(el).call(z);
    return () => {
      cancelAnimationFrame(frame);
      select(el).on('.zoom', null);
    };
  }, [ref, width, height, maxK, wheel]);

  const zoomBy = useCallback(
    (k: number) => {
      if (ref.current && zRef.current) select(ref.current).transition().duration(300).call(zRef.current.scaleBy, k);
    },
    [ref],
  );
  const reset = useCallback(() => {
    if (ref.current && zRef.current) select(ref.current).transition().duration(600).call(zRef.current.transform, zoomIdentity);
  }, [ref]);
  const fitBounds = useCallback(
    (b: [[number, number], [number, number]], fitMax = 12, padding = 0.75) => {
      if (!ref.current || !zRef.current) return;
      const [[x0, y0], [x1, y1]] = b;
      const k = Math.max(1, Math.min(fitMax, padding / Math.max((x1 - x0) / width, (y1 - y0) / height)));
      const tx = width / 2 - (k * (x0 + x1)) / 2;
      const ty = height / 2 - (k * (y0 + y1)) / 2;
      select(ref.current).transition().duration(750).call(zRef.current.transform, zoomIdentity.translate(tx, ty).scale(k));
    },
    [ref, width, height],
  );
  return { t, zoomBy, reset, fitBounds };
}
