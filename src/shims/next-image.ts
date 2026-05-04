import { createElement, forwardRef, type Ref } from "react";

const Image = forwardRef(function Image(
  props: Record<string, unknown>,
  ref: Ref<HTMLImageElement>,
) {
  const {
    fill, priority, loader, quality, placeholder, blurDataURL, sizes,
    overrideSrc, unoptimized, ...rest
  } = props;
  const style: Record<string, unknown> = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...(rest.style as Record<string, unknown> ?? {}) }
    : (rest.style as Record<string, unknown> ?? {});
  return createElement("img", {
    ...rest,
    ref,
    style: Object.keys(style).length > 0 ? style : undefined,
    loading: priority ? "eager" : "lazy",
  });
});

export default Image;
