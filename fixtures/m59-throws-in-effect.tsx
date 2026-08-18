import React from "react";

// Renders successfully, then throws from an effect after paint. The DOM is
// real, so the gate must not fire; the error still has to reach the report.
export function ThrowsInEffect() {
  React.useEffect(() => {
    throw new Error("ThrowsInEffect: effect blew up after paint");
  }, []);
  return <div className="rendered">content</div>;
}

export default ThrowsInEffect;
