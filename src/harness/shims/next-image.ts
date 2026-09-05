import { createElement, forwardRef, type Ref } from "react";

function stripImageProps(props: Record<string, unknown>): Record<string, unknown> {
  const {
    fill, priority, loader, quality, placeholder, blurDataURL, sizes,
    overrideSrc, unoptimized, ...rest
  } = props;
  const style: Record<string, unknown> = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...(rest.style as Record<string, unknown> ?? {}) }
    : (rest.style as Record<string, unknown> ?? {});
  return {
    ...rest,
    style: Object.keys(style).length > 0 ? style : undefined,
    loading: priority ? "eager" : "lazy",
  };
}

const Image = forwardRef(function Image(
  props: Record<string, unknown>,
  ref: Ref<HTMLImageElement>,
) {
  return createElement("img", { ...stripImageProps(props), ref });
});

export default Image;

// next/image 14.1+ exports this so a caller can apply the props to its own element.
export function getImageProps(
  props: Record<string, unknown>,
): { props: Record<string, unknown> } {
  return { props: stripImageProps(props) };
}
