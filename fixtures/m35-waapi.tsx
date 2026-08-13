import React from "react";

// Web Animations API animation started in a passive effect: detection runs
// after the mount fence, so the animation must already be registered by the
// time detectAnimations() walks document.getAnimations().
export function WaapiBox() {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const anim = ref.current?.animate([{ opacity: 0.3 }, { opacity: 1 }], {
      duration: 1000,
      iterations: Infinity,
    });
    return () => anim?.cancel();
  }, []);
  return (
    <div ref={ref} style={{ width: 24, height: 24, background: "tomato" }}>
      waapi
    </div>
  );
}
