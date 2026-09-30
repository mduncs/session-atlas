import React from "react";
import { Box, Text } from "ink";

const FRAME_MARKERS = [" ", "\u00a0"] as const;

export function viewportFrameMarker(generation: number): string {
  return FRAME_MARKERS[Math.abs(Math.floor(generation)) % FRAME_MARKERS.length]!;
}

/**
 * Ink's incremental renderer may retain cells when a full-screen layout grows
 * after a narrow excursion. A reserved leading-cell marker on every
 * physical row changes each renderer line after every resize, forcing one complete incremental
 * frame without stealing a terminal column or altering visible content.
 */
export function ViewportInvalidationFrame({ width, height, children, invalidateRows = false }: {
  width: number;
  height: number;
  children: React.ReactNode;
  /** The dashboard deliberately leaves column zero blank on every row. */
  invalidateRows?: boolean;
}): React.JSX.Element {
  const [generation, setGeneration] = React.useState(0);
  const previous = React.useRef<{ width: number; height: number } | null>(null);
  React.useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { width, height };
    if (old && (old.width !== width || old.height !== height)) setGeneration((value) => value + 1);
  }, [height, width]);
  const marker = viewportFrameMarker(generation);
  const rows = Array.from({ length: Math.max(1, Math.floor(height)) }, (_, index) => (
    <Box key={index} height={1} width={1} flexShrink={0}><Text>{marker}</Text></Box>
  ));
  return <Box key={`viewport:${width}x${height}`} width={width} height={height} overflow="hidden" position="relative">
    {children}
    {invalidateRows ? <Box position="absolute" flexDirection="column" width={1} height={height}>{rows}</Box> : null}
  </Box>;
}
