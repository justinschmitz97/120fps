import React from "react";

interface MarkerProps {
  spot: { x: number; y: number };
  isActive: boolean;
  isVisited: boolean;
}

// Exported helper declared before the component the file is named after.
export function Marker({ spot, isActive, isVisited }: MarkerProps) {
  return <b data-active={isActive} data-visited={isVisited}>{spot.x + spot.y}</b>;
}

interface HotspotImageProps {
  src: string;
  hotspots: { x: number; y: number }[];
  zoom?: number;
}

export function HotspotImage({ src, hotspots, zoom = 1 }: HotspotImageProps) {
  return (
    <figure style={{ zoom }}>
      <img src={src} alt="" />
      {hotspots.map((spot) => (
        <Marker key={`${spot.x}-${spot.y}`} spot={spot} isActive={false} isVisited={false} />
      ))}
    </figure>
  );
}
