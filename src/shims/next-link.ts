import { createElement, forwardRef, type Ref } from "react";

const Link = forwardRef(function Link(
  props: Record<string, unknown>,
  ref: Ref<HTMLAnchorElement>,
) {
  const { prefetch, replace, scroll, shallow, locale, passHref, legacyBehavior, ...rest } = props;
  return createElement("a", { ...rest, ref });
});

export default Link;
