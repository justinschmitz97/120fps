import { createElement, forwardRef, type Ref, type ReactNode } from "react";

const Player = forwardRef(function Player(
  props: Record<string, unknown> & { children?: ReactNode },
  ref: Ref<HTMLVideoElement>,
) {
  const { children, ...rest } = props;
  return createElement("video", { controls: true, ...rest, ref }, children);
});

export default Player;
