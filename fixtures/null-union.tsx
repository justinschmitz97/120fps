import React from "react";

interface AvatarProps {
  src: string | null;
  alt: string;
  size?: number;
}

export function Avatar({ src, alt, size = 40 }: AvatarProps) {
  if (!src) return <div className="avatar-placeholder" style={{ width: size, height: size }}>{alt[0]}</div>;
  return <img src={src} alt={alt} width={size} height={size} />;
}
